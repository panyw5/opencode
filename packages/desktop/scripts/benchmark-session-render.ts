import { writeFile } from "node:fs/promises"

type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

type CdpResponse = {
  id?: number
  result?: unknown
  error?: { message: string }
}

type Scenario = "warm" | "cold" | "uncached" | "minimized" | "frozen"

type Options = {
  endpoint: string
  repeat: number
  timeoutMs: number
  settleMs: number
  scenarios: Scenario[]
  sessions: string[]
  output?: string
}

type Snapshot = {
  active?: string
  readyState: string
  timeline: boolean
  rows: number
  viewportVisible: boolean
  overlay: boolean
  overlayBlocking: boolean
  overlayState?: string
  renderPhase?: string
  requestCount: number
  components: Record<string, number>
}

type Sample = {
  scenario: Scenario
  sessionID: string
  iteration: number
  durationMs: number
  activeMs?: number
  timelineMs?: number
  viewportMs?: number
  dataReadyMs?: number
  readyToVisibleMs?: number
  overlayRemovedMs?: number
  requestCount: number
  overlaySeen: boolean
  timedOut: boolean
  error?: string
  components: Record<string, number>
}

const benchmarkSessions = [
  "ses_ffe5f848f7791ffeDyq9Ap0NmZ",
  "ses_ffe5fb7c2448bffeYWKGpHVzxT",
  "ses_ffe5f84ab891cffeNap0D4Xwxr",
]

const defaults: Options = {
  endpoint: "http://127.0.0.1:9222",
  repeat: 5,
  timeoutMs: 15_000,
  settleMs: 300,
  scenarios: ["cold", "uncached", "warm", "minimized", "frozen"],
  sessions: benchmarkSessions,
}

function usage() {
  return [
    "Benchmark session content visibility in the already-running development Electron app.",
    "",
    "Usage: bun packages/desktop/scripts/benchmark-session-render.ts [options]",
    "   or: node --experimental-strip-types packages/desktop/scripts/benchmark-session-render.ts [options]",
    "",
    "Options:",
    "  --scenario <all|cold,uncached,warm,minimized,frozen>",
    "  --repeat <count>          Samples per session and scenario (default: 5)",
    "  --sessions <id,id,...>   Session tabs that must already be open",
    "  --timeout-ms <ms>        Per-sample content deadline (default: 15000)",
    "  --settle-ms <ms>         Delay between samples (default: 300)",
    "  --endpoint <url>         CDP endpoint (default: http://127.0.0.1:9222)",
    "  --output <path>          Also write the JSON report to this path",
  ].join("\n")
}

