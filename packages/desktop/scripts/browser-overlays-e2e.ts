import { mkdir, realpath } from "node:fs/promises"
import { connectCdp } from "./cdp"

const log = (message: string) => console.log(`[browser-overlays-e2e] ${message}`)
const { client, target } = await connectCdp()
let fixturePartition: string | undefined
if (!target.url.includes("localhost:5173")) throw new Error("Only the development renderer may be tested")
const pause = () => new Promise((resolve) => setTimeout(resolve, 100))
async function wait(expression: string, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return
    await pause()
  }
  throw new Error(`Timed out: ${label}`)
}
async function click(selector: string) {
  const point = await client.evaluate<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw Error('Missing click target')
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })()`)
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
}
async function key(key: string, modifiers = 0) {
  const params = { key, modifiers, ...(key.toUpperCase() === "P" ? { code: "KeyP", windowsVirtualKeyCode: 80 } : {}) }
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", ...params })
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", ...params })
}
async function screenshot(name: string, selector?: string) {
  await new Promise((resolve) => setTimeout(resolve, 350))
  if (selector) await wait(`!!document.querySelector(${JSON.stringify(selector)})`, `visible ${name} before screenshot`)
  const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  const path = `/tmp/browser-overlays-${name}.png`
  await Bun.write(path, Buffer.from(shot.data, "base64"))
  log(`screenshot=${path}`)
}
const restored = `(async()=> (await window.api.browser.getDisplayState()).views.some(view => view.visible))()`
const obscured = `(async()=> {
  const state = await window.api.browser.getDisplayState()
  const image = document.querySelector('[data-browser-preview]')
  if (!image?.complete || !image.naturalWidth || state.views.some(view => view.visible)) return false
  if (!state.views.every(view => view.bounds.x === -32000 && view.bounds.width === 1)) return false
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  canvas.getContext('2d').drawImage(image, image.naturalWidth - 20, image.naturalHeight - 20, 1, 1, 0, 0, 1, 1)
  const pixel = canvas.getContext('2d').getImageData(0,0,1,1).data
  return pixel[0] === 0 && pixel[1] === 128 && pixel[2] === 128
})()`

try {
  const bindings = await client.evaluate<Record<string, string>>(
    `window.api.storeGet('default.dat','settings.v3').then(value => JSON.parse(value).keybinds)`,
  )
  const palette = bindings["command.palette"] ?? "mod+shift+p"
  if (palette !== "mod+shift+p")
    throw new Error(`This regression runner needs the effective palette binding, got ${palette}`)
  log(`effective palette binding=${palette}`)

  // Exercise the real sidecar in an isolated session without editing user work.
  const sidecarModel = Bun.env.OPENCODE_OVERLAY_TEST_MODEL
  if (sidecarModel) {
    const slash = sidecarModel.indexOf("/")
    if (slash < 1) throw new Error("OPENCODE_OVERLAY_TEST_MODEL must be provider/model")
    const model = { providerID: sidecarModel.slice(0, slash), modelID: sidecarModel.slice(slash + 1) }
    await mkdir("/tmp/opencode-browser-overlays-regression", { recursive: true })
    const directory = await realpath("/tmp/opencode-browser-overlays-regression")
    await client.evaluate(`(async()=> {
    const server = await window.api.awaitInitialization(()=>{})
    window.__browserOverlayRequest = async (path, body) => {
      const response = await fetch(server.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'Content-Type':'application/json', 'x-opencode-directory':${JSON.stringify(directory)},
          Authorization:'Basic '+btoa((server.username || 'opencode')+':'+server.password)},
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw Error('sidecar HTTP '+response.status+' path='+path)
      return response.status === 204 ? null : response.json()
    }
    const session = await window.__browserOverlayRequest('/session', {title:'Browser overlay regression',permission:[{permission:'*',pattern:'*',action:'deny'}]})
    window.__browserOverlaySession = session.id
    await window.__browserOverlayRequest('/session/'+session.id+'/prompt_async', {
      model:${JSON.stringify(model)},
      parts:[{type:'text',text:'Do not use tools. Reply with only BROWSER_OVERLAY_SIDECAR_OK.'}],
    })
    return true
  })()`)
    log("sidecar message sent in isolated session")
    await wait(
      `(async()=> {
    const messages = await window.__browserOverlayRequest('/session/'+window.__browserOverlaySession+'/message')
    const assistant = messages.find(message => message.info.role === 'assistant' && message.info.time.completed)
    if (assistant?.info.error) throw Error('Sidecar assistant failed: '+JSON.stringify(assistant.info.error))
    return messages.some(message => message.info.role === 'user') && assistant?.parts.some(part => part.type === 'text' && part.text.includes('BROWSER_OVERLAY_SIDECAR_OK'))
  })()`,
      "sidecar received assistant reply",
      90_000,
    )
    log("PASS sidecar user message and assistant reply verified")
  }

  await wait(
    `!!document.querySelector('[data-component="session-status-float"]')`,
    "active session status float; run this test on a session page",
  )
  await client.evaluate(`window.dispatchEvent(new CustomEvent('browser-panel:open-tab',{detail:'about:blank'}))`)
  await wait(`!!document.querySelector('[data-browser-placeholder]')`, "browser placeholder")
  const partition = await client.evaluate<string>(
    `document.querySelector('[data-browser-placeholder]').dataset.browserPlaceholder`,
  )
  fixturePartition = partition
  const html = `<!doctype html><title>Browser Overlay Fixture</title><body style="background:teal;color:white;font-size:32px;padding:24px"><h1>Browser Overlay Fixture</h1><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>`
  await client.evaluate(
    `window.api.browser.open(${JSON.stringify(partition)}, ${JSON.stringify(`data:text/html,${encodeURIComponent(html)}`)})`,
  )
  await wait(restored, "native browser visible")
  log(`fixture loaded partition=${partition}`)

  await click('[data-action="session-new-project-menu"]')
  await wait(obscured, "project menu above preserved browser image")
  await screenshot("project-menu")
  await key("Escape")
  await wait(restored, "browser restored after menu")
  log("PASS project menu and native hit-region restoration")

  await key("P", 12)
  await wait(`!!document.querySelector('[data-slot="dialog-content"]')`, "command palette")
  await wait(obscured, "palette over preserved browser image")
  await screenshot("command-palette", '[data-slot="dialog-content"]')
  await wait(obscured, "palette remains over preserved browser image after animation")
  await key("Escape")
  await wait(restored, "browser restored after palette")
  log("PASS command palette preserves browser pixels")

  await click('[data-action="session-status-toggle-button"] button')
  await wait(`!!document.querySelector('[data-slot="session-status-float-panel"]')`, "status float open")
  await screenshot("session-status")
  await click('[data-action="session-status-float-close"]')
  await wait(`!document.querySelector('[data-slot="session-status-float-panel"]')`, "status float close via real click")
  await wait(restored, "browser restored after status float")
  log("PASS session status float remains visible and clickable")

  await click('button[aria-label="状态"]')
  await wait(`!!document.querySelector('[data-component="popover-content"]')`, "header status popover")
  await wait(obscured, "header status popover over preserved browser image")
  await screenshot("header-status")
  await key("Escape")
  await wait(restored, "browser restored after header status")
  log("PASS overlapping status popover and browser restoration")

  for (let index = 0; index < 4; index++) {
    await key("P", 12)
    await key("Escape")
    await wait(restored, "rapid palette close restores browser")
  }
  log("PASS rapid palette open/close")
  await client.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`)
  log("PASS all browser overlay regressions")
} finally {
  if (fixturePartition)
    await client.evaluate(`window.api.browser.close(${JSON.stringify(fixturePartition)})`).catch(() => {})
  client.close()
}
