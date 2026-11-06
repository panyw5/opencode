import { strict as assert } from "node:assert"
import { CdpClient, listTargets } from "./cdp.ts"

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
  const version = (await (await fetch(`${endpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string }
  const browser = await CdpClient.connect(version.webSocketDebuggerUrl)
  let targetId: string | undefined
  let page: CdpClient | undefined
  try {
    const target = await browser.call<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
    targetId = target.targetId
    const info = (await listTargets(endpoint)).find((item) => item.id === targetId)
    assert.ok(info)
    page = await CdpClient.connect(info.webSocketDebuggerUrl)
    await page.call("Page.navigate", { url: process.env.OPENCODE_QUICK_SCROLL_URL ?? "http://localhost:4444" })
    await page.call("Page.bringToFront")
    await page.evaluate(
      "new Promise(resolve=>document.readyState==='complete'?resolve():addEventListener('load',resolve,{once:true}))",
    )
    await runScrollChecks(page)
  } finally {
    page?.close()
    if (targetId) await browser.call("Target.closeTarget", { targetId })
    browser.close()
  }
}
if (import.meta.main) await main()
