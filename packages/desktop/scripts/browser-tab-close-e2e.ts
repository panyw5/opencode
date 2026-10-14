import { connectCdp } from "./cdp"

const log = (message: string) => console.log(`[browser-tab-close-e2e] ${message}`)
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173")) throw new Error("Only the development renderer may be tested")
const partitions: string[] = []
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(expression: string, label: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return
    await pause()
  }
  throw new Error(`Timed out: ${label}`)
}
async function click(selector: string, edge = false) {
  const point = await client.evaluate<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) throw Error('Missing target: '+${JSON.stringify(selector)})
    const rect = element.getBoundingClientRect()
    return {x:${edge ? "rect.right-1" : "rect.x+rect.width/2"},y:${edge ? "rect.bottom-1" : "rect.y+rect.height/2"}}
  })()`)
  await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
  await pause(180)
  const hit = await client.evaluate<string>(`(() => {
    const element = document.elementFromPoint(${point.x},${point.y})
    return element?.closest('#browser-panel [role="button"]') ? 'close' : element?.closest('button') ? 'tab' : element?.tagName
  })()`)
  log(`release selector=${selector} edge=${edge} hit=${hit}`)
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
}

try {
  await wait(`!!document.querySelector('#browser-panel')`, "browser panel mounted")
  // Instrument only the test: retain each native event target for failure reports.
  await client.evaluate(`(() => {
    window.__browserCloseTrace = []
    window.__browserCloseListener = event => {
      if (!event.target.closest('#browser-panel, [data-browser-maximized]')) return
      const item = event.target.closest('[role=button], button')
      window.__browserCloseTrace.push(event.type+':'+item?.getAttribute('aria-label')+':'+item?.tagName)
    }
    for (const type of ['pointerdown','pointerup','click']) document.addEventListener(type,window.__browserCloseListener,true)
  })()`)
  for (const edge of [false, true]) {
    await client.evaluate(
      `window.dispatchEvent(new CustomEvent('browser-panel:open-tab',{detail:'https://example.com'}))`,
    )
    const partition = await client.evaluate<string>(
      `document.querySelector('[data-browser-placeholder]').dataset.browserPlaceholder`,
    )
    partitions.push(partition)
    log(`created partition=${partition} edge=${edge}`)
    await client.evaluate(
      `window.api.browser.open(${JSON.stringify(partition)}, 'data:text/html,<title>Browser close after maximize regression fixture</title><body>Close once</body>')`,
    )
    await wait(
      `(async()=> (await window.api.browser.getDisplayState()).views.some(view=>view.partition===${JSON.stringify(partition)} && view.visible))()`,
      "native page shown",
    )
    await pause(400)
    await click('[data-action="browser-maximize"]')
    await wait(`!!document.querySelector('[data-browser-maximized]')`, "floating page opened")
    await click('[data-action="browser-restore"]')
    await wait(
      `!document.querySelector('[data-browser-maximized]') && !document.querySelector('#browser-panel').hasAttribute('inert')`,
      "dock restored",
    )
    await click('#browser-panel button[aria-pressed="true"] [role="button"]', edge)
    await pause()
    const remaining = await client.evaluate<boolean>(
      `(async()=> (await window.api.browser.getState()).some(view=>view.partition===${JSON.stringify(partition)}))()`,
    )
    log(`single close result partition=${partition} remaining=${remaining}`)
    if (remaining) {
      log(`trace=${await client.evaluate<string>(`window.__browserCloseTrace.join(' | ')`)}`)
      throw new Error(`One close click after restore did not close tab edge=${edge}`)
    }
    log(`PASS one close click after maximize/restore edge=${edge}`)
  }
} finally {
  for (const partition of partitions)
    await client.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`).catch(() => {})
  await client
    .evaluate(
      `(() => {
    for (const type of ['pointerdown','pointerup','click']) document.removeEventListener(type,window.__browserCloseListener,true)
    delete window.__browserCloseListener
    delete window.__browserCloseTrace
  })()`,
    )
    .catch(() => {})
  client.close()
}