function positiveInteger(flag: string, value: string | undefined) {
  const result = Number(value)
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${flag} must be a positive integer`)
  return result
}

function parseOptions(args: string[]): Options | undefined {
  const options = { ...defaults, scenarios: [...defaults.scenarios], sessions: [...defaults.sessions] }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--help" || flag === "-h") return
    const value = args[++index]
    if (flag === "--endpoint") options.endpoint = value ?? ""
    else if (flag === "--repeat") options.repeat = positiveInteger(flag, value)
    else if (flag === "--timeout-ms") options.timeoutMs = positiveInteger(flag, value)
    else if (flag === "--settle-ms") options.settleMs = positiveInteger(flag, value)
    else if (flag === "--output") options.output = value
    else if (flag === "--sessions") options.sessions = (value ?? "").split(",").filter(Boolean)
    else if (flag === "--scenario") {
      const values = value === "all" ? defaults.scenarios : ((value ?? "").split(",") as Scenario[])
      const invalid = values.find((item) => !defaults.scenarios.includes(item))
      if (invalid) throw new Error(`Unknown scenario: ${invalid}`)
      options.scenarios = values
    } else throw new Error(`Unknown option: ${flag}`)
  }
  if (options.sessions.length < 2) throw new Error("At least two session IDs are required")
  return options
}

class CdpClient {
  private nextID = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (!callback) return
      this.pending.delete(message.id)
      if (message.error) callback.reject(new Error(message.error.message))
      else callback.resolve(message.result)
    })
    socket.addEventListener("close", () => {
      for (const callback of this.pending.values()) callback.reject(new Error("CDP connection closed"))
      this.pending.clear()
    })
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true })
    })
    return new CdpClient(socket)
  }

  call<T>(method: string, params: Record<string, unknown> = {}) {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextID++
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string) {
    const response = await this.call<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    )
    if (response.exceptionDetails) throw new Error(response.result.description ?? "Renderer evaluation failed")
    return response.result.value as T
  }

  close() {
    this.socket.close()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function round(value: number) {
  return Math.round(value * 10) / 10
}

function quantile(values: number[], ratio: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return round(sorted[index] ?? 0)
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  }
}

const snapshotExpression = (sessionID: string) => `(() => {
  const id = ${JSON.stringify(sessionID)}
  const active = document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId
  const virtual = document.querySelector('[data-timeline-virtual-content]')
  const timeline = document.querySelector('[data-component="message-timeline"]') ?? virtual?.parentElement?.parentElement
  const viewport = virtual?.closest('[data-slot="scroll-view-viewport"]')
  const overlay = document.querySelector('[data-slot="session-render-overlay"]')
  const overlayStyle = overlay ? getComputedStyle(overlay) : undefined
  const overlayBlocking = !!overlay && overlayStyle?.display !== 'none' && overlayStyle?.visibility !== 'hidden' && Number(overlayStyle?.opacity ?? 1) > 0.05
  const profile = window.__opencodeComponentMountProfile?.snapshot?.() ?? {}
  return {
    active,
    readyState: document.readyState,
    timeline: !!timeline,
    rows: document.querySelectorAll('[data-timeline-virtual-content] > div[data-index]').length,
    viewportVisible: !!viewport && getComputedStyle(viewport).visibility !== 'hidden' && viewport.getBoundingClientRect().height > 0,
    overlay: !!overlay,
    overlayBlocking,
    overlayState: overlay?.getAttribute('data-state') ?? overlay?.getAttribute('aria-busy') ?? undefined,
    renderPhase: document.querySelector('[data-component="session-page"]')?.getAttribute('data-render-phase') ?? undefined,
    requestCount: performance.getEntriesByType('resource').filter((entry) => entry.name.includes(id)).length,
    components: {
      timeline: document.querySelectorAll('[data-component="message-timeline"]').length || (virtual ? 1 : 0),
      prompt: document.querySelectorAll('[data-component="prompt-input"]').length,
      status: document.querySelectorAll('[data-component="session-status-float"]').length,
      desktopSidebar: document.querySelectorAll('[data-component="sidebar-nav-desktop"]').length,
      mobileSidebar: document.querySelectorAll('[data-component="sidebar-nav-mobile"]').length,
      registryActive: Object.values(profile).reduce((sum, item) => sum + (item.active ?? 0), 0),
    },
  }
})()`

async function waitForContent(cdp: CdpClient, sessionID: string, timeoutMs: number, started: number) {
  let activeMs: number | undefined
  let timelineMs: number | undefined
  let viewportMs: number | undefined
  let dataReadyMs: number | undefined
  let overlayRemovedMs: number | undefined
  let overlaySeen = false
  let last: Snapshot | undefined
  while (performance.now() - started < timeoutMs) {
    try {
      last = await cdp.evaluate<Snapshot>(snapshotExpression(sessionID))
    } catch {
      await sleep(10)
      continue
    }
    const elapsed = performance.now() - started
    if (last.active === sessionID && activeMs === undefined) activeMs = elapsed
    if (last.active === sessionID && last.timeline && timelineMs === undefined) timelineMs = elapsed
    if (last.active === sessionID && last.viewportVisible && viewportMs === undefined) viewportMs = elapsed
    if (
      last.active === sessionID &&
      last.renderPhase !== undefined &&
      last.renderPhase !== "unresolved" &&
      last.renderPhase !== "fetching" &&
      dataReadyMs === undefined
    )
      dataReadyMs = elapsed
    if (last.overlay) overlaySeen = true
    if (last.active === sessionID && !last.overlayBlocking && overlayRemovedMs === undefined) overlayRemovedMs = elapsed
    if (last.active === sessionID && last.timeline && last.viewportVisible && !last.overlayBlocking) {
      return {
        durationMs: elapsed,
        activeMs,
        timelineMs,
        viewportMs,
        dataReadyMs,
        overlayRemovedMs,
        overlaySeen,
        last,
        timedOut: false,
      }
    }
    await sleep(10)
  }
  return {
    durationMs: performance.now() - started,
    activeMs,
    timelineMs,
    viewportMs,
    dataReadyMs,
    overlayRemovedMs,
    overlaySeen,
    last: last ?? ({ requestCount: 0, components: {} } as Snapshot),
    timedOut: true,
  }
}

async function clickSession(cdp: CdpClient, sessionID: string) {
  const started = performance.now()
  while (performance.now() - started < 10_000) {
    const clickedAt = performance.now()
    const clicked = await cdp.evaluate<boolean>(`(() => {
      const id = ${JSON.stringify(sessionID)}
      const tab = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
        .find((item) => item.dataset.sessionId === id)
      if (!tab) return false
      performance.clearResourceTimings()
      tab.click()
      return true
    })()`)
    if (clicked) return clickedAt
    await sleep(20)
  }
  return undefined
}

async function ensureActive(cdp: CdpClient, sessionID: string, timeoutMs: number) {
  if ((await clickSession(cdp, sessionID)) === undefined) throw new Error(`Session tab is not open: ${sessionID}`)
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    try {
      const active = await cdp.evaluate<string | undefined>(
        `document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId`,
      )
      if (active === sessionID) return
    } catch {}
    await sleep(10)
  }
  throw new Error(`Timed out selecting session ${sessionID}`)
}

async function waitForTabs(cdp: CdpClient, sessions: string[], timeoutMs: number) {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    try {
      const found = await cdp.evaluate<string[]>(
        `[...document.querySelectorAll('[data-component="session-tab"][data-session-id]')].map((item) => item.dataset.sessionId)`,
      )
      if (sessions.every((id) => found.includes(id))) return
    } catch {}
    await sleep(20)
  }
  throw new Error(`Timed out waiting for session tabs: ${sessions.join(", ")}`)
}

async function sample(
  cdp: CdpClient,
  options: Options,
  scenario: Scenario,
  sessionID: string,
  iteration: number,
  previousID: string,
): Promise<Sample> {
  await ensureActive(cdp, previousID, options.timeoutMs)
  await sleep(options.settleMs)

  if (scenario === "cold" || scenario === "uncached") {
    const started = performance.now()
    await cdp.call("Page.reload", { ignoreCache: true })
    await waitForTabs(cdp, options.sessions, options.timeoutMs)
    if (scenario === "cold") {
      const result = await waitForContent(cdp, previousID, options.timeoutMs, started)
      return {
        scenario,
        sessionID: previousID,
        iteration,
        durationMs: round(result.durationMs),
        activeMs: result.activeMs === undefined ? undefined : round(result.activeMs),
        timelineMs: result.timelineMs === undefined ? undefined : round(result.timelineMs),
        viewportMs: result.viewportMs === undefined ? undefined : round(result.viewportMs),
        dataReadyMs: result.dataReadyMs === undefined ? undefined : round(result.dataReadyMs),
        readyToVisibleMs:
          result.dataReadyMs === undefined ? undefined : round(Math.max(0, result.durationMs - result.dataReadyMs)),
        overlayRemovedMs: result.overlayRemovedMs === undefined ? undefined : round(result.overlayRemovedMs),
        requestCount: result.last.requestCount,
        overlaySeen: result.overlaySeen,
        timedOut: result.timedOut,
        components: result.last.components,
      }
    }
    await sleep(250)
  }

  if (scenario === "frozen") {
    await cdp.evaluate(`(() => {
      window.__opencodeBenchmarkOriginalRAF ??= window.requestAnimationFrame
      window.__opencodeBenchmarkOriginalCancelRAF ??= window.cancelAnimationFrame
      let sequence = 0
      const pending = new Set()
      window.requestAnimationFrame = () => { const id = ++sequence; pending.add(id); return id }
      window.cancelAnimationFrame = (id) => pending.delete(id)
    })()`)
  }
  if (scenario === "minimized") {
    const minimized = await cdp.evaluate<boolean>(`(async () => {
      if (!window.api?.runDesktopMenuAction) return false
      await window.api.runDesktopMenuAction('window.minimize')
      return true
    })()`)
    if (!minimized) throw new Error("The minimized scenario requires the Electron desktop API")
    await sleep(100)
  }

  let result: Awaited<ReturnType<typeof waitForContent>>
  try {
    const started = await clickSession(cdp, sessionID)
    if (started === undefined) throw new Error(`Session tab is not open: ${sessionID}`)
    result = await waitForContent(cdp, sessionID, options.timeoutMs, started)
  } finally {
    if (scenario === "frozen") {
      await cdp.evaluate(`(() => {
        if (window.__opencodeBenchmarkOriginalRAF) window.requestAnimationFrame = window.__opencodeBenchmarkOriginalRAF
        if (window.__opencodeBenchmarkOriginalCancelRAF) window.cancelAnimationFrame = window.__opencodeBenchmarkOriginalCancelRAF
        delete window.__opencodeBenchmarkOriginalRAF
        delete window.__opencodeBenchmarkOriginalCancelRAF
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })()`)
    }
    if (scenario === "minimized") {
      await cdp.evaluate(`(async () => {
        await window.api?.showWindow?.()
        await window.api?.setWindowFocus?.()
      })()`)
      await sleep(100)
    }
  }

  return {
    scenario,
    sessionID,
    iteration,
    durationMs: round(result.durationMs),
    activeMs: result.activeMs === undefined ? undefined : round(result.activeMs),
    timelineMs: result.timelineMs === undefined ? undefined : round(result.timelineMs),
    viewportMs: result.viewportMs === undefined ? undefined : round(result.viewportMs),
    dataReadyMs: result.dataReadyMs === undefined ? undefined : round(result.dataReadyMs),
    readyToVisibleMs:
      result.dataReadyMs === undefined ? undefined : round(Math.max(0, result.durationMs - result.dataReadyMs)),
    overlayRemovedMs: result.overlayRemovedMs === undefined ? undefined : round(result.overlayRemovedMs),
    requestCount: result.last.requestCount,
    overlaySeen: result.overlaySeen,
    timedOut: result.timedOut,
    components: result.last.components,
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return
  }
  const response = await fetch(`${options.endpoint}/json/list`)
  if (!response.ok) throw new Error(`CDP target request failed: ${response.status}`)
  const targets = (await response.json()) as CdpTarget[]
  const target = targets.find(
    (item) => item.type === "page" && (item.url.startsWith("http") || item.url.startsWith("oc://")),
  )
  if (!target) throw new Error("Development Electron renderer target was not found")

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  try {
    await cdp.call("Page.enable")
    await waitForTabs(cdp, options.sessions, options.timeoutMs)
    const samples: Sample[] = []
    for (const scenario of options.scenarios) {
      for (let iteration = 1; iteration <= options.repeat; iteration++) {
        for (let index = 0; index < options.sessions.length; index++) {
          const sessionID = options.sessions[index]!
          const previousID = options.sessions[(index + options.sessions.length - 1) % options.sessions.length]!
          console.error(
            `[session-render-benchmark] scenario=${scenario} iteration=${iteration} sid=${sessionID} stage=start`,
          )
          const result = await sample(cdp, options, scenario, sessionID, iteration, previousID).catch(
            (error): Sample => ({
              scenario,
              sessionID,
              iteration,
              durationMs: options.timeoutMs,
              requestCount: 0,
              overlaySeen: false,
              timedOut: true,
              error: error instanceof Error ? error.message : String(error),
              components: {},
            }),
          )
          samples.push(result)
          console.error(
            `[session-render-benchmark] scenario=${scenario} iteration=${iteration} sid=${result.sessionID} stage=end visible_ms=${result.durationMs} overlay=${String(result.overlaySeen)} requests=${result.requestCount} timeout=${String(result.timedOut)}`,
          )
          await sleep(options.settleMs)
        }
      }
    }

    const summary = Object.fromEntries(
      options.scenarios.map((scenario) => {
        const entries = samples.filter((item) => item.scenario === scenario)
        const cacheAware = scenario === "warm" || scenario === "minimized" || scenario === "frozen"
        return [
          scenario,
          {
            visibleMs: summarize(entries.filter((item) => !item.timedOut).map((item) => item.durationMs)),
            activeMs: summarize(entries.flatMap((item) => (item.activeMs === undefined ? [] : [item.activeMs]))),
            timelineMs: summarize(entries.flatMap((item) => (item.timelineMs === undefined ? [] : [item.timelineMs]))),
            viewportMs: summarize(entries.flatMap((item) => (item.viewportMs === undefined ? [] : [item.viewportMs]))),
            readyToVisibleMs: summarize(
              entries.flatMap((item) => (item.readyToVisibleMs === undefined ? [] : [item.readyToVisibleMs])),
            ),
            cachedVisibleMs: summarize(
              cacheAware
                ? entries.filter((item) => item.requestCount === 0 && !item.timedOut).map((item) => item.durationMs)
                : [],
            ),
            overlaySamples: entries.filter((item) => item.overlaySeen).length,
            cachedOverlaySamples: cacheAware
              ? entries.filter((item) => item.requestCount === 0 && item.overlaySeen).length
              : 0,
            timeouts: entries.filter((item) => item.timedOut).length,
            requestCount: entries.reduce((sum, item) => sum + item.requestCount, 0),
          },
        ]
      }),
    )
    const bySession = Object.fromEntries(
      options.sessions.map((sessionID) => [
        sessionID,
        Object.fromEntries(
          options.scenarios.map((scenario) => [
            scenario,
            summarize(
              samples
                .filter((item) => item.sessionID === sessionID && item.scenario === scenario && !item.timedOut)
                .map((item) => item.durationMs),
            ),
          ]),
        ),
      ]),
    )
    const report = {
      generatedAt: new Date().toISOString(),
      target: { title: target.title, url: target.url },
      options,
      summary,
      bySession,
      samples,
    }
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (options.output) await writeFile(options.output, json, "utf8")
    console.log(json)
    if (samples.some((item) => item.timedOut)) process.exitCode = 2
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
