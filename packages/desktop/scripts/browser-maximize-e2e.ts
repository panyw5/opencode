import { CdpClient, connectCdp, listTargets } from "./cdp"

const log = (message: string) => console.log(`[browser-maximize-e2e] ${message}`)
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173")) throw new Error("Only the development renderer may be tested")
let partition: string | undefined
let page: CdpClient | undefined
const pause = () => new Promise((resolve) => setTimeout(resolve, 100))
async function wait(expression: string, label: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return
    await pause()
  }
  throw new Error(`Timed out: ${label}`)
}
async function click(selector: string) {
  const point = await client.evaluate<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw Error('Missing click target: '+${JSON.stringify(selector)})
    const rect = element.getBoundingClientRect()
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
  })()`)
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
}
async function displayed(floating: boolean) {
  const selector = floating ? "[data-browser-floating-placeholder]" : "[data-browser-placeholder]"
  await wait(
    `(async()=> {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return false
    const rect = element.getBoundingClientRect()
    const views = (await window.api.browser.getDisplayState()).views.filter(view=>view.visible)
    if (views.length !== 1 || views[0].partition !== ${JSON.stringify(partition)}) return false
    const bounds = views[0].bounds
    return Math.abs(bounds.x-rect.left)<2 && Math.abs(bounds.y-rect.top)<2
      && Math.abs(bounds.width-rect.width)<2 && Math.abs(bounds.height-rect.height)<2
  })()`,
    floating ? "native page fills floating viewport" : "native page restored to dock",
  )
}

try {
  await wait(`!!document.querySelector('#browser-panel')`, "session page is mounted")
  await client.evaluate(
    `window.dispatchEvent(new CustomEvent('browser-panel:open-tab',{detail:'https://example.com'}))`,
  )
  await wait(`!!document.querySelector('[data-browser-placeholder]')?.dataset.browserPlaceholder`, "fixture tab")
  partition = await client.evaluate<string>(
    `document.querySelector('[data-browser-placeholder]').dataset.browserPlaceholder`,
  )
  const html = `<!doctype html><title>Browser Maximize Fixture</title><body style="margin:0;background:#006b70;color:white;padding:32px;font:24px sans-serif"><h1>Single Page Float</h1><button id="counter" style="font:inherit;padding:16px" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><p>This page must survive maximize and restore without reloading.</p>`
  await client.evaluate(
    `window.api.browser.open(${JSON.stringify(partition)},${JSON.stringify(`data:text/html,${encodeURIComponent(html)}`)})`,
  )
  await displayed(false)
  const fixture = (await listTargets()).find((item) => item.title === "Browser Maximize Fixture")
  if (!fixture) throw new Error("Missing native fixture target")
  page = await CdpClient.connect(fixture.webSocketDebuggerUrl)
  await page.evaluate(`window.__maximizeMarker = 'preserved'`)
  const adjacent = await client.evaluate<boolean>(`(() => {
    const button = document.querySelector('[data-action="browser-maximize"]')
    return button.previousElementSibling.getAttribute('data-icon') === 'refresh-small'
  })()`)
  if (!adjacent) throw new Error("Maximize button is not directly after reload")
  log(`PASS button position partition=${partition}`)

  await click('[data-action="browser-maximize"]')
  await displayed(true)
  const single = await client.evaluate<boolean>(`(() => {
    const dialog = document.querySelector('[data-browser-maximized]')
    const rect = dialog.getBoundingClientRect()
    return rect.width > innerWidth*0.9 && rect.height > innerHeight*0.9
      && !dialog.querySelector('[aria-pressed]') && !dialog.querySelector('[data-action="browser-maximize"]')
      && document.querySelector('#browser-panel').hasAttribute('inert')
  })()`)
  if (!single) throw new Error("Floating browser is not nearly maximized with a single page")
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('#counter').getBoundingClientRect()
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
  })()`)
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
  if ((await page.evaluate<string>(`document.querySelector('#counter').textContent`)) !== "1")
    throw new Error("Floating page is not interactive")
  const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await Bun.write("/tmp/browser-maximize.png", Buffer.from(shot.data, "base64"))
  log("PASS near-maximized single-page dialog, native bounds and page interaction screenshot=/tmp/browser-maximize.png")

  const nativeShot = await page.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await Bun.write("/tmp/browser-maximize-page.png", Buffer.from(nativeShot.data, "base64"))
  const binding = await client.evaluate<string>(
    `window.api.storeGet('default.dat','settings.v3').then(value => JSON.parse(value).keybinds?.['command.palette'] ?? 'mod+shift+p')`,
  )
  if (binding && binding !== "none") {
    const parts = binding.toLowerCase().split("+")
    const key = parts.pop()!.toUpperCase()
    const modifiers = parts.reduce(
      (value, part) => value | ({ mod: 4, meta: 4, ctrl: 2, shift: 8, alt: 1 }[part] ?? 0),
      0,
    )
    log(`effective command palette binding=${binding}`)
    await click("[data-browser-maximized] input")
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers })
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers })
    await wait(
      `(async()=> {
      const content = document.querySelector('[data-slot="dialog-content"]')
      if (!content || (await window.api.browser.getDisplayState()).views.some(view=>view.visible)) return false
      const rect = content.getBoundingClientRect()
      return content.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))
    })()`,
      "command palette is above floating browser and native page is hidden",
    )
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" })
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" })
    await displayed(true)
    log("PASS nested command palette remains above floating browser and restores its page")
  }

  await click('[data-action="browser-restore"]')
  await displayed(false)
  if (
    !(await page.evaluate<boolean>(
      `window.__maximizeMarker === 'preserved' && document.querySelector('#counter').textContent === '1'`,
    ))
  )
    throw new Error("Page was reloaded during maximize/restore")
  log("PASS restoring retains the live page state")

  await click('[data-action="browser-maximize"]')
  await displayed(true)
  await click('[data-browser-maximized] button[aria-label="关闭"], [data-browser-maximized] button[aria-label="Close"]')
  await displayed(false)
  log("PASS close returns to dock without closing the tab")

  await click('[data-action="browser-maximize"]')
  await displayed(true)
  // Focus browser chrome so Escape is sent to the renderer, not the webpage.
  await click("[data-browser-maximized] input")
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" })
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" })
  await displayed(false)
  log("PASS Escape from floating browser chrome")

  for (let index = 0; index < 3; index++) {
    await click('[data-action="browser-maximize"]')
    await displayed(true)
    await click('[data-action="browser-restore"]')
    await displayed(false)
  }
  log("PASS repeated maximize/restore cycles")
  await click('[data-action="browser-maximize"]')
  await displayed(true)
  await client.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`)
  await wait(`!document.querySelector('[data-browser-maximized]')`, "closing enlarged tab dismisses float")
  log("PASS backend tab closure dismisses float")
} finally {
  page?.close()
  if (partition) await client.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`).catch(() => {})
  client.close()
}
