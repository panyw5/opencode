import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

// Open a file preview in the dev renderer before running this regression test.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /localhost:5173|^oc:\/\//)
  const selector = '[data-slot="file-markdown-actions"]'
  const trigger = `${selector} button[data-icon="dot-grid"]`
  const rect = (query: string) =>
    cdp.evaluate<{ x: number; y: number; width: number; height: number }>(
      `document.querySelector(${JSON.stringify(query)}).getBoundingClientRect().toJSON()`,
    )
  const expanded = () => cdp.evaluate<string>(`document.querySelector('${selector}').dataset.expanded`)
  let pointer = { x: 0, y: 0 }
  const move = async (x: number, y: number) => {
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    pointer = { x, y }
    await Bun.sleep(80)
  }
  const click = async (query: string) => {
    const box = await rect(query)
    assert.ok(box.width > 0 && box.height > 0, `click target is visible: ${query}`)
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left", clickCount: 1 }
    const start = pointer
    const steps = Math.ceil(Math.hypot(position.x - start.x, position.y - start.y) / 8)
    for (let step = 1; step <= steps; step++) {
      await cdp.call("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x + ((position.x - start.x) * step) / steps,
        y: start.y + ((position.y - start.y) * step) / steps,
      })
    }
    await move(position.x, position.y)
    assert.equal(
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(query)}).contains(document.elementFromPoint(${position.x},${position.y}))`,
      ),
      true,
      `mouse actually hits ${query}`,
    )
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...position })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...position })
  }
  const reset = async () => {
    await cdp.evaluate("document.activeElement?.blur()")
    const box = await rect(selector)
    await move(box.x - 20, box.y + box.height + 30)
    const deadline = Date.now() + 2_000
    while ((await expanded()) !== "false" && Date.now() < deadline) await Bun.sleep(50)
    assert.equal(await expanded(), "false", "toolbar collapses after pointer and focus leave")
  }

  assert.equal(await cdp.evaluate(`document.querySelectorAll('${selector}').length`), 1, "one open file preview")
  await reset()
  if (!Bun.argv.includes("--mouse-only")) {
    const anchor = await rect(trigger)
    console.log("[file-actions-test] collapsed entry located")

    await move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
    assert.equal(await expanded(), "true")
    assert.deepEqual(await rect(trigger), anchor, "expansion must not move the entry button")
    console.log("[file-actions-test] hover expansion keeps entry anchored")

    const box = await rect(selector)
    await cdp.evaluate(`(() => {
    const root = document.querySelector('${selector}');
    window.__fileActionsFlicker = [];
    window.__fileActionsButton = root.querySelector('button');
    window.__fileActionsObserver?.disconnect();
    window.__fileActionsObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.oldValue === 'true') window.__fileActionsFlicker.push('collapsed');
      }
    });
    window.__fileActionsObserver.observe(root, {attributes:true, attributeOldValue:true, attributeFilter:['data-expanded']});
  })()`)
    // Move continuously through corners, gaps and just outside the painted border.
    for (const y of [box.y - 3, box.y + 2, box.y + box.height / 2, box.y + box.height + 3]) {
      for (let x = box.x + box.width - 2; x >= box.x + 2; x -= 7) {
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      }
    }
    await move(box.x - 14, box.y + box.height / 2)
    await move(box.x + 12, box.y + box.height / 2)
    await Bun.sleep(240)
    assert.deepEqual(await cdp.evaluate("window.__fileActionsFlicker"), [], "no transient collapse during movement")
    await cdp.evaluate("window.__fileActionsObserver.disconnect()")
    console.log("[file-actions-test] continuous motion and brief exit/re-entry: zero flicker transitions")

    // Follow the top padding to the left: this used to lose hover and collapse.
    for (let x = box.x + box.width - 8; x >= box.x + 8; x -= 10) {
      await move(x, box.y + 2)
      assert.equal(await expanded(), "true", `hover bridge lost at x=${x}`)
    }
    console.log("[file-actions-test] entire padding bridge retains hover")

    const buttons = await cdp.evaluate<{ label: string; x: number; y: number }[]>(
      `Array.from(document.querySelectorAll('${selector} button')).map(b => {
      const r = b.getBoundingClientRect();
      return {label:b.getAttribute('aria-label'),x:r.x+r.width/2,y:r.y+r.height/2}
    })`,
    )
    for (const button of buttons) {
      await move(button.x, button.y)
      await Bun.sleep(650)
      assert.equal(await expanded(), "true", `cannot hover ${button.label}`)
      assert.equal(
        await cdp.evaluate(
          `document.elementFromPoint(${button.x},${button.y})?.closest('button')?.getAttribute('aria-label')`,
        ),
        button.label,
      )
      console.log(`[file-actions-test] button reachable with tooltip label=${button.label}`)
    }
    await reset()
    assert.equal(
      await cdp.evaluate("window.__fileActionsButton.isConnected"),
      true,
      "collapsing must not unmount action buttons",
    )

    await cdp.evaluate(`document.querySelector('${trigger}').focus()`)
    assert.equal(await expanded(), "true", "keyboard focus expands toolbar")
    await cdp.evaluate(`document.querySelector('${selector} button').focus()`)
    assert.equal(await expanded(), "true", "focus can move to left actions")
    await reset()
    console.log("[file-actions-test] focus expansion and collapse verified")

    await cdp.evaluate(`document.querySelector('${trigger}').focus()`)
    const menuTrigger = `${selector} [aria-haspopup]`
    if (await cdp.evaluate(`!!document.querySelector('${menuTrigger}')`)) {
      await click(menuTrigger)
      await Bun.sleep(100)
      assert.equal(await cdp.evaluate(`document.querySelector('${menuTrigger}').getAttribute('aria-expanded')`), "true")
      const menu = await rect('[data-component="dropdown-menu-content"]')
      await move(menu.x + menu.width / 2, menu.y + menu.height / 2)
      await Bun.sleep(260)
      assert.equal(await expanded(), "true", "portalled menu must keep toolbar expanded")
      assert.equal(await cdp.evaluate(`document.querySelector('${menuTrigger}').getAttribute('aria-expanded')`), "true")
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
      await reset()
      console.log("[file-actions-test] portalled open-with menu remains usable")
    }

    await click(trigger)
    await cdp.evaluate("document.activeElement?.blur()")
    await move(box.x - 20, box.y + box.height + 30)
    assert.equal(await expanded(), "true", "pinned toolbar survives pointer leaving")
    await click(trigger)
    await reset()
    console.log("[file-actions-test] pin and unpin verified")

    await cdp.evaluate(`document.querySelector('${trigger}').focus()`)
    if (await cdp.evaluate(`!!document.querySelector('${selector} [data-value="source"]')`)) {
      for (const mode of ["source", "preview"]) {
        await click(`${selector} [data-value="${mode}"] label`)
        assert.equal(await cdp.evaluate(`document.querySelector('${selector} input[value="${mode}"]').checked`), true)
        assert.equal(await expanded(), "true", "mode change preserves hover/focus")
        assert.deepEqual(await rect(trigger), anchor, "mode change keeps entry anchored")
        console.log(`[file-actions-test] mode switch verified mode=${mode}`)
      }
    }
    await reset()
  }
  if (Bun.argv.includes("--actions")) {
    const hoverOnly = async () => {
      await reset()
      const entry = await rect(trigger)
      await move(entry.x + entry.width / 2, entry.y + entry.height / 2)
      assert.equal(await expanded(), "true")
      console.log("[file-actions-test] hover-only entry: no pinning, no programmatic focus")
    }
    for (const mode of ["source", "preview"]) {
      await hoverOnly()
      await click(`${selector} [data-value="${mode}"] label`)
      assert.equal(await cdp.evaluate(`document.querySelector('${selector} input[value="${mode}"]').checked`), true)
      console.log(`[file-actions-test] hover-only mouse mode switch verified mode=${mode}`)
    }
    const clipboard = async () => {
      const process = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "pipe" })
      const text = await new Response(process.stdout).text()
      assert.equal(await process.exited, 0)
      return text
    }
    await hoverOnly()
    await click(`${selector} button[aria-label="复制文件地址"]`)
    await Bun.sleep(100)
    const path = await clipboard()
    assert.equal(await Bun.file(path).exists(), true, "copied path points to a real file")
    console.log(`[file-actions-test] actual copy path verified path=${path}`)

    await hoverOnly()
    await click(`${selector} button[aria-label="复制全部内容"]`)
    await Bun.sleep(100)
    assert.equal(await clipboard(), await Bun.file(path).text(), "copied content equals the complete original file")
    console.log(`[file-actions-test] actual copy content verified chars=${(await clipboard()).length}`)

    await hoverOnly()
    await click(`${selector} button[data-icon="expand"]`)
    await Bun.sleep(200)
    assert.equal(
      await cdp.evaluate("document.querySelector('[role=dialog] [data-slot=dialog-title]').textContent"),
      path.split("/").at(-1),
    )
    assert.equal(
      await cdp.evaluate("!!document.querySelector('[role=dialog] [data-component=file][data-mode=markdown]')"),
      true,
    )
    await click('[role="dialog"] [data-slot="dialog-close-button"]')
    await Bun.sleep(150)
    assert.equal(await cdp.evaluate("document.querySelectorAll('[role=dialog]').length"), 0)
    console.log("[file-actions-test] actual maximize shows file preview; close restores original view")

    await hoverOnly()
    await click(`${selector} [aria-haspopup]`)
    await Bun.sleep(100)
    const option = await cdp.evaluate<string>(
      `Array.from(document.querySelectorAll('[data-slot=dropdown-menu-radio-item]')).find(e=>e.textContent.includes('Zed'))?.id`,
    )
    assert.ok(option, "Zed option is available")
    await click(`#${option}`)
    await Bun.sleep(800)
    console.log("[file-actions-test] actual open-with Zed selected; verify native application and launch logs")
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })

    await hoverOnly()
    await click(`${selector} button[data-icon="folder"]`)
    await Bun.sleep(600)
    console.log("[file-actions-test] actual reveal file button clicked; verify native Finder selection")
    await reset()
  }
  console.log("[file-actions-test] PASS")
})
