import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const [directory, a, b] = process.argv.slice(2)
assert.ok(directory && a && b && a !== b, "usage: bun test-session-lifecycle.ts <directory> <session-a> <session-b>")
const prefix = `/${Buffer.from(directory).toString("base64url")}/session/`
const timelineFile = resolve(import.meta.dir, "../../app/src/pages/session/timeline/message-timeline.tsx")
const report: Array<{ name: string; state: State; frames?: State[] }> = []
type State = {
  sid?: string
  phase?: string
  overlay: string
  intent?: string
  top: number
  height: number
  client: number
  rows: number
}

await withCdp(async (cdp, target) => {
  assert.ok(target.url.includes("localhost:5173"), "development renderer only")
  let temporarySession: string | undefined
  const request = (path: string, method = "GET", body?: unknown) =>
    cdp.evaluate<unknown>(`(async () => {
    const server = await window.api.awaitInitialization();
    const response = await fetch(server.url + ${JSON.stringify(path)} + '?directory=' + encodeURIComponent(${JSON.stringify(directory)}), {
      method: ${JSON.stringify(method)},
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(server.username + ':' + server.password) },
      body: ${body === undefined ? "undefined" : `JSON.stringify(${JSON.stringify(body)})`}
    });
    if (!response.ok) throw new Error('sidecar ' + response.status);
    return response.status === 204 ? null : response.json();
  })()`)
  const read = () =>
    cdp.evaluate<State>(`(() => {
    const page = document.querySelector('[data-component="session-page"]');
    const timeline = page?.querySelector('[data-component="message-timeline"]');
    const root = timeline?.querySelector('[data-slot="scroll-view-viewport"]');
    return { sid: page?.dataset.sessionId, phase: page?.dataset.renderPhase,
      overlay: page?.querySelector('[data-slot="session-render-overlay"]')?.dataset.state ?? 'hidden',
      intent: timeline?.dataset.viewportIntent, top: root?.scrollTop ?? 0, height: root?.scrollHeight ?? 0,
      client: root?.clientHeight ?? 0, rows: timeline?.querySelectorAll('[data-timeline-key]').length ?? 0 };
  })()`)
  const wait = async (predicate: (state: State) => boolean, label: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        const state = await read()
        if (predicate(state)) return state
      } catch {}
      await Bun.sleep(30)
    }
    throw new Error(`Timeout: ${label}`)
  }
  const ready = (id: string) =>
    wait((s) => s.sid === id && s.phase === "interactive" && s.overlay === "hidden", `ready ${id}`)
  const bottom = (s: State) => s.client > 0 && Math.abs(s.height - s.client - s.top) <= 1
  const navigate = (id: string, hash = "") =>
    cdp.evaluate(`(() => {
    const link = document.createElement('a'); link.href = ${JSON.stringify(prefix)} + ${JSON.stringify(id + hash)};
    document.body.append(link); link.click(); link.remove(); return true;
  })()`)
  const begin = () =>
    cdp.evaluate(`(() => {
    window.__lifecycleStop = true;
    window.__lifecycleFrames = [];
    const run = {};
    window.__lifecycleRun = run;
    let previous;
    const frame = () => {
      if (window.__lifecycleRun !== run) return;
      const page = document.querySelector('[data-component="session-page"]');
      const timeline = page?.querySelector('[data-component="message-timeline"]');
      const root = timeline?.querySelector('[data-slot="scroll-view-viewport"]');
      const state = { sid: page?.dataset.sessionId, phase: page?.dataset.renderPhase,
        overlay: page?.querySelector('[data-slot="session-render-overlay"]')?.dataset.state ?? 'hidden',
        intent: timeline?.dataset.viewportIntent, top: root?.scrollTop ?? 0, height: root?.scrollHeight ?? 0,
        client: root?.clientHeight ?? 0, rows: root?.querySelectorAll('[data-timeline-key]').length ?? 0 };
      const key = JSON.stringify(state);
      if (key !== previous) window.__lifecycleFrames.push(state);
      previous = key;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame); return true;
  })()`)
  const finish = async (name: string, id = a, requireBottom = true, covered = false) => {
    await ready(id)
    if (requireBottom) await wait((s) => s.sid === id && bottom(s), `bottom ${name}`)
    await Bun.sleep(150)
    const state = await read()
    const frames = await cdp.evaluate<State[]>("window.__lifecycleRun = null; window.__lifecycleFrames ?? []")
    report.push({ name, state, frames })
    if (covered) {
      assert.ok(
        frames.some((s) => s.sid === id && s.overlay === "showing"),
        `${name}: missing remount overlay`,
      )
      const start = frames.findIndex((s) => s.sid === id && s.overlay === "showing")
      for (const sample of frames.slice(start).filter((s) => s.sid === id && s.overlay !== "showing")) {
        assert.ok(sample.rows > 0, `${name}: exposed an empty viewport`)
        if (requireBottom) assert.ok(bottom(sample), `${name}: exposed the wrong scroll position`)
      }
    }
    console.log(
      `[session-lifecycle] PASS name=${name} intent=${state.intent} top=${Math.round(state.top)} gap=${Math.round(state.height - state.client - state.top)}`,
    )
    return state
  }
  const reload = async () => {
    const origin = await cdp.evaluate<number>("performance.timeOrigin")
    await cdp.call("Page.reload", { ignoreCache: true })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        if ((await cdp.evaluate("performance.timeOrigin")) !== origin) return
      } catch {}
      await Bun.sleep(25)
    }
    throw new Error("Renderer did not reload")
  }
  const hot = async () => {
    await cdp.evaluate(
      "window.__lifecycleOldRoot = document.querySelector('[data-component=message-timeline] [data-slot=scroll-view-viewport]'); true",
    )
    // Timestamp-only invalidation exercises real Vite HMR without changing source content.
    assert.equal(await Bun.spawn(["touch", timelineFile], { stdout: "ignore", stderr: "inherit" }).exited, 0)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (
        await cdp.evaluate(
          "document.querySelector('[data-component=message-timeline] [data-slot=scroll-view-viewport]') !== window.__lifecycleOldRoot",
        )
      )
        return
      await Bun.sleep(30)
    }
    throw new Error("Timeline HMR did not replace its viewport")
  }
  try {
    await navigate(a)
    await ready(a)
    await reload()
    await ready(a)
    await finish("cold-renderer-reload")
    await begin()
    await navigate(b)
    await finish("warm-switch-b", b, true, true)
    await begin()
    await navigate(a)
    await finish("warm-return-a", a, true, true)
    await begin()
    for (const id of [b, a, b, a]) {
      await navigate(id)
      await Bun.sleep(20)
    }
    await finish("rapid-a-b-a", a, true, true)
    await begin()
    await hot()
    await finish("timeline-hot-reload-bottom", a, true, true)

    const geometry = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const box = document.querySelector('[data-component="message-timeline"] [data-slot="scroll-view-viewport"]').getBoundingClientRect();
      return { x: box.right - 100, y: box.top + box.height / 2 };
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...geometry, deltaX: 0, deltaY: -500 })
    await wait((s) => s.intent === "reading" && !bottom(s), "reading takeover")
    await Bun.sleep(300)
    const reading = await read()
    await begin()
    await hot()
    const restored = await finish("timeline-hot-reload-reading", a, false, true)
    assert.ok(Math.abs(restored.top - reading.top) <= 2, "hot reload lost the reading viewport")
    assert.equal(restored.intent, "reading")

    await navigate(b)
    await ready(b)
    await navigate(a)
    await ready(a)
    for (const width of [1000, 1600]) {
      await begin()
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      await finish(`resize-${width}`)
    }
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await wait(bottom, "restored window bottom")

    const prefetchModule = `/@fs${resolve(import.meta.dir, "../../app/src/context/global-sync/session-prefetch.ts")}`
    await cdp.evaluate(
      `import(${JSON.stringify(prefetchModule)}).then(module => module.clearSessionPrefetch(${JSON.stringify(directory)}, [${JSON.stringify(a)}]))`,
    )
    await navigate(b)
    await ready(b)
    await begin()
    await navigate(a)
    await finish("message-cache-without-prefetch-metadata", a, true, true)

    const ids = await cdp.evaluate<string[]>(`(async () => {
      const server = await window.api.awaitInitialization();
      const r = await fetch(server.url + '/session/' + ${JSON.stringify(a)} + '/message?limit=80&directory=' + encodeURIComponent(${JSON.stringify(directory)}),
        { headers: { Authorization: 'Basic ' + btoa(server.username + ':' + server.password) } });
      if (!r.ok) throw new Error('message index ' + r.status);
      return (await r.json()).filter(m => m.info.role === 'user').map(m => m.info.id);
    })()`)
    assert.ok(ids.length > 2, "hash-navigation fixture needs several turns")
    const hash = `#message-${ids[0]}`
    await navigate(a, hash)
    await wait((s) => s.intent === "message" && s.phase === "interactive" && !bottom(s), "message hash seek")
    await Bun.sleep(250)
    const selected = await read()
    report.push({ name: "message-hash", state: selected })
    await reload()
    await ready(a)
    const reloaded = await finish("cold-reload-with-message-hash", a, false)
    assert.equal(reloaded.intent, "message")
    assert.ok(!bottom(reloaded), "initial bottom positioning overrode the message hash")
    assert.ok(Math.abs(reloaded.top - selected.top) <= 2, "hash reload did not restore the selected message")
    await navigate(b)
    await ready(b)
    await navigate(a)
    await ready(a)
    await begin()
    // Exercise the renderer's real reconnect/reset path without restarting any app or sidecar.
    await cdp.evaluate("window.dispatchEvent(new Event('opencode:backend-reloaded')); true")
    await finish("backend-connection-cache-reset", a, true, true)
    const temporary = (await request("/session", "POST", { title: "Temporary session lifecycle smoke test" })) as {
      id: string
    }
    temporarySession = temporary.id
    await navigate(temporary.id)
    const empty = await finish("empty-session", temporary.id)
    assert.equal(empty.rows, 0)
    console.log(`[session-lifecycle] sidecar send session=${temporary.id}`)
    await request(`/session/${temporary.id}/shell`, "POST", { agent: "build", command: "printf SESSION_LIFECYCLE_OK" })
    const messages = (await request(`/session/${temporary.id}/message`)) as Array<{
      info: { role: string }
      parts: Array<{ type: string; state?: { status: string; output?: string } }>
    }>
    const sent = messages.some((message) => message.info.role === "user")
    const received = messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.parts.some(
          (part) =>
            part.type === "tool" &&
            part.state?.status === "completed" &&
            part.state.output?.includes("SESSION_LIFECYCLE_OK"),
        ),
    )
    assert.ok(sent && received, "sidecar must persist sent and received messages")
    await wait((state) => state.sid === temporary.id && state.rows > 0, "received message rendered")
    await finish("empty-session-to-messages", temporary.id)
    console.log(`[session-lifecycle] sidecar receipt sent=${sent} received=${received}`)
  } finally {
    await cdp.evaluate("window.__lifecycleRun = null; true").catch(() => {})
    await cdp.call("Emulation.clearDeviceMetricsOverride").catch(() => {})
    await Bun.write("/tmp/opencode-session-lifecycle.json", JSON.stringify(report, null, 2))
    await navigate(a).catch(() => {})
    if (temporarySession) {
      await request(`/session/${temporarySession}`, "DELETE")
      console.log(`[session-lifecycle] cleaned temporary session=${temporarySession}`)
    }
  }
})
