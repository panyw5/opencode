import { connectCdp } from "./cdp"

const log = (message: string) => console.log(`[config-tab-e2e] ${message}`)
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173")) throw new Error("Only the development renderer may be tested")
const config = '[data-component="config-tab"]'
const close = '[data-action="config-tab-close"]'
const page = '[data-component="config-page"]'
const activeSession = '[data-component="session-tab"][data-active="true"][data-session-id]'
const visible = (selector: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getBoundingClientRect().width > 0)`

async function wait(expression: string, label: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

async function click(selector: string) {
  const point = await client.evaluate<{ x: number; y: number }>(`(() => {
    const element = ${visible(selector)}[0]
    if (!element) throw Error('Missing visible target: '+${JSON.stringify(selector)})
    element.scrollIntoView({block:'nearest',inline:'nearest'})
    const rect = element.getBoundingClientRect()
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
  })()`)
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
}

async function keybind(binding: string) {
  if (!binding || binding === "none") throw new Error("Close tab is unbound; cannot test a disabled shortcut")
  const parts = binding.split(",")[0].toLowerCase().split("+")
  const mac = await client.evaluate<boolean>(`/Mac/.test(navigator.platform)`)
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    if (part === "mod") modifiers |= mac ? 4 : 2
    if (part === "meta" || part === "cmd" || part === "command") modifiers |= 4
    if (part === "ctrl" || part === "control") modifiers |= 2
    if (part === "shift") modifiers |= 8
    if (part === "alt" || part === "option") modifiers |= 1
  }
  const name = parts.at(-1)!
  const key =
    ({ comma: ",", period: ".", slash: "/", escape: "Escape", backspace: "Backspace" } as Record<string, string>)[
      name
    ] ?? name
  const params = { key, modifiers }
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", ...params })
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", ...params })
}

try {
  const bindings = await client.evaluate<Record<string, string>>(
    `window.api.storeGet('default.dat','settings.v3').then(value => JSON.parse(value).keybinds)`,
  )
  const closeBinding = bindings["tab.close"] ?? "mod+w"
  log(`effective close binding=${closeBinding}`)
  if (await client.evaluate(`${visible(config)}.length > 0`)) await click(close)
  await wait(`!document.querySelector(${JSON.stringify(config)})`, "initial config tab closed")

  const sessionID = await client.evaluate<string>(
    `document.querySelector(${JSON.stringify(activeSession)})?.dataset.sessionId ?? document.querySelector('[data-component="session-tab"][data-session-id]')?.dataset.sessionId`,
  )
  if (!sessionID) throw new Error("Open at least one session before running this regression")
  const session = `[data-component="session-tab"][data-session-id="${sessionID}"]`
  await click(session)
  await wait(`!!document.querySelector(${JSON.stringify(session + '[data-active="true"]')})`, "origin session active")

  await click('[data-action="config-open"]')
  await wait(
    `!!document.querySelector(${JSON.stringify(page)}) && ${visible(config + '[data-active="true"]')}.length === 1`,
    "one active config tab",
  )
  await click('[data-action="config-open"]')
  if (!(await client.evaluate(`${visible(config)}.length === 1`))) throw new Error("Duplicate config tabs")
  log("PASS config opens as one active tab")

  await click('[data-config-pane="left"] .config-scrollbar button:nth-child(2)')
  await wait(
    `document.querySelector('[data-config-pane="left"] button[aria-current="page"]')?.textContent.includes('AGENTS.md')`,
    "section navigation completes",
  )
  await wait(`${visible(config + '[data-active="true"]')}.length === 1`, "section navigation keeps one config tab")

  await click(session)
  await wait(
    `!document.querySelector(${JSON.stringify(page)}) && ${visible(config)}.length === 1`,
    "background config tab retained",
  )
  await click(config)
  await wait(`!!document.querySelector(${JSON.stringify(page)})`, "config tab reactivated")
  await click(close)
  await wait(
    `!document.querySelector(${JSON.stringify(config)}) && !!document.querySelector(${JSON.stringify(session + '[data-active="true"]')})`,
    "close button restores origin",
  )
  log("PASS retained tab activation and active close button")

  await click('[data-action="config-open"]')
  await wait(`!!document.querySelector(${JSON.stringify(page)})`, "config reopened for keyboard")
  await keybind(closeBinding)
  await wait(
    `!document.querySelector(${JSON.stringify(config)}) && !!document.querySelector(${JSON.stringify(session + '[data-active="true"]')})`,
    "keyboard closes config only",
  )
  log("PASS configured close-tab shortcut")

  await click('[data-action="config-open"]')
  await wait(`!!document.querySelector(${JSON.stringify(page)})`, "config reopened for background close")
  await click(session)
  await wait(`!document.querySelector(${JSON.stringify(page)})`, "origin active again")
  await click(close)
  await wait(
    `!document.querySelector(${JSON.stringify(config)}) && !!document.querySelector(${JSON.stringify(session + '[data-active="true"]')})`,
    "background close preserves active session",
  )
  log("PASS background close preserves active session")

  await client.call("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.evaluate(`document.querySelector('[data-action="config-open"]').click()`)
  await wait(`${visible(config)}.length === 1`, "config tab visible in narrow viewport")
  await click(close)
  await wait(`!document.querySelector(${JSON.stringify(config)})`, "narrow config close")
  log("PASS narrow viewport close button")
} finally {
  await client.call("Emulation.clearDeviceMetricsOverride")
  client.close()
}
