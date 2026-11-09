import { strict as assert } from "node:assert"
import { withCdp, type CdpClient } from "./cdp.ts"

const fixtureURL = `/@fs${new URL("quick-assistant-scroll-fixture.tsx", import.meta.url).pathname}`
type Driver = Pick<CdpClient, "evaluate" | "call">
type Geometry = { top: number; gap: number; height: number; ticks: number; mode: string; x: number; y: number }
const inspect = (cdp: Driver) =>
  cdp.evaluate<Geometry>(`(() => {
  const v=document.querySelector('[data-quick-scroll-fixture] [data-component="quick-assistant-viewport"]');
  const b=v.getBoundingClientRect();
  return {top:v.scrollTop,gap:v.scrollHeight-v.clientHeight-v.scrollTop,height:v.scrollHeight,
    ticks:window.fixture.ticks(),mode:window.fixture.mode(),x:b.x+b.width/2,y:b.y+b.height/2};
})()`)
async function until(cdp: Driver, name: string, accept: (value: Geometry) => boolean) {
  const deadline = Date.now() + 15_000
  let last: Geometry | undefined
  while (Date.now() < deadline) {
    last = await inspect(cdp)
    if (accept(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${name}: ${JSON.stringify(last)}`)
}
async function wheel(cdp: Driver, deltaY: number) {
  const { x, y } = await inspect(cdp)
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY })
}
export async function runScrollChecks(cdp: Driver, moduleURL = fixtureURL) {
  await cdp.evaluate(`(async () => {
    window.fixture?.dispose();
    const module=await import(${JSON.stringify(moduleURL)});
    window.fixture=module.mountQuickAssistantScrollFixture({width:520});
    await new Promise(resolve=>requestAnimationFrame(resolve));
  })()`)
  try {
    await until(cdp, "initial bottom", (v) => v.height > 2000 && v.gap <= 1)
    await wheel(cdp, -360)
    await until(cdp, "initial reading", (v) => v.mode === "reading" && v.gap > 100)
    const native = await cdp.evaluate<{ wanted: number; actual: number }>(`(async () => {
      const view=document.querySelector('[data-quick-scroll-fixture] [data-component="quick-assistant-viewport"]');
      view.dispatchEvent(new Event('scrollend'));
      const wanted=view.scrollTop-100;
      view.scrollTop=wanted;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {wanted,actual:view.scrollTop};
    })()`)
    assert.ok(Math.abs(native.actual - native.wanted) <= 1, "native motion without provenance must not be undone")
    console.log("[quick-scroll] PASS native motion after scrollend")
    await cdp.evaluate(`(() => {
      window.fixture.resume();
      const block=document.querySelector('[data-quick-scroll-fixture] [data-role="assistant"] p');
      const text=[...block.childNodes].find(node=>node.nodeType===Node.TEXT_NODE && node.length>5);
      const range=document.createRange();range.setStart(text,0);range.setEnd(text,5);
      getSelection().removeAllRanges();getSelection().addRange(range);
    })()`)
    await until(cdp, "selection takeover before mouseup", (v) => v.mode === "reading")
    await cdp.evaluate("getSelection().removeAllRanges(); true")
    console.log("[quick-scroll] PASS selection takeover before mouseup")
    for (const delta of [-360, -1, -4]) {
      await cdp.evaluate("window.fixture.resume(); window.fixture.stream(200, 600); true")
      const start = await inspect(cdp)
      const initial = await until(cdp, "live output", (v) => v.ticks >= 4 && v.mode === "live" && v.top > start.top)
      await wheel(cdp, delta)
      const detached = await until(cdp, "upward takeover", (v) => v.mode === "reading" && v.gap > 0)
      const held = await until(cdp, "continued output while reading", (v) => {
        assert.equal(v.mode, "reading", "output must not steal viewport ownership")
        return v.ticks >= detached.ticks + 5
      })
      assert.ok(held.gap > initial.gap, "the tail must grow away from the reader")
      await cdp.evaluate("window.fixture.visible(false); true")
      await cdp.evaluate("window.fixture.visible(true); true")
      assert.equal((await inspect(cdp)).mode, "reading")
      // Use multiple real downward gestures, as a user does while output grows.
      for (let attempt = 0; attempt < 8; attempt++) {
        await wheel(cdp, 10_000)
        await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
        if ((await inspect(cdp)).mode === "live") break
      }
      await until(cdp, "downward return", (v) => v.mode === "live")
      await cdp.evaluate("window.fixture.stop(); true")
      await until(cdp, "settled bottom", (v) => v.mode === "live" && v.gap <= 1)
      console.log(`[quick-scroll] PASS wheel=${delta} ticks=${held.ticks} readingGap=${held.gap}`)
    }
    await cdp.evaluate("window.fixture.visible(false); window.fixture.append(11); window.fixture.visible(true); true")
    await until(cdp, "hidden live reveal", (v) => v.mode === "live" && v.gap <= 1)
    console.log("[quick-scroll] PASS lifecycle and continuous streaming")
  } finally {
    await cdp.evaluate("window.fixture?.dispose(); delete window.fixture")
  }
}

async function main() {
  const endpoint = process.env.OPENCODE_CDP_ENDPOINT ?? "http://127.0.0.1:9222"
  await withCdp(async (page, target) => {
    assert.match(target.url, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//)
    await page.call("Page.bringToFront")
    await runScrollChecks(page)
  }, endpoint)
}
if (import.meta.main) await main()
