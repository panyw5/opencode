import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

// Uses only new test assistants and restores the original active tab and viewport.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({open: ${panel}?.dataset.state === 'open', id: ${panel}?.dataset.windowId})`,
  )
  const ids: string[] = []
  const click = async (selector: string) => {
    assert.equal(
      await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click(); return true;
    })()`),
      true,
      `missing control: ${selector}`,
    )
  }
  const wait = async (expression: string, timeout = 15_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const add = async () => {
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-add-window"]')
    const id = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    ids.push(id)
    return id
  }
  const measure = () =>
    cdp.evaluate<{ client: number; scroll: number; overflowX: string; left: number; right: number }>(`(() => {
    const rail = ${panel}.querySelector('[data-component="quick-assistant-tabs"]');
    const list = rail.querySelector('[role="tablist"]');
    const r = rail.getBoundingClientRect();
    return {client:list.clientWidth,scroll:list.scrollWidth,overflowX:getComputedStyle(list).overflowX,left:r.left,right:r.right};
  })()`)
  try {
    if (!initial.open) await click('[data-component="quick-assistant-launcher"]')
    await wait(`${panel}?.dataset.state === 'open' && ${panel}.getAnimations().length === 0`)
    const id = await add()
    const prompt =
      "Reply with exactly QUICK_TITLES_OK. This conversation is about diagnosing CSS tab overflow. Do not use tools."
    await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", { text: prompt })
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-submit"]')
    await wait(`${panel}.querySelector('[data-role="assistant"]')?.textContent.includes('QUICK_TITLES_OK')`, 90_000)
    console.log("[quick-titles-test] real sidecar response received")
    await wait(
      `(async () => {
      const saved=JSON.parse(await window.api.storeGet('opencode.global.dat','quick-assistant'));
      const tab=saved.windows.find(item=>item.id===${JSON.stringify(id)});
      return !!tab?.title && tab.title!==${JSON.stringify(prompt)} && !tab.title.startsWith('Reply with exactly');
    })()`,
      90_000,
    )
    const title = await cdp.evaluate<string>(`${panel}.querySelector('[role="tab"][aria-selected="true"]').title`)
    assert.ok(title.length > 0)
    console.log(`[quick-titles-test] generated title=${title}`)

    // Long unbroken labels and a vertically overflowing list must never create horizontal scrolling.
    for (let n = 0; n < 14; n++) await add()
    await cdp.evaluate(`${panel}.querySelector('[data-slot="quick-assistant-tab-title"]').textContent='x'.repeat(300)`)
    for (const width of [1728, 430]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await wait(`${panel}.getAnimations().length === 0`)
      const size = await measure()
      assert.equal(size.overflowX, "hidden")
      assert.equal(size.scroll, size.client, `horizontal overflow at width=${width}`)
      assert.ok(size.left >= 0 && size.right <= width)
      console.log(`[quick-titles-test] width=${width} client=${size.client} scroll=${size.scroll}`)
    }
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await click(`#quick-assistant-tab-${id}`)
    const origin = await cdp.evaluate<number>("performance.timeOrigin")
    await cdp.call("Page.reload")
    await wait(`performance.timeOrigin!==${origin} && ${panel}?.dataset.windowId===${JSON.stringify(id)}`)
    await wait(`${panel}.querySelector('[role="tab"][aria-selected="true"]')?.title===${JSON.stringify(title)}`)
    console.log("[quick-titles-test] generated title persisted after reload")
  } finally {
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    for (const id of ids.reverse()) {
      if (!(await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${id}')`))) continue
      await click(`#quick-assistant-tab-${id} ~ [data-action="quick-assistant-close-window"]`)
      await wait(`!document.getElementById('quick-assistant-window-${id}')`)
    }
    if (initial.id && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${initial.id}')`)))
      await click(`#quick-assistant-tab-${initial.id}`)
    if (!initial.open && (await cdp.evaluate(`!!${panel}`)))
      await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-hide"]')
  }
})
