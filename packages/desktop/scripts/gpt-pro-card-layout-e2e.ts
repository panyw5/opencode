import { fileURLToPath } from "node:url"
import { withCdp } from "./cdp"

// Run against an already-running development renderer, never the installed app.
const source = fileURLToPath(new URL("../../ui/src/components/gpt-pro-tool.tsx", import.meta.url))

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development Electron renderer")
  const result = await cdp.evaluate(`(async () => {
    const webURL = performance.getEntriesByType("resource").map(x => x.name).find(x => x.includes("/solid-js_web.js?"))
    if (!webURL) throw new Error("Solid runtime not loaded")
    const [web, component, shared] = await Promise.all([
      import(webURL), import(${JSON.stringify(`/@fs${source}`)}),
      import(${JSON.stringify(`/@fs${fileURLToPath(new URL("../../ui/src/components/gpt-pro-state.tsx", import.meta.url))}`)}),
    ])
    const jobs = await window.api.gptPro.list()
    const job = jobs.find(x => x.phase === "completed" && !x.attachments?.length)
    if (!job) throw new Error("A saved completed consultation without attachments is required")
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:80px 80px auto 80px;z-index:99999;background:var(--background-base);padding:12px"
    document.body.append(host)
    let dispose
    const sample = () => {
      const card = host.querySelector('[data-component="gpt-pro-tool"]')
      return {
        height: card.getBoundingClientRect().height,
        phase: card.dataset.phase,
        freshness: card.dataset.freshness,
        notice: !!host.querySelector('[data-component="gpt-pro-error-notice"]'),
        skeleton: !!host.querySelector('[data-tool-placeholder]'),
      }
    }
    const mount = (id) => {
      dispose = web.render(() => component.GptProTool({
        status: "completed", input: {},
        metadata: { consultation_id: id, phase: "paused", background: true, error: "connection timed out",
          recovery: { humanAction: "verification" }, stop_pending: true,
          attachments: [{ id: "old", name: "stale.txt", status: "failed", error: "Old attachment error" }] },
      }), host)
    }
    const passes = []
    try {
      for (let pass = 0; pass < 3; pass++) {
        mount(job.id)
        const frames = [sample()]
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame)
          frames.push(sample())
        }
        if (frames.some(x => x.height !== 50 || x.notice || x.skeleton))
          throw new Error("Card geometry changed: " + JSON.stringify(frames))
        if (frames.at(-1).phase !== "completed" || (pass > 0 && frames[0].phase !== "completed"))
          throw new Error("Verified status was not retained across remount")
        passes.push({ pass, samples: frames.length, heights: [...new Set(frames.map(x => x.height))] })
        dispose()
        dispose = undefined
      }
      // A failed lookup must not promote historical errors into live warnings.
      mount("gpt_layout_missing_" + Date.now())
      for (let i = 0; i < 120 && sample().freshness !== "unavailable"; i++)
        await new Promise(resolve => setTimeout(resolve, 25))
      if (sample().notice || sample().freshness !== "unavailable") throw new Error("Historical error promoted after failed lookup")
      host.querySelector('[data-testid="gpt-pro-history-toggle"]').click()
      if (!host.querySelector('[data-testid="gpt-pro-historical-record"]')) throw new Error("Historical record was lost")
      dispose(); dispose = undefined
      const saved = await window.api.gptPro.command({ action: "read", id: job.id })
      if (!saved.text?.trim()) throw new Error("Saved consultation answer was not received")

      const original = await window.api.gptPro.state.read(job.id)
      if (original.state.kind !== "execution") throw new Error("Expected a local execution snapshot for fixture seed")
      const initial = { ...original.state.job, id: "layout-one", owner: "/layout\\nfixture", parentID: null, successorID: null,
        stateVersion: 1, phase: "paused", error: "verification", errorCode: "verification",
        recovery: { stage: "ready", reason: "verify", humanAction: "verification" }, stopPending: true,
        attachments: [{ id: "live", name: "live.txt", mime: "text/plain", status: "failed", error: "Live upload failed" }] }
      let current = initial
      let sequence = 1
      let rows = [current]
      let listener
      let subscriptions = 0
      let delayed
      const snapshot = () => ({ type: "snapshot", sourceID: "layout-fixture", sequence, jobs: rows, removed: [] })
      const response = id => ({ sourceID: "layout-fixture", sequence, requestedID: id, state: { kind: "execution", job: current } })
      const fake = { ...window.api.gptPro,
        command: async () => { throw new Error("Unexpected renderer-test mutation") },
        state: {
          list: async () => snapshot(),
          read: async id => delayed ? new Promise(resolve => { delayed.resolve = resolve }) : response(id),
          subscribe: callback => { subscriptions++; listener = callback; callback(snapshot()); return () => { subscriptions--; listener = undefined } },
        },
      }
      const store = shared.gptProStateStore(fake)
      const roots = [document.createElement("div"), document.createElement("div")]
      roots.forEach(root => host.append(root))
      const off = roots.map(root => web.render(() => component.GptProTool({ client: fake, status: "completed", input: {},
        metadata: { consultation_id: "layout-one", phase: "paused", recovery: { humanAction: "verification" }, stop_pending: true,
          attachments: [{ id: "obsolete", name: "obsolete.txt", status: "failed", error: "Obsolete upload" }] },
      }), root))
      const settle = () => new Promise(resolve => setTimeout(resolve, 50))
      const cards = () => roots.map(root => root.querySelector('[data-component="gpt-pro-tool"]'))
      const publish = () => listener({ ...snapshot(), type: "change" })
      try {
        await settle()
        if (subscriptions !== 1 || cards().some(card => !card.querySelector('[data-component="gpt-pro-error-notice"]')))
          throw new Error("Live recovery or shared subscription missing")
        current = { ...current, stateVersion: 2, phase: "completed", error: null, errorCode: null, recovery: null, stopPending: false, attachments: [] }
        rows = [current]; sequence++; publish(); await settle()
        if (cards().some(card => card.dataset.phase !== "completed" || card.querySelector('[data-component="gpt-pro-error-notice"],[data-testid="gpt-pro-attachment"]')))
          throw new Error("Cleared state resurrected historical fields")
        const old = response("layout-one")
        delayed = {}
        const pending = store.refresh("layout-one")
        current = { ...current, stateVersion: 3, phase: "generating" }; rows = [current]; sequence++; publish()
        delayed.resolve(old); delayed = undefined; await pending; await settle()
        if (cards().some(card => card.dataset.phase !== "generating")) throw new Error("Late response overwrote newer event")
        const parent = { ...current, stateVersion: 4, phase: "completed", successorID: "layout-two" }
        current = { ...current, id: "layout-two", parentID: "layout-one", stateVersion: 1 }
        rows = [parent, current]; sequence++; publish(); await settle()
        if (cards().some(card => card.dataset.phase !== "generating")) throw new Error("Successor did not reach all cards")
        listener({ type: "disconnected", message: "offline" }); await settle()
        if (cards().some(card => card.dataset.freshness !== "stale" || card.querySelector('[data-icon="pause"],[data-icon="play"],[data-icon="stop"]')))
          throw new Error("Disconnected cards retained operation authority")
        listener(snapshot()); await settle()
        if (cards().some(card => card.dataset.freshness !== "current")) throw new Error("Snapshot reconnect failed")
      } finally {
        off.forEach(dispose => dispose()); roots.forEach(root => root.remove()); store.dispose()
      }
      if (subscriptions !== 0) throw new Error("State subscription leaked after unmount")
      return { job: job.id, passes, unavailableStayedHistorical: true, receivedAnswerChars: saved.text.length,
        sharedSubscription: true, clearedFields: true, staleResponseFenced: true, successorSynchronized: true, reconnect: true }
    } finally {
      dispose?.()
      host.remove()
    }
  })()`)
  console.log(`[gpt-pro-layout-e2e] ${JSON.stringify(result)}`)
})
