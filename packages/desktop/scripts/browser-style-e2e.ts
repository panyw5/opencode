import { connectCdp } from "./cdp"
import theme from "../../ui/src/theme/themes/claude.json"
import { resolveThemeVariant, themeToCss } from "../../ui/src/theme/resolve"

const { client, target } = await connectCdp()
const log = (message: string) => console.log(`[browser-style-e2e] ${message}`)
const created: string[] = []
let previousStyle: string | null = null
let previousPage = ""
let previouslyOpened = false
if (!target.url.includes("localhost:5173")) {
  client.close()
  throw new Error("Only the development renderer may be tested")
}
const responses = new Map<string, () => void>()
const requests = new Map<string, number>()
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  fetch: async (request) => {
    const path = new URL(request.url).pathname
    requests.set(path, (requests.get(path) ?? 0) + 1)
    if (path === "/dock" || path === "/floating") {
      log(`fixture request waiting path=${path}`)
      await new Promise<void>((resolve) => responses.set(path, resolve))
    }
    return new Response("<!doctype html><title>Address submit fixture</title><h1>Navigation complete</h1>", {
      headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
    })
  },
})

async function wait(expression: string, label: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

async function screenshot(name: string) {
  const clip = await client.evaluate<{ x: number; y: number; width: number; height: number; scale: number }>(`(() => {
    const rect = document.querySelector('#browser-panel').getBoundingClientRect()
    return {x:rect.x,y:rect.y,width:rect.width,height:Math.min(rect.height,280),scale:2}
  })()`)
  const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png", clip })
  await Bun.write(`/tmp/browser-style-${name}.png`, Buffer.from(shot.data, "base64"))
  log(`screenshot=/tmp/browser-style-${name}.png`)
}

async function assertLoadingMoves(selector: string, mode: string) {
  const positions = await client.evaluate<number[]>(`(async () => {
    const indicator = document.querySelector(${JSON.stringify(selector + " .browser-loading-indicator")})
    const style = getComputedStyle(indicator)
    if (style.animationName!=='browser-loading' || indicator.offsetWidth>=indicator.parentElement.offsetWidth)
      throw Error('Loading indicator must be an animated segment, not a full-width line')
    const positions=[]
    for(let index=0;index<3;index++) {
      positions.push(indicator.getBoundingClientRect().x)
      await new Promise(resolve=>setTimeout(resolve,160))
    }
    return positions
  })()`)
  log(`loading motion mode=${mode} positions=${positions.map((value) => value.toFixed(1)).join(",")}`)
  if (Math.max(...positions) - Math.min(...positions) < 2)
    throw new Error(`Loading indicator is not moving mode=${mode}`)
}

async function submitAddress(floating: boolean, unchanged = false) {
  const selector = floating ? "[data-browser-maximized]" : "#browser-panel"
  const url = `http://127.0.0.1:${fixture.port}/${floating ? "floating" : "dock"}`
  const path = floating ? "/floating" : "/dock"
  const previousRequests = requests.get(path) ?? 0
  log(`address submit start floating=${floating} unchanged=${unchanged} requests=${previousRequests}`)
  // Let the floating dialog's mount-time focus settle before editing its address.
  await client.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector + " input")})
    input.focus()
    if (!${unchanged}) input.select()
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))
    if (document.activeElement!==input) throw Error('IME confirmation must not blur the address')
  })()`)
  log(`PASS IME confirmation retains focus floating=${floating}`)
  if (!unchanged) await client.call("Input.insertText", { text: url })
  const edited = await client.evaluate<string>(`document.querySelector(${JSON.stringify(selector + " input")}).value`)
  log(`address edited floating=${floating} value=${edited}`)
  if (edited !== url) throw new Error("Address text was not entered into the focused input")
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" })
  const immediate = await client.evaluate<boolean>(
    `!!document.querySelector(${JSON.stringify(selector + ' .browser-toolbar[aria-busy="true"] .browser-loading')})`,
  )
  if (!immediate) throw new Error("Loading bar must appear immediately after Enter")
  log(`PASS loading bar appears immediately floating=${floating}`)
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" })
  await wait(
    `(() => {
    const address = document.querySelector(${JSON.stringify(selector + " .browser-address")})
    return !address.contains(document.activeElement) && !address.matches(':focus-within')
  })()`,
    "Enter releases address focus",
  )
  log(`PASS Enter releases address focus floating=${floating}`)
  const deadline = Date.now() + 10_000
  while (!responses.has(path)) {
    if (Date.now() > deadline) throw new Error("Navigation did not reach fixture")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (requests.get(path) !== previousRequests + 1) throw new Error("Enter must make exactly one new page request")
  log(`PASS new page request floating=${floating} unchanged=${unchanged} requests=${requests.get(path)}`)
  await client.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  })
  const geometry = await client.evaluate<{
    height: number
    width: number
    toolbarWidth: number
    bottom: number
    animation: string
    reduced: boolean
  }>(`(() => {
    const bar = document.querySelector(${JSON.stringify(selector + " .browser-loading")})
    const toolbar = bar.closest('.browser-toolbar').getBoundingClientRect()
    const rect = bar.getBoundingClientRect()
    return {height:rect.height,width:rect.width,toolbarWidth:toolbar.width,bottom:rect.bottom-toolbar.bottom,
      animation:getComputedStyle(bar.firstElementChild).animationName,
      reduced:matchMedia('(prefers-reduced-motion: reduce)').matches}
  })()`)
  log(`loading geometry floating=${floating} ${JSON.stringify(geometry)}`)
  if (
    geometry.height !== 2 ||
    geometry.width !== geometry.toolbarWidth ||
    Math.abs(geometry.bottom) >= 2 ||
    geometry.animation !== "browser-loading"
  )
    throw new Error("Loading bar is not visible at the toolbar edge during delayed response")
  await assertLoadingMoves(selector, "normal")
  log(`PASS delayed response keeps animated loading bar visible floating=${floating}`)
  await client.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  await assertLoadingMoves(selector, "reduced")
  await client.call("Emulation.setEmulatedMedia", { features: [] })
  if (!floating) {
    await screenshot("loading")
    await client.evaluate(`document.querySelector('[data-browser-tab="${created[0]}"]').click()`)
    await wait(`!document.querySelector('#browser-panel .browser-loading')`, "inactive page loading is not displayed")
    await client.evaluate(`document.querySelector('[data-browser-tab="${created.at(-1)}"]').click()`)
    await wait(`!!document.querySelector('#browser-panel .browser-loading')`, "loading restored when switching back")
    log("PASS loading indicator follows the active tab")
  }
  responses.get(path)!()
  responses.delete(path)
  await wait(
    `(async () => {
    const page = (await window.api.browser.getState()).find(page => page.partition===${JSON.stringify(created.at(-1))})
    return page?.url===${JSON.stringify(url)} && page.title==='Address submit fixture' && !page.loading
  })()`,
    "submitted address finishes navigation",
  )
  await wait(`!document.querySelector(${JSON.stringify(selector + " .browser-loading")})`, "loading bar cleared")
  log(`PASS submitted address loaded floating=${floating}`)
}

try {
  await wait(`!!document.querySelector('#browser-panel')`, "browser panel mounted")
  previousStyle = await client.evaluate(`document.querySelector('#browser-panel').getAttribute('style')`)
  previousPage = await client.evaluate(
    `document.querySelector('[data-browser-placeholder]').dataset.browserPlaceholder`,
  )
  previouslyOpened = await client.evaluate(
    `document.querySelector('#browser-panel').getAttribute('aria-hidden')==='false'`,
  )
  if (!previouslyOpened)
    await client.evaluate(`document.querySelector('button[aria-controls="browser-panel"]').click()`)
  await wait(`document.querySelector('#browser-panel').getBoundingClientRect().width > 300`, "browser panel opened")
  log(`setup previousPage=${previousPage || "none"} opened=${previouslyOpened}`)
  for (let index = 0; index < 5; index++) {
    await client.evaluate(`document.querySelector('.browser-new-tab').click()`)
    const pageID = await client.evaluate<string>(
      `document.querySelector('[data-browser-placeholder]').dataset.browserPlaceholder`,
    )
    created.push(pageID)
    await wait(
      `(async () => {
      const page = (await window.api.browser.getState()).find(page => page.partition === ${JSON.stringify(pageID)})
      return page?.epoch > 0 && !page.loading
    })()`,
      "blank tab initialized",
    )
  }
  await wait(`document.querySelectorAll('.browser-tab').length >= 5`, "multiple tabs rendered")
  if (await client.evaluate<boolean>(`!!document.querySelector('.browser-loading')`))
    throw new Error("Blank tabs must not display a loading bar")

  for (const mode of ["light", "dark"] as const) {
    const tokens = themeToCss(resolveThemeVariant(theme[mode], mode === "dark"))
    for (const width of [538, 320]) {
      await client.evaluate(`document.querySelector('#browser-panel').style.cssText =
        ${JSON.stringify(`width:${width}px;max-width:100%;color-scheme:${mode};${tokens}`)}`)
      const result = await client.evaluate<{
        valid: boolean
        overflow: boolean
        inputWidth: number
        buttonWidth: number
      }>(`(() => {
        const panel = document.querySelector('#browser-panel')
        const toolbar = panel.querySelector('.browser-toolbar')
        const address = panel.querySelector('.browser-address')
        const input = address.querySelector('input')
        const tabs = panel.querySelector('.browser-tabs')
        const button = toolbar.querySelector('button')
        const panelRect = panel.getBoundingClientRect()
        const controls = [...toolbar.children,...panel.querySelector('.browser-tab-strip').children]
        const inside = controls.every(element => {
          const rect = element.getBoundingClientRect()
          return rect.left >= panelRect.left && rect.right <= panelRect.right+1
        })
        return {
          valid:inside && toolbar.getBoundingClientRect().height===54
            && address.getBoundingClientRect().height===34
            && getComputedStyle(address).borderRadius==='999px'
            && getComputedStyle(panel).borderTopLeftRadius==='0px'
            && getComputedStyle(panel).borderBottomLeftRadius==='0px'
            && input.getBoundingClientRect().width >= 80,
          overflow:tabs.scrollWidth>tabs.clientWidth,
          inputWidth:input.getBoundingClientRect().width,
          buttonWidth:button.getBoundingClientRect().width,
        }
      })()`)
      if (!result.valid || !result.overflow || result.buttonWidth !== (width <= 420 ? 28 : 30))
        throw new Error(`Invalid chrome geometry mode=${mode} width=${width} result=${JSON.stringify(result)}`)
      log(
        `PASS mode=${mode} width=${width} input=${result.inputWidth}px button=${result.buttonWidth}px tab overflow contained`,
      )
      await client.evaluate(`(() => {
        const panel = document.querySelector('#browser-panel')
        const tab = [...panel.querySelectorAll('.browser-tab')].at(-1)
        tab.scrollIntoView({block:'nearest',inline:'nearest'})
        tab.click()
      })()`)
      await wait(
        `(async () => {
        const views = (await window.api.browser.getDisplayState()).views
        return views.some(view => view.visible && view.partition === ${JSON.stringify(created.at(-1))})
      })()`,
        "selected native page displayed",
      )
      const point = await client.evaluate<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector('#browser-panel input').getBoundingClientRect()
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
      })()`)
      await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
      await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
      await wait(
        `(() => {
        const address = document.querySelector('#browser-panel .browser-address')
        return address.contains(document.activeElement) && getComputedStyle(address).boxShadow !== 'none'
      })()`,
        "address focus indicator",
      )
      await screenshot(`${mode}-${width}`)
    }
  }

  await submitAddress(false)
  await submitAddress(false, true)
  await client.evaluate(`document.querySelector('[data-action="browser-maximize"]').click()`)
  await wait(`!!document.querySelector('[data-browser-maximized]')`, "floating browser opened")
  await submitAddress(true)
  await submitAddress(true, true)
  await client.evaluate(`document.querySelector('[data-action="browser-restore"]').click()`)
  await wait(`!document.querySelector('[data-browser-maximized]')`, "browser restored")

  await client.evaluate(`(() => {
    const input = document.querySelector('#browser-panel input')
    input.focus()
    input.value='file:///tmp/opencode-missing-loading-fixture-'+crypto.randomUUID()+'.html'
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
  })()`)
  await wait(
    `(async () => {
    const page = (await window.api.browser.getState()).find(page => page.partition===${JSON.stringify(created.at(-1))})
    return !page?.loading && !document.querySelector('#browser-panel .browser-loading')
  })()`,
    "failed navigation clears loading",
  )
  log("PASS failed navigation clears loading bar")

  const before = await client.evaluate<number>(`document.querySelectorAll('.browser-tab').length`)
  await client.evaluate(
    `document.querySelector('.browser-tab[aria-pressed="true"] [data-action="browser-tab-close"]').click()`,
  )
  await wait(`document.querySelectorAll('.browser-tab').length===${before - 1}`, "tab close after restyling")
  log("PASS tab selection, address focus and tab close")
} finally {
  for (const resolve of responses.values()) resolve()
  await client.call("Emulation.setEmulatedMedia", { features: [] }).catch(() => {})
  await client.evaluate(`document.querySelector('[data-action="browser-restore"]')?.click()`).catch(() => {})
  for (const pageID of created) {
    await client.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
  }
  await client.evaluate(`(() => {
    const panel = document.querySelector('#browser-panel')
    if (!panel) return
    ${previousStyle === null ? "panel.removeAttribute('style')" : `panel.setAttribute('style',${JSON.stringify(previousStyle)})`}
    const tab = [...panel.querySelectorAll('.browser-tab')].find(tab =>
      tab.dataset.browserTab === ${JSON.stringify(previousPage)})
    tab?.click()
    if (!${previouslyOpened} && panel.getAttribute('aria-hidden')==='false')
      document.querySelector('button[aria-controls="browser-panel"]').click()
  })()`)
  client.close()
  fixture.stop(true)
}
