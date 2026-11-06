import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

const [directory, sourceID, targetID] = process.argv.slice(2)
assert.ok(
  directory && sourceID && targetID && sourceID !== targetID,
  "usage: bun test-session-warm-switch.ts <directory> <source-session> <target-session>",
)
const prefix = `/${Buffer.from(directory).toString("base64url")}/session/`
type Frame = { overlay: string; top: number; height: number; client: number; rows: number; pending: number }
type Profile = { sessionID: string; stage: string; detail?: string }
const runs: Array<{ frames: Frame[]; profiles: Profile[] }> = []

await withCdp(async (cdp, target) => {
  assert.ok(target.url.includes("localhost:5173"), "development renderer only")
  const navigate = (id: string) =>
    cdp.evaluate(`(() => {
    const a = document.createElement('a'); a.href = ${JSON.stringify(prefix)} + ${JSON.stringify(id)};
    document.body.append(a); a.click(); a.remove(); return true;
  })()`)
  const ready = async (id: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (
        await cdp.evaluate(`(() => {
        const page = document.querySelector('[data-component="session-page"]');
        return page?.dataset.sessionId === ${JSON.stringify(id)} && page.dataset.renderPhase === 'interactive'
          && !page.querySelector('[data-slot="session-render-overlay"]');
      })()`)
      )
        return
      await Bun.sleep(20)
    }
    throw new Error(`Session not ready: ${id}`)
  }
  await navigate(targetID)
  await ready(targetID)
  for (let index = 0; index < 5; index++) {
    await navigate(sourceID)
    await ready(sourceID)
    await cdp.evaluate(`(() => {
      window.__warmSwitchFrames = [];
      window.__warmSwitchStop = false;
      window.__opencodeSessionProfile?.clear();
      let previous;
      const frame = () => {
        if (window.__warmSwitchStop) return;
        const page = document.querySelector('[data-component="session-page"]');
        if (page?.dataset.sessionId === ${JSON.stringify(targetID)}) {
          const timeline = page.querySelector('[data-component="message-timeline"]');
          const root = timeline?.querySelector('[data-slot="scroll-view-viewport"]');
          const box = root?.getBoundingClientRect();
          const markdown = [...(root?.querySelectorAll('[data-component="markdown"]') ?? [])].filter(node => {
            const row = node.closest('[data-timeline-key]')?.getBoundingClientRect();
            return row && box && row.bottom > box.top && row.top < box.bottom;
          });
          const sample = { overlay: page.querySelector('[data-slot="session-render-overlay"]')?.dataset.state ?? 'hidden',
            top: Math.round(root?.scrollTop ?? 0), height: root?.scrollHeight ?? 0, client: root?.clientHeight ?? 0,
            rows: root?.querySelectorAll('[data-timeline-key]').length ?? 0,
            pending: markdown.filter(node => node.dataset.markdownRenderedStage !== 'full').length };
          const key = JSON.stringify(sample);
          if (key !== previous) window.__warmSwitchFrames.push(sample);
          previous = key;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame); return true;
    })()`)
    await navigate(targetID)
    await ready(targetID)
    await Bun.sleep(150)
    const run = await cdp.evaluate<{ frames: Frame[]; profiles: Profile[] }>(`(() => {
      window.__warmSwitchStop = true;
      return { frames: window.__warmSwitchFrames, profiles: window.__opencodeSessionProfile?.snapshot() ?? [] };
    })()`)
    runs.push(run)
    await Bun.write("/tmp/opencode-session-warm-switch.json", JSON.stringify(runs, null, 2))
    assert.ok(
      run.profiles.some((event) => event.sessionID === targetID && event.stage === "warm-layout-restored"),
      "must use the validated warm viewport path",
    )
    assert.ok(run.frames.length > 0, "must observe rendered frames")
    for (const frame of run.frames) {
      assert.equal(frame.overlay, "hidden", "warm return painted a loading overlay")
      assert.ok(frame.rows > 0 && frame.pending === 0, "warm return painted blank or incomplete content")
      assert.ok(Math.abs(frame.height - frame.client - frame.top) <= 1, "warm return did not start at the bottom")
    }
    const last = run.frames.at(-1)!
    assert.ok(
      run.frames.every((frame) => frame.height === last.height && Math.abs(frame.top - last.top) <= 1),
      "warm viewport shifted after reveal",
    )
    console.log(
      `[session-warm-switch] PASS run=${index + 1} frames=${run.frames.length} overlays=0 bottomGap=${last.height - last.client - last.top}`,
    )
  }
})
