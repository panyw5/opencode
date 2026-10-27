import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

// Run against the already-running dev renderer: bun packages/desktop/scripts/test-quick-assistant-motion.ts
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  const launcher = `document.querySelector('[data-component="quick-assistant-launcher"]')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({ open: !!${panel}, id: ${panel}?.dataset.windowId })`,
  )
  let testID: string | undefined
  const click = async (selector: string) => {
    assert.equal(
      await cdp.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) return false;
      button.click(); return true;
    })()`),
      true,
      `missing button: ${selector}`,
    )
  }
  const hide = '[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-hide"]'
  const show = '[data-component="quick-assistant-launcher"]'
  type Sample = { x: number; tabs: number; inert: boolean; state: string; animations: number }
  const track = (action: string) =>
    cdp.evaluate<Sample[]>(`(async () => {
    const samples = [];
    ${action};
    const start = performance.now();
    while (performance.now() - start < 350) {
      const el = ${panel};
      if (el) samples.push({
        x: new DOMMatrixReadOnly(getComputedStyle(el).transform).m41,
        tabs: el.querySelector('[data-component="quick-assistant-tabs"]')?.getBoundingClientRect().left,
        inert: el.inert, state: el.dataset.state, animations: el.getAnimations().length,
      });
      await new Promise(requestAnimationFrame);
    }
    return samples;
  })()`)
  try {
    await cdp.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    })
    if (!initial.open) {
      await click(show)
      await Bun.sleep(350)
    }
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-add-window"]')
    await Bun.sleep(350)
    testID = await cdp.evaluate<string>(`${panel}.dataset.windowId`)

    const exiting = await track(`${panel}.querySelector('[data-action="quick-assistant-hide"]').click()`)
    assert.ok(exiting.length > 2, "exit must retain the panel for multiple frames")
    assert.ok(
      exiting.every((sample) => sample.inert && sample.state === "closed"),
      "exiting UI must be inert",
    )
    assert.ok(Math.max(...exiting.map((sample) => sample.x)) > 300, "exit must move right")
    assert.ok(
      exiting.some((sample) => sample.x > 1 && sample.x < 300),
      "exit must interpolate, not jump",
    )
    assert.equal(await cdp.evaluate(`!!${panel}`), false, "exit must unmount the UI")
    console.log(`[quick-motion-test] exit frames=${exiting.length} maxX=${Math.max(...exiting.map((s) => s.x))}`)

    const entering = await track(`${launcher}.click()`)
    assert.ok(Math.max(...entering.map((sample) => sample.x)) > 100, "entry must start from the right")
    assert.ok(Math.abs(entering.at(-1)!.x) < 1, "entry must settle in place")
    console.log(`[quick-motion-test] enter frames=${entering.length} startX=${Math.max(...entering.map((s) => s.x))}`)

    await click(hide)
    await Bun.sleep(60)
    await click(show)
    await Bun.sleep(350)
    assert.equal(await cdp.evaluate(`${panel}?.dataset.windowId`), testID, "rapid reversal must preserve the window")
    console.log("[quick-motion-test] rapid reversal preserved active window")

    await click(`[role="tab"][id="quick-assistant-tab-${initial.id ?? testID}"]`)
    await Bun.sleep(30)
    assert.equal(
      await cdp.evaluate(`${panel}.getAnimations().filter(a => a.transitionProperty === 'transform').length`),
      0,
      "tab switching must not replay the slide",
    )
    await click(`[role="tab"][id="quick-assistant-tab-${testID}"]`)

    await cdp.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    })
    assert.equal(await cdp.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true)
    const reducedExit = await track(`${panel}.querySelector('[data-action="quick-assistant-hide"]').click()`)
    assert.ok(
      reducedExit.some((sample) => sample.x > 1 && sample.x < 300),
      "exit must still animate with reduced motion enabled",
    )
    assert.equal(await cdp.evaluate(`!!${panel}`), false, "exit must finish with reduced motion enabled")
    const reducedEntry = await track(`${launcher}.click()`)
    assert.ok(
      reducedEntry.some((sample) => sample.x > 1 && sample.x < 300),
      "entry must still animate with reduced motion enabled",
    )
    assert.ok(Math.abs(reducedEntry.at(-1)!.x) < 1, "reduced-motion entry must settle in place")
    console.log("[quick-motion-test] reduced motion enabled: entry and exit still animate")

    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await click(hide)
    await Bun.sleep(350)
    const compact = await track(`${launcher}.click()`)
    assert.ok(Math.max(...compact.map((sample) => sample.x)) > 100, "compact viewport must animate in")
    assert.ok(Math.abs(compact.at(-1)!.x) < 1, "compact entry must settle")
    assert.ok(compact.at(-1)!.tabs >= 0, "compact tabs must remain on screen")
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    console.log("[quick-motion-test] compact viewport passed")

    // Send through the actual sidecar, hide while streaming, and verify the response after reopening.
    const editor = '[data-component="quick-assistant-panel"]:not([hidden]) [contenteditable="true"]'
    await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`)
    await cdp.call("Input.insertText", { text: "Reply with exactly QUICK_MOTION_OK. Do not use tools." })
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-submit"]')
    await click(hide)
    await Bun.sleep(500)
    await click(show)
    const deadline = Date.now() + 90_000
    let received = false
    while (Date.now() < deadline) {
      received =
        await cdp.evaluate<boolean>(`[...${panel}.querySelectorAll('[data-component="quick-assistant-message"][data-role="assistant"]')]
        .some(el => el.textContent.includes('QUICK_MOTION_OK'))`)
      if (received) break
      await Bun.sleep(500)
    }
    assert.ok(received, "sidecar response must survive hiding and reopening")
    console.log("[quick-motion-test] sidecar reply verified: QUICK_MOTION_OK")
  } finally {
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await cdp.call("Emulation.setEmulatedMedia", { features: [] })
    if (testID) {
      if (!(await cdp.evaluate(`!!${panel}`))) {
        await click(show)
        await Bun.sleep(350)
      }
      await click(`[role="tab"][id="quick-assistant-tab-${testID}"]`)
      await click(`[id="quick-assistant-tab-${testID}"] ~ [data-action="quick-assistant-close-window"]`)
      await Bun.sleep(350)
    }
    if (
      initial.id &&
      (await cdp.evaluate(`!!document.getElementById(${JSON.stringify(`quick-assistant-tab-${initial.id}`)})`))
    ) {
      await click(`[role="tab"][id="quick-assistant-tab-${initial.id}"]`)
    }
    if (!initial.open && (await cdp.evaluate(`!!${panel}`))) await click(hide)
  }
})
