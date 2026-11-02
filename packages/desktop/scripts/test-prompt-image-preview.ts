import { strict as assert } from "node:assert"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/(?:localhost|127\.0\.0\.1):5173\//)
  assert.equal(await cdp.evaluate("!!window.api"), true)
  const directory = await mkdtemp(join(tmpdir(), "opencode-image-preview-"))
  const filename = `preview-${Date.now()}.png`
  const preview = `document.querySelector('[data-component="image-preview"]')`
  const thumbnail = `document.querySelector('[data-action="preview-attachment"]:has(img[alt="${filename}"])')`
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({open: ${panel}?.dataset.state === 'open', id: ${panel}?.dataset.windowId})`,
  )
  let quickID: string | undefined
  const wait = async (expression: string, timeout = 10_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const click = async (expression: string) => {
    assert.equal(
      await cdp.evaluate(`(() => {const el = ${expression}; if (!el) return false; el.click(); return true})()`),
      true,
    )
  }
  const action = (name: string) => `document.querySelector('[data-action="image-preview-${name}"]')`
  const quick = (name: string) => `${panel}?.querySelector('[data-action="quick-assistant-${name}"]')`
  const close = async () => {
    if (!(await cdp.evaluate(`!!${preview}`))) return
    await click(`${preview}.querySelector('[data-slot="image-preview-close"]')`)
    await wait(`!${preview}`)
  }
  const remove = async () => {
    await close()
    if (await cdp.evaluate(`!!${thumbnail}`))
      await click(`${thumbnail}.parentElement.querySelector('button:not([data-action])')`)
    await wait(`!${thumbnail}`)
  }
  const paste = async (kind: "main" | "quick") => {
    const src = await cdp.evaluate<string>(`(() => {
      const editor = ${kind === "quick" ? `${panel}.querySelector('[contenteditable="true"]')` : `document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]')`};
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#dce5ec'; ctx.fillRect(0, 0, 1200, 800);
      ctx.fillStyle = '#23475b'; ctx.font = '64px serif'; ctx.fillText('Image preview verification', 100, 200);
      const src = canvas.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], ${JSON.stringify(filename)}, {type:'image/png'}));
      editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data}));
      return src;
    })()`)
    await wait(`!!${thumbnail}`)
    // The filename overlay must open the preview too, rather than swallowing clicks.
    await click(`${thumbnail}.querySelector('span')`)
    await wait(`!!${preview}?.querySelector('img')?.naturalWidth`)
    return src
  }
  try {
    const original = await paste("main")
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1")
    await click(action("zoom-in"))
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1.25")
    await cdp.evaluate(`(() => {for(let i=0;i<30;i++) ${action("zoom-in")}.click()})()`)
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "4")
    assert.equal(await cdp.evaluate(`${action("zoom-in")}.disabled`), true)
    await wait(
      `${preview}.querySelector('[data-slot="image-preview-body"]').scrollWidth > ${preview}.querySelector('[data-slot="image-preview-body"]').clientWidth`,
    )
    await cdp.evaluate(`(() => {for(let i=0;i<30;i++) ${action("zoom-out")}.click()})()`)
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "0.25")
    assert.equal(await cdp.evaluate(`${action("zoom-out")}.disabled`), true)
    await click(action("reset"))
    await cdp.evaluate(
      `${preview}.querySelector('[data-slot="image-preview-body"]').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}))`,
    )
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1.25")
    await click(action("reset"))
    console.log("[image-preview-test] paste, filename click, zoom limits, reset and wheel verified")

    await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory })
    await click(action("save"))
    const path = join(directory, filename)
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(path).exists()) && Date.now() < deadline) await Bun.sleep(100)
    const file = Bun.file(path)
    assert.equal(await file.exists(), true, "save must produce a real image file")
    assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), original.split(",")[1])
    console.log(`[image-preview-test] saved original image bytes verified path=${file.name}`)

    for (const width of [1728, 430]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      await wait(
        `(() => {const r=${action("save")}.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth})()`,
      )
      const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(join(directory, `preview-${width}.png`), Buffer.from(shot.data, "base64"))
    }
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await close()
    assert.equal(await cdp.evaluate(`!!${thumbnail}`), true, "closing preview must preserve the attachment")
    // Thumbnail is a real button and must support keyboard activation.
    await cdp.evaluate(`${thumbnail}.focus()`)
    await wait(`document.activeElement === ${thumbnail}`)
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await wait(`!!${preview}`)
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
    await wait(`!${preview}`)
    await remove()
    console.log(
      "[image-preview-test] desktop/mobile layout, keyboard activation, Escape and attachment preservation verified",
    )

    if (!initial.open) await click(`document.querySelector('[data-component="quick-assistant-launcher"]')`)
    await wait(`!!${quick("add-window")}`)
    await click(quick("add-window"))
    quickID = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    await paste("quick")
    await click(action("zoom-in"))
    assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1.25")
    await remove()
    // Verify the composer still sends and receives through the real sidecar after previewing.
    await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", { text: "Reply with exactly IMAGE_PREVIEW_OK. Do not use tools." })
    await click(quick("submit"))
    await wait(
      `[...${panel}.querySelectorAll('[data-role="assistant"]')].some(el=>el.textContent.includes('IMAGE_PREVIEW_OK'))`,
      90_000,
    )
    console.log("[image-preview-test] quick assistant preview and real sidecar response verified: IMAGE_PREVIEW_OK")
  } finally {
    await remove()
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await cdp.call("Browser.setDownloadBehavior", { behavior: "default" })
    if (quickID && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${quickID}')`))) {
      await click(
        `document.querySelector('#quick-assistant-tab-${quickID} ~ [data-action="quick-assistant-close-window"]')`,
      )
    }
    if (initial.id && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${initial.id}')`))) {
      await click(`document.getElementById('quick-assistant-tab-${initial.id}')`)
    }
    if (!initial.open && (await cdp.evaluate(`!!${panel}`))) await click(quick("hide"))
  }
})
