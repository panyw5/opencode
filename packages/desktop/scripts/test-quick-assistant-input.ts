import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//)
  assert.equal(await cdp.evaluate("!!window.api"), true, "test requires the dev Electron renderer")
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({open: ${panel}?.dataset.state === 'open', id: ${panel}?.dataset.windowId})`,
  )
  let id: string | undefined
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
  const action = (name: string) =>
    `[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-${name}"]`
  try {
    if (!initial.open) {
      await click('[data-component="quick-assistant-launcher"]')
      await Bun.sleep(350)
    }
    await click(action("add-window"))
    id = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    await click(action("context"))
    const inspect = () =>
      cdp.evaluate<{
        title: string
        expected: string
        label: string
        width: number
        height: number
        textWidth: number
        scrollWidth: number
        ellipsis: string
        overflow: number
        activeBackground: string
        activeAlpha: number
        panelBackground: string
        joinBackground: string
      }>(`(() => {
      const p = ${panel};
      const form = p.querySelector('[data-prompt-kind="quick"]');
      const button = p.querySelector('[data-action="quick-assistant-submit"]');
      const title = p.querySelector('[data-slot="quick-assistant-context-title"]');
      const bounds = button.getBoundingClientRect();
      const activeBackground = getComputedStyle(p.querySelector('[role="tab"][aria-selected="true"]')).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = activeBackground;
      ctx.fillRect(0, 0, 1, 1);
      return {title:title?.textContent,expected:document.querySelector('[data-slot="compact-session-title"]')?.textContent,
        activeBackground,activeAlpha:ctx.getImageData(0,0,1,1).data[3],
        panelBackground:getComputedStyle(p).backgroundColor,
        joinBackground:getComputedStyle(p.querySelector('[data-slot="quick-assistant-tab-join"]')).backgroundColor,
        label:p.querySelector('[data-action="quick-assistant-context"]').getAttribute('aria-label'),
        width:bounds.width,height:bounds.height,textWidth:title?.clientWidth,scrollWidth:title?.scrollWidth,
        ellipsis:title ? getComputedStyle(title).textOverflow : undefined,
        overflow:Math.max(0,bounds.right-form.getBoundingClientRect().right)};
    })()`)
    for (const width of [1728, 800, 430]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      await Bun.sleep(350)
      const view = await inspect()
      assert.equal(view.width, 32)
      assert.equal(view.height, 32)
      assert.ok(view.title?.length > 0, "active context must show a title")
      assert.equal(view.title, view.expected, "context title must match the actual main session")
      assert.ok(view.label.includes(view.title), "accessible label must preserve the full title")
      assert.equal(view.ellipsis, "ellipsis")
      assert.ok(view.textWidth >= Math.min(24, view.scrollWidth), "title must remain readable at compact widths")
      assert.ok(view.overflow < 1, "submit button must remain inside the composer")
      assert.equal(view.activeAlpha, 255, "active assistant tab must have a fully opaque background")
      assert.equal(view.activeBackground, view.panelBackground, "active tab must match the conversation surface")
      assert.equal(view.joinBackground, view.panelBackground, "the tab join must match the conversation surface")
      console.log(
        `[quick-input-test] width=${width} send=${view.width}x${view.height} title=${view.title} visible=${view.textWidth} full=${view.scrollWidth} activeBackground=${view.activeBackground} alpha=${view.activeAlpha}`,
      )
      const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(`/tmp/opencode-quick-assistant-input-${width}.png`, Buffer.from(shot.data, "base64"))
      const pixels = await cdp.evaluate<{ tab: number[]; panel: number[] }>(`(async () => {
        const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(`data:image/png;base64,${shot.data}`)})).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        const p = ${panel};
        const a = p.querySelector('[role="tab"][aria-selected="true"]').getBoundingClientRect();
        const b = p.getBoundingClientRect();
        const sx = bitmap.width / innerWidth; const sy = bitmap.height / innerHeight;
        const pixel = (x, y) => [...ctx.getImageData(Math.round(x*sx), Math.round(y*sy), 1, 1).data];
        return {tab:pixel(a.right-15,a.top+5),panel:pixel(b.left+8,a.top+5)};
      })()`)
      assert.deepEqual(pixels.tab, pixels.panel, "CDP screenshot pixels must match between active tab and panel")
      console.log(
        `[quick-input-test] screenshot width=${width} tab=${pixels.tab.join(",")} panel=${pixels.panel.join(",")}`,
      )
    }
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await click(action("context"))
    assert.equal(
      await cdp.evaluate(`!!${panel}.querySelector('[data-slot="quick-assistant-context-title"]')`),
      false,
      "disabled injection must hide the title",
    )
    console.log("[quick-input-test] disabling injection hides the title")

    if (initial.id) {
      await click(`#quick-assistant-tab-${initial.id}`)
      await Bun.sleep(200)
      assert.equal((await inspect()).activeAlpha, 255, "switching tabs must keep the active background opaque")
      await click(`#quick-assistant-tab-${id}`)
      await Bun.sleep(200)
      assert.equal((await inspect()).activeAlpha, 255)
      console.log("[quick-input-test] active tab background remains opaque after switching")
    }

    await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", { text: "Reply with exactly QUICK_INPUT_OK. Do not use tools." })
    await click(action("submit"))
    const deadline = Date.now() + 90_000
    let received = false
    while (Date.now() < deadline) {
      received = await cdp.evaluate<boolean>(
        `[...${panel}.querySelectorAll('[data-role="assistant"]')].some(el=>el.textContent.includes('QUICK_INPUT_OK'))`,
      )
      if (received) break
      await Bun.sleep(500)
    }
    assert.ok(received, "the resized send button must still send and receive through the real sidecar")
    assert.equal((await inspect()).width, 32)
    console.log("[quick-input-test] real sidecar response verified: QUICK_INPUT_OK")
  } finally {
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    if (id && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${id}')`))) {
      await click(`#quick-assistant-tab-${id} ~ [data-action="quick-assistant-close-window"]`)
      await Bun.sleep(350)
    }
    if (initial.id && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${initial.id}')`)))
      await click(`#quick-assistant-tab-${initial.id}`)
    if (!initial.open && (await cdp.evaluate(`!!${panel}`))) await click(action("hide"))
  }
})
