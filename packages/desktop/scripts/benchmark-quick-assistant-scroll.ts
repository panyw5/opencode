import { connectCdp, type CdpClient } from "./cdp"

type Mode = "continuous" | "roundtrip"
type Condition = "baseline" | "blur-disabled"

type Config = {
  durationMs: number
  repeats: number
  modes: Mode[]
  conditions: Condition[]
  trace: boolean
  reportPath: string
  intervalMs: number
  wheelDelta: number
  directionSegmentMs: number
  anchorRatio: number
  budgetMs?: number
}

type FrameInterval = { from: number; to: number; ms: number; scrollTop: number }
type PageSample = {
  armedAt: number
  endedAt: number
  firstWheelAt: number | null
  lastWheelAt: number | null
  wheelTimes: number[]
  frames: FrameInterval[]
  longTasks: Array<{ start: number; duration: number }>
  layoutShifts: Array<{ start: number; value: number }>
  mutations: Array<{ at: number; records: number }>
  resizes: Array<{ at: number; entries: number }>
  observerCallbacks: Array<{ kind: string; at: number }>
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

type Geometry = {
  panelRect: number[]
  viewportRect: number[]
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  messages: number
  panelNodes: number
  markdown: { full: number; structure: number; lite: number; other: number }
  roles: Record<string, number>
  blur: string
}

type BudgetCalibration = { budgetMs: number; p50Ms: number; p95Ms: number; samples: number }
type TraceEvent = {
  name?: string
  ph?: string
  pid?: number
  tid?: number
  ts?: number
  dur?: number
  args?: Record<string, any>
}

const PAGE_CALIBRATE_REFRESH = `(() => new Promise((resolve) => {
  const intervals = []
  let last = 0
  const began = performance.now()
  const tick = (now) => {
    if (last) intervals.push(now - last)
    last = now
    if (now - began >= 1200) {
      const sorted = intervals.slice().sort((a, b) => a - b)
      const at = (p) => sorted[Math.floor((sorted.length - 1) * p)] || 0
      resolve({ p50Ms: at(0.5), p95Ms: at(0.95), samples: sorted.length })
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}))()`

const PAGE_INSPECT = `(() => {
  const panel = document.querySelector('[data-component="quick-assistant-panel"]')
  const viewport = document.querySelector('[data-component="quick-assistant-viewport"]')
  if (!panel || !viewport) return { ok: false, reason: "quick-assistant panel or viewport missing" }
  const rect = (element) => {
    const value = element.getBoundingClientRect()
    return [value.x, value.y, value.width, value.height].map((item) => Math.round(item * 10) / 10)
  }
  const markdown = [...panel.querySelectorAll('[data-component="markdown"]')]
  const roles = {}
  for (const message of panel.querySelectorAll('[data-component="quick-assistant-message"]')) {
    const role = message.getAttribute('data-role') || 'unknown'
    roles[role] = (roles[role] || 0) + 1
  }
  return {
    ok: true,
    geometry: {
      panelRect: rect(panel),
      viewportRect: rect(viewport),
      scrollTop: Math.round(viewport.scrollTop * 10) / 10,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      messages: panel.querySelectorAll('[data-component="quick-assistant-message"]').length,
      panelNodes: panel.querySelectorAll('*').length,
      markdown: {
        full: markdown.filter((item) => item.dataset.markdownStage === 'full').length,
        structure: markdown.filter((item) => item.dataset.markdownStage === 'structure').length,
        lite: markdown.filter((item) => item.dataset.markdownStage === 'lite').length,
        other: markdown.filter((item) => !['full', 'structure', 'lite'].includes(item.dataset.markdownStage || '')).length,
      },
      roles,
      blur: getComputedStyle(panel).backdropFilter,
    },
  }
})()`

const PAGE_START_SAMPLE = `(() => {
  const viewport = document.querySelector('[data-component="quick-assistant-viewport"]')
  const panel = document.querySelector('[data-component="quick-assistant-panel"]')
  if (!viewport || !panel) throw new Error('quick-assistant viewport unavailable')
  if (window.__qaScrollBenchmark) throw new Error('previous benchmark sample was not cleaned up')

  const sample = {
    armed: false,
    lastFrameAt: 0,
    firstWheelAt: null,
    lastWheelAt: null,
    wheelTimes: [],
    frames: [],
    longTasks: [],
    layoutShifts: [],
    mutations: 0,
    mutationRecords: 0,
    mutationSamples: [],
    resizes: 0,
    resizeEntries: 0,
    resizeSamples: [],
    rafActive: true,
    observers: [],
    observerCallbacks: [],
  }

  const onWheel = (event) => {
    if (!sample.armed) return
    const now = performance.now()
    sample.firstWheelAt ??= now
    sample.lastWheelAt = now
    sample.wheelTimes.push(now)
  }
  viewport.addEventListener('wheel', onWheel, { capture: true, passive: true })

  const mutation = new MutationObserver((entries) => {
    if (!sample.armed) return
    sample.mutations++
    sample.mutationRecords += entries.length
    sample.mutationSamples.push({ at: performance.now(), records: entries.length })
    sample.observerCallbacks.push({ kind: 'mutation', at: performance.now() })
  })
  mutation.observe(panel, { subtree: true, childList: true, attributes: true })
  sample.observers.push(mutation)

  const resize = new ResizeObserver((entries) => {
    if (!sample.armed) return
    sample.resizes++
    sample.resizeEntries += entries.length
    sample.resizeSamples.push({ at: performance.now(), entries: entries.length })
    sample.observerCallbacks.push({ kind: 'resize', at: performance.now() })
  })
  resize.observe(panel)
  resize.observe(viewport)
  for (const message of panel.querySelectorAll('[data-component="quick-assistant-message"]')) resize.observe(message)
  sample.observers.push(resize)

  try {
    const longTask = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) sample.longTasks.push({ start: entry.startTime, duration: entry.duration })
    })
    longTask.observe({ type: 'longtask', buffered: false })
    sample.observers.push(longTask)
  } catch {}

  try {
    const layoutShift = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) sample.layoutShifts.push({ start: entry.startTime, value: entry.value || 0 })
    })
    layoutShift.observe({ type: 'layout-shift', buffered: false })
    sample.observers.push(layoutShift)
  } catch {}

  const tick = (now) => {
    if (!sample.rafActive) return
    if (sample.armed && sample.lastFrameAt) {
      sample.frames.push({ from: sample.lastFrameAt, to: now, ms: now - sample.lastFrameAt, scrollTop: viewport.scrollTop })
    }
    sample.lastFrameAt = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  window.__qaScrollBenchmark = {
    arm() {
      sample.frames.length = 0
      sample.longTasks.length = 0
      sample.layoutShifts.length = 0
      sample.observerCallbacks.length = 0
      sample.wheelTimes.length = 0
      sample.firstWheelAt = null
      sample.lastWheelAt = null
      sample.mutations = 0
      sample.mutationRecords = 0
      sample.mutationSamples.length = 0
      sample.resizes = 0
      sample.resizeEntries = 0
      sample.resizeSamples.length = 0
      sample.armed = true
      sample.armedAt = performance.now()
      return sample.armedAt
    },
    finish() {
      const endedAt = performance.now()
      sample.armed = false
      sample.rafActive = false
      viewport.removeEventListener('wheel', onWheel, true)
      for (const observer of sample.observers) observer.disconnect()
      const inputStart = sample.firstWheelAt
      const inputEnd = sample.lastWheelAt
      const inWindow = (time) => inputStart !== null && inputEnd !== null && time >= inputStart && time <= inputEnd
      const mutations = sample.mutationSamples.filter((entry) => inWindow(entry.at))
      const resizes = sample.resizeSamples.filter((entry) => inWindow(entry.at))
      return {
        armedAt: sample.armedAt,
        endedAt,
        firstWheelAt: inputStart,
        lastWheelAt: inputEnd,
        wheelTimes: sample.wheelTimes,
        frames: sample.frames,
        longTasks: sample.longTasks.filter((entry) => inputStart !== null && inputEnd !== null && entry.start >= inputStart && entry.start < inputEnd),
        layoutShifts: sample.layoutShifts.filter((entry) => inputStart !== null && inputEnd !== null && entry.start >= inputStart && entry.start < inputEnd),
        mutations,
        resizes,
        observerCallbacks: sample.observerCallbacks.filter((entry) => inputStart !== null && inputEnd !== null && entry.at >= inputStart && entry.at <= inputEnd),
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
      }
    },
    cleanup() {
      sample.armed = false
      sample.rafActive = false
      viewport.removeEventListener('wheel', onWheel, true)
      for (const observer of sample.observers) observer.disconnect()
      delete window.__qaScrollBenchmark
    },
  }
  return true
})()`

export function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const index = Math.floor((sorted.length - 1) * p)
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}

export function summarizeIntervals(intervals: number[], budgetMs: number) {
  const sorted = intervals
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b)
  const count = Math.max(1, sorted.length)
  const over = (multiple: number) => (sorted.filter((value) => value > budgetMs * multiple).length / count) * 100
  return {
    frames: sorted.length,
    p50: +percentile(sorted, 0.5).toFixed(2),
    p95: +percentile(sorted, 0.95).toFixed(2),
    p99: +percentile(sorted, 0.99).toFixed(2),
    max: +(sorted.at(-1) || 0).toFixed(2),
    over1_5BudgetPct: +over(1.5).toFixed(2),
    over2BudgetPct: +over(2).toFixed(2),
  }
}

export function calibratedBudgetMs(calibration: Pick<BudgetCalibration, "p50Ms" | "samples">) {
  if (
    calibration.samples < 30 ||
    !Number.isFinite(calibration.p50Ms) ||
    calibration.p50Ms < 3 ||
    calibration.p50Ms > 50
  ) {
    throw new Error("Idle rAF calibration is not reliable")
  }
  return calibration.p50Ms
}

export function backdropInlineValue(condition: Condition, original: string) {
  return condition === "baseline" ? original : "none"
}

export function expectedConditionBlur(condition: Condition, originalComputed: string) {
  return condition === "baseline" ? originalComputed : "none"
}

export function summarizeFrameWindow(
  frames: FrameInterval[],
  budgetMs: number,
  firstWheelAt: number,
  lastWheelAt: number,
  maxTop: number,
  edgeMargin: number,
) {
  const start = firstWheelAt + 100
  const end = lastWheelAt - 100
  const inTime = frames.filter((frame) => frame.from >= start && frame.to <= end)
  const valid = inTime.filter((frame) => frame.scrollTop >= edgeMargin && frame.scrollTop <= maxTop - edgeMargin)
  return {
    frames: valid,
    summary: summarizeIntervals(
      valid.map((frame) => frame.ms),
      budgetMs,
    ),
    excludedEdgeFrames: inTime.length - valid.length,
    inTimeFrames: inTime.length,
  }
}

function parseArgs(args: string[]): Config {
  const values = new Map<string, string>()
  const allowed = new Set([
    "mode",
    "conditions",
    "duration-ms",
    "repeats",
    "interval-ms",
    "wheel-delta",
    "segment-ms",
    "anchor-ratio",
    "budget-ms",
    "trace",
    "report",
  ])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`)
    const [key, inline] = arg.slice(2).split("=", 2)
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`)
    if (key === "trace") {
      values.set(key, inline ?? "true")
      continue
    }
    const value = inline ?? args[++index]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`)
    values.set(key, value)
  }

  const modesValue = values.get("mode") || "continuous"
  const modes: Mode[] =
    modesValue === "both" ? ["continuous", "roundtrip"] : (modesValue.split(",").filter(Boolean) as Mode[])
  if (modes.some((mode) => mode !== "continuous" && mode !== "roundtrip"))
    throw new Error("--mode must be continuous, roundtrip, or both")

  const conditionsValue = values.get("conditions") || "baseline"
  const conditions = conditionsValue.split(",").filter(Boolean) as Condition[]
  if (conditions.some((condition) => condition !== "baseline" && condition !== "blur-disabled")) {
    throw new Error("--conditions accepts baseline,blur-disabled")
  }
  if (
    conditions.length === 0 ||
    conditions.length > 2 ||
    (conditions.length === 2 && conditions[0] === conditions[1])
  ) {
    throw new Error("Use baseline, or alternate baseline and blur-disabled")
  }

  const config: Config = {
    durationMs: Number(values.get("duration-ms") || 8000),
    repeats: Number(values.get("repeats") || 3),
    modes,
    conditions,
    trace: values.has("trace") && values.get("trace") !== "false",
    reportPath:
      values.get("report") ||
      `/tmp/quick-assistant-scroll-benchmark-${new Date().toISOString().replaceAll(":", "-")}.json`,
    intervalMs: Number(values.get("interval-ms") || 1000 / 120),
    wheelDelta: Number(values.get("wheel-delta") || 2),
    directionSegmentMs: Number(values.get("segment-ms") || 500),
    anchorRatio: Number(values.get("anchor-ratio") || 0.5),
    budgetMs: values.has("budget-ms") ? Number(values.get("budget-ms")) : undefined,
  }
  if (!Number.isFinite(config.durationMs) || config.durationMs < 1000)
    throw new Error("--duration-ms must be at least 1000")
  if (!Number.isInteger(config.repeats) || config.repeats < 1) throw new Error("--repeats must be a positive integer")
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 4) throw new Error("--interval-ms must be at least 4")
  if (!Number.isFinite(config.wheelDelta) || config.wheelDelta <= 0) throw new Error("--wheel-delta must be positive")
  if (!Number.isFinite(config.directionSegmentMs) || config.directionSegmentMs < config.intervalMs)
    throw new Error("--segment-ms must be at least one wheel interval")
  if (!Number.isFinite(config.anchorRatio) || config.anchorRatio < 0.2 || config.anchorRatio > 0.8)
    throw new Error("--anchor-ratio must be between 0.2 and 0.8")
  if (
    config.budgetMs !== undefined &&
    (!Number.isFinite(config.budgetMs) || config.budgetMs < 3 || config.budgetMs > 50)
  )
    throw new Error("--budget-ms must be between 3 and 50")
  return config
}

function equalArray(a: number[], b: number[], tolerance = 1) {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
}

function assertGeometry(expected: Geometry, actual: Geometry) {
  if (!equalArray(expected.panelRect, actual.panelRect) || !equalArray(expected.viewportRect, actual.viewportRect)) {
    throw new Error(
      "Quick-assistant geometry changed during benchmark; stopping instead of comparing different viewport sizes",
    )
  }
  if (expected.scrollHeight !== actual.scrollHeight || expected.clientHeight !== actual.clientHeight) {
    throw new Error(
      "Quick-assistant scroll geometry changed during benchmark; stopping instead of comparing different content",
    )
  }
  if (
    expected.messages !== actual.messages ||
    JSON.stringify(expected.markdown) !== JSON.stringify(actual.markdown) ||
    JSON.stringify(expected.roles) !== JSON.stringify(actual.roles)
  ) {
    throw new Error("Quick-assistant message count or Markdown stage changed during benchmark")
  }
  if (expected.panelNodes !== actual.panelNodes)
    throw new Error("Quick-assistant DOM node count changed during benchmark")
}

function assertConditionBlur(condition: Condition, initialBlur: string, actual: Geometry) {
  const expected = expectedConditionBlur(condition, initialBlur)
  if (actual.blur !== expected)
    throw new Error(`Expected ${condition} backdrop-filter "${expected}", saw "${actual.blur}"`)
}

async function inspect(client: CdpClient) {
  const value = await client.evaluate<any>(PAGE_INSPECT)
  if (!value?.ok) throw new Error(value?.reason || "quick-assistant panel not available")
  return value.geometry as Geometry
}

async function applyCondition(client: CdpClient, condition: Condition) {
  const inline = backdropInlineValue(condition, "")
  const result = await client.evaluate<boolean>(`(() => {
    const panel = document.querySelector('[data-component="quick-assistant-panel"]')
    if (!panel) return false
    if (!window.__qaScrollOriginalStyle) {
      window.__qaScrollOriginalStyle = { blur: panel.style.backdropFilter, webkitBlur: panel.style.webkitBackdropFilter }
    }
    const original = window.__qaScrollOriginalStyle
    panel.style.backdropFilter = ${JSON.stringify(inline)} || original.blur
    panel.style.webkitBackdropFilter = ${JSON.stringify(inline)} || original.webkitBlur
    return true
  })()`)
  if (!result) throw new Error("Could not apply quick-assistant A/B style")
}

async function restoreCondition(client: CdpClient) {
  await client.evaluate(`(() => {
    const panel = document.querySelector('[data-component="quick-assistant-panel"]')
    const original = window.__qaScrollOriginalStyle
    if (panel && original) {
      panel.style.backdropFilter = original.blur
      panel.style.webkitBackdropFilter = original.webkitBlur
    }
    delete window.__qaScrollOriginalStyle
    return true
  })()`)
}

async function armSample(client: CdpClient) {
  await client.evaluate(PAGE_START_SAMPLE)
  await new Promise((resolve) => setTimeout(resolve, 350))
  await client.evaluate("window.__qaScrollBenchmark.arm()")
}

async function runWheel(
  client: CdpClient,
  input: {
    mode: Mode
    durationMs: number
    intervalMs: number
    wheelDelta: number
    directionSegmentMs: number
    x: number
    y: number
    maxDistance: number
  },
) {
  const began = performance.now()
  if (input.mode === "continuous") {
    const requestedDistance = Math.round((input.wheelDelta * input.durationMs) / input.intervalMs)
    const distance = Math.floor(Math.min(requestedDistance, input.maxDistance))
    const speed = Math.max(1, Math.round(distance / (input.durationMs / 1000)))
    try {
      await client.call("Input.synthesizeScrollGesture", {
        x: Math.round(input.x),
        y: Math.round(input.y),
        yDistance: -distance,
        speed,
        gestureSourceType: "mouse",
        preventFling: true,
      })
    } catch (error) {
      throw new Error(`Input.synthesizeScrollGesture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const ended = performance.now()
    return {
      calls: 1,
      transport: "Input.synthesizeScrollGesture",
      distance,
      speed,
      startedAtMonotonicMs: +began.toFixed(1),
      endedAtMonotonicMs: +ended.toFixed(1),
      durationMs: +(ended - began).toFixed(1),
    }
  }

  let index = 0
  let calls = 0
  while (performance.now() - began < input.durationMs) {
    const elapsed = performance.now() - began
    const segment = Math.floor(elapsed / input.directionSegmentMs)
    const sign = segment % 2 === 0 ? 1 : -1
    await client.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: input.x,
      y: input.y,
      deltaX: 0,
      deltaY: sign * input.wheelDelta,
    })
    calls++
    index++
    const nextAt = began + index * input.intervalMs
    const wait = nextAt - performance.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
  const ended = performance.now()
  return {
    calls,
    transport: "Input.dispatchMouseEvent",
    startedAtMonotonicMs: +began.toFixed(1),
    endedAtMonotonicMs: +ended.toFixed(1),
    durationMs: +(ended - began).toFixed(1),
  }
}

function frameWindow(sample: PageSample, budgetMs: number, edgeMargin: number) {
  if (sample.firstWheelAt === null || sample.lastWheelAt === null)
    return {
      frames: [],
      summary: summarizeIntervals([], budgetMs),
      inputSpanMs: 0,
      excludedEdgeFrames: 0,
      inTimeFrames: 0,
    }
  const maxTop = Math.max(0, sample.scrollHeight - sample.clientHeight)
  const window = summarizeFrameWindow(
    sample.frames,
    budgetMs,
    sample.firstWheelAt,
    sample.lastWheelAt,
    maxTop,
    edgeMargin,
  )
  return {
    ...window,
    inputSpanMs: +(sample.lastWheelAt - sample.firstWheelAt).toFixed(1),
  }
}

async function finishSample(client: CdpClient, geometry: Geometry, budgetMs: number, edgeMargin: number) {
  await new Promise((resolve) => setTimeout(resolve, 120))
  const sample = await client.evaluate<PageSample>("window.__qaScrollBenchmark.finish()")
  const windowed = frameWindow(sample, budgetMs, edgeMargin)
  const wheelIntervals = sample.wheelTimes.slice(1).map((time, index) => time - sample.wheelTimes[index])
  const wheelSummary = summarizeIntervals(wheelIntervals, 1000 / 120)
  return {
    windowed,
    wheel: {
      count: sample.wheelTimes.length,
      firstAt: sample.firstWheelAt,
      lastAt: sample.lastWheelAt,
      intervals: wheelSummary,
      topStart: geometry.scrollTop,
      topEnd: sample.scrollTop,
      minTop: sample.frames.length ? Math.min(...sample.frames.map((item) => item.scrollTop)) : sample.scrollTop,
      maxTop: sample.frames.length ? Math.max(...sample.frames.map((item) => item.scrollTop)) : sample.scrollTop,
    },
    longTasks: sample.longTasks,
    layoutShifts: sample.layoutShifts,
    mutations: {
      callbacks: sample.mutations.length,
      records: sample.mutations.reduce((sum, item) => sum + item.records, 0),
    },
    resizes: { callbacks: sample.resizes.length, entries: sample.resizes.reduce((sum, item) => sum + item.entries, 0) },
    observerCallbacks: sample.observerCallbacks.length,
    finalGeometry: {
      scrollHeight: sample.scrollHeight,
      clientHeight: sample.clientHeight,
      scrollTop: sample.scrollTop,
    },
  }
}

export function traceSummary(trace: { traceEvents?: TraceEvent[] }, budgetMs: number) {
  const events = trace.traceEvents || []
  const metadata = new Map<string, string>()
  for (const event of events) {
    if (event.ph === "M" && (event.name === "thread_name" || event.name === "process_name")) {
      metadata.set(`${event.pid}:${event.tid}`, String(event.args?.name || ""))
    }
  }
  const renderer = [...metadata].find(([, name]) => name === "CrRendererMain")?.[0]
  const rendererKey = renderer
  const eventCounts: Record<string, number> = {}
  const relevant: Record<string, number[]> = {}
  const presentation: Record<string, number> = {}
  const wheelEvents = events.filter(
    (event) =>
      event.name === "EventDispatch" &&
      event.ph === "X" &&
      event.pid + ":" + event.tid === renderer &&
      event.args?.data?.type === "wheel",
  )
  const firstWheelTs = wheelEvents.length ? Math.min(...wheelEvents.map((event) => Number(event.ts || 0))) : null
  const lastWheelTs = wheelEvents.length
    ? Math.max(...wheelEvents.map((event) => Number(event.ts || 0) + (event.dur || 0)))
    : null
  const sequenceBegins: Array<{ name: string; ts: number; rawCounters: Record<string, number>; matchedEnd: false }> = []
  const jank = {
    events: 0,
    janky: 0,
    notJanky: 0,
    unknownFlag: 0,
    damageTypes: {} as Record<string, number>,
    vsyncIntervalsUs: [] as number[],
  }
  for (const event of events) {
    if (!event.name) continue
    if (event.ph !== "X" || event.pid + ":" + event.tid !== rendererKey) continue
    const eventStart = Number(event.ts || 0)
    if (
      firstWheelTs !== null &&
      lastWheelTs !== null &&
      (eventStart < firstWheelTs || eventStart + (event.dur || 0) > lastWheelTs)
    )
      continue
    eventCounts[event.name] = (eventCounts[event.name] || 0) + 1
    if (
      /RunTask|EventDispatch|FunctionCall|Paint|Layout|UpdateStyle|BeginMainFrame|UpdateLifecycle|Scroll/.test(
        event.name,
      )
    ) {
      const values = relevant[event.name] || (relevant[event.name] = [])
      values.push((event.dur || 0) / 1000)
    }
    if (
      /PresentationFeedback|FramePresented|FrameReport|FrameDropped|DroppedFrame|LatencyInfo|SubmitFrame/.test(
        event.name,
      )
    )
      presentation[event.name] = (presentation[event.name] || 0) + 1
  }
  if (firstWheelTs !== null && lastWheelTs !== null) {
    const rendererPid = renderer ? Number(renderer.split(":")[0]) : undefined
    for (const event of events) {
      const eventTs = Number(event.ts || 0)
      if (event.pid !== rendererPid || eventTs < firstWheelTs || eventTs > lastWheelTs) continue
      if (event.name === "FrameSequenceTrackerV3" && event.ph === "b") {
        const args = event.args?.args?.data || {}
        const name = String(event.args?.name || "unknown")
        sequenceBegins.push({
          name,
          ts: Number(event.ts || 0),
          rawCounters: Object.fromEntries(
            [
              "expected",
              "dropped_v3",
              "dropped_v4",
              "missing_content",
              "checkerboarded",
              "checkerboarded_need_raster",
              "checkerboarded_need_record",
            ]
              .filter((key) => typeof args[key] === "number" && Number.isFinite(args[key]))
              .map((key) => [key, args[key]]),
          ),
          matchedEnd: false,
        })
      }
      if (event.name === "ScrollJankV4" && event.ph === "b") {
        const args = event.args?.scroll_jank_v4 || {}
        jank.events++
        if (args.is_janky === true) jank.janky++
        else if (args.is_janky === false) jank.notJanky++
        else jank.unknownFlag++
        if (args.damage_type) jank.damageTypes[args.damage_type] = (jank.damageTypes[args.damage_type] || 0) + 1
        if (Number.isFinite(args.vsync_interval_us)) jank.vsyncIntervalsUs.push(args.vsync_interval_us)
      }
    }
  }
  const rendererMain = Object.fromEntries(
    Object.entries(relevant).map(([name, values]) => {
      const sorted = values.slice().sort((a, b) => a - b)
      return [
        name,
        {
          count: values.length,
          p95Ms: +percentile(sorted, 0.95).toFixed(2),
          maxMs: +(sorted.at(-1) || 0).toFixed(2),
          overBudget: values.filter((value) => value > budgetMs).length,
        },
      ]
    }),
  )
  return {
    events: events.length,
    traceWheelWindowUs:
      firstWheelTs === null ? null : { start: firstWheelTs, end: lastWheelTs, wheelEvents: wheelEvents.length },
    rendererThread: renderer
      ? { key: renderer, name: "CrRendererMain", events: Object.keys(eventCounts).length, rendererMain }
      : null,
    frameSequence: {
      rawBeginEvents: sequenceBegins,
      verified: false,
      note: "Counters are unverified begin-event samples; end events are not paired and no dropped-frame rate is calculated.",
    },
    scrollJankV4: {
      ...jank,
      vsyncIntervalsUs: [...new Set(jank.vsyncIntervalsUs)],
      note: "is_janky is a Chromium ScrollJankV4 engine marker, not a displayed-frame counter.",
    },
    presentationEvents: presentation,
    note: "Trace summaries are filtered to the first-through-last renderer wheel EventDispatch. FrameSequenceTracker dropped counters and ScrollJankV4 is_janky flags are presented separately from rAF. Trace durations are inclusive and overlap; do not sum them into CPU percentages.",
  }
}

async function runTrace(
  client: CdpClient,
  config: Config,
  geometry: Geometry,
  mode: Mode,
  condition: Condition,
  index: number,
  budgetMs: number,
) {
  const rect = geometry.viewportRect
  const maxTop = geometry.scrollHeight - geometry.clientHeight
  const anchor = Math.round(maxTop * config.anchorRatio * 10) / 10
  await client.evaluate(`document.querySelector('[data-component="quick-assistant-viewport"]').scrollTop=${anchor}`)
  await applyCondition(client, condition)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const stableGeometry = await inspect(client)
  assertGeometry(geometry, stableGeometry)
  assertConditionBlur(condition, geometry.blur, stableGeometry)
  if (Math.abs(stableGeometry.scrollTop - anchor) > 2)
    throw new Error("Trace viewport did not reach the deterministic benchmark anchor")
  const socket = (client as unknown as { socket: WebSocket }).socket
  let traceResolve: ((value: any) => void) | undefined
  const traceDone = new Promise<any>((resolve) => {
    traceResolve = resolve
  })
  const traceHandler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(String(event.data))
      if (message.method === "Tracing.tracingComplete") traceResolve?.(message.params)
    } catch {}
  }
  socket.addEventListener("message", traceHandler)
  let tracing = false
  let ioHandle: string | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await client.call("Tracing.start", {
      categories:
        "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,input,input.scrolling,benchmark,gpu,viz",
      transferMode: "ReturnAsStream",
    })
    tracing = true
    const input = await runWheel(client, {
      mode,
      durationMs: config.durationMs,
      intervalMs: config.intervalMs,
      wheelDelta: config.wheelDelta,
      directionSegmentMs: config.directionSegmentMs,
      x: rect[0] + rect[2] / 2,
      y: rect[1] + rect[3] / 2,
      maxDistance: Math.max(0, maxTop - anchor - 100),
    })
    await client.call("Tracing.end")
    tracing = false
    const complete = await Promise.race([
      traceDone,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for Tracing.tracingComplete")), 30000)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    ioHandle = complete.stream
    let data = ""
    let eof = false
    while (!eof) {
      const chunk = await client.call<{ data: string; eof: boolean }>("IO.read", {
        handle: ioHandle,
        size: 1024 * 1024,
      })
      data += chunk.data
      eof = chunk.eof
    }
    await client.call("IO.close", { handle: ioHandle })
    ioHandle = undefined
    const path = `/tmp/quick-assistant-scroll-${mode}-${condition}-trace-${index}.json`
    await Bun.write(path, data)
    return { mode, condition, input, path, summary: traceSummary(JSON.parse(data), budgetMs) }
  } finally {
    if (timeout) clearTimeout(timeout)
    socket.removeEventListener("message", traceHandler)
    if (tracing) await client.call("Tracing.end").catch(() => undefined)
    if (ioHandle) await client.call("IO.close", { handle: ioHandle }).catch(() => undefined)
    await restoreCondition(client)
  }
}

async function runTrial(
  client: CdpClient,
  config: Config,
  initial: Geometry,
  mode: Mode,
  condition: Condition,
  repeat: number,
  trialIndex: number,
  budgetMs: number,
) {
  await applyCondition(client, condition)
  const before = await inspect(client)
  assertGeometry(initial, before)
  assertConditionBlur(condition, initial.blur, before)
  const maxTop = initial.scrollHeight - initial.clientHeight
  const anchor = Math.round(maxTop * config.anchorRatio * 10) / 10
  await client.evaluate(`document.querySelector('[data-component="quick-assistant-viewport"]').scrollTop=${anchor}`)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const geometry = await inspect(client)
  assertGeometry(initial, geometry)
  assertConditionBlur(condition, initial.blur, geometry)
  if (Math.abs(geometry.scrollTop - anchor) > 2)
    throw new Error("Viewport did not reach the deterministic benchmark anchor")

  const edgeMargin = 100
  await armSample(client)
  const input = await runWheel(client, {
    mode,
    durationMs: config.durationMs,
    intervalMs: config.intervalMs,
    wheelDelta: config.wheelDelta,
    directionSegmentMs: config.directionSegmentMs,
    x: geometry.viewportRect[0] + geometry.viewportRect[2] / 2,
    y: geometry.viewportRect[1] + geometry.viewportRect[3] / 2,
    maxDistance: Math.max(0, maxTop - anchor - edgeMargin),
  })
  const measured = await finishSample(client, geometry, budgetMs, edgeMargin)
  await client.evaluate("window.__qaScrollBenchmark.cleanup()")
  await restoreCondition(client)
  const after = await inspect(client)
  assertGeometry(initial, after)
  assertConditionBlur("baseline", initial.blur, after)
  const actualMovement =
    mode === "continuous"
      ? Math.abs(measured.wheel.topEnd - measured.wheel.topStart)
      : measured.wheel.maxTop - measured.wheel.minTop
  const inTimeFrames = measured.windowed.inTimeFrames
  const edgeRatio = inTimeFrames ? measured.windowed.excludedEdgeFrames / inTimeFrames : 1
  const invalidReasons: string[] = []
  if (measured.wheel.count === 0) invalidReasons.push("no wheel events reached the viewport")
  if (input.transport === "Input.dispatchMouseEvent" && measured.wheel.count !== input.calls)
    invalidReasons.push("dispatched wheel count did not match delivered wheel events")
  if (measured.wheel.intervals.max > 60) invalidReasons.push("wheel stream contained a gap over 60ms")
  if (measured.windowed.inputSpanMs < config.durationMs * 0.8)
    invalidReasons.push("wheel event span was too short for a continuous gesture")
  if (actualMovement < 50) invalidReasons.push("scrollTop path did not move enough")
  if (measured.windowed.summary.frames < 10) invalidReasons.push("not enough in-window non-edge frames")
  if (edgeRatio > 0.05) invalidReasons.push("too many edge frames were excluded")
  if (
    measured.finalGeometry.scrollHeight !== initial.scrollHeight ||
    measured.finalGeometry.clientHeight !== initial.clientHeight
  )
    invalidReasons.push("viewport geometry changed during sample")
  return {
    trialIndex,
    repeat,
    mode,
    condition,
    anchor,
    input,
    geometry: {
      panelRect: geometry.panelRect,
      viewportRect: geometry.viewportRect,
      scrollHeight: geometry.scrollHeight,
      clientHeight: geometry.clientHeight,
      panelNodes: geometry.panelNodes,
      messages: geometry.messages,
      markdown: geometry.markdown,
      roles: geometry.roles,
    },
    result: measured,
    validation: {
      geometryStable: true,
      stageStable: true,
      inputCountMatchesEvents:
        input.transport === "Input.dispatchMouseEvent" ? measured.wheel.count === input.calls : null,
      actualMovement,
      edgeRatio: +edgeRatio.toFixed(4),
      valid: invalidReasons.length === 0,
      invalidReasons,
      edgeFramesExcluded: measured.windowed.excludedEdgeFrames,
    },
  }
}

async function main() {
  const config = parseArgs(Bun.argv.slice(2))
  const { client, target } = await connectCdp()
  const report: any = {
    startedAt: new Date().toISOString(),
    target: { url: target.url, title: target.title },
    config,
    environment: null,
    trials: [],
    traces: [],
    errors: [],
  }
  let initial: Geometry | undefined
  let originalTop: number | undefined

  try {
    initial = await inspect(client)
    originalTop = initial.scrollTop
    const calibration = config.budgetMs
      ? { p50Ms: config.budgetMs, p95Ms: config.budgetMs, samples: 0 }
      : await client.evaluate<{ p50Ms: number; p95Ms: number; samples: number }>(PAGE_CALIBRATE_REFRESH)
    if (calibration.samples > 0 && calibration.samples < 30)
      throw new Error("Idle rAF calibration had too few samples; make the dev renderer foreground and retry")
    const budgetMs = config.budgetMs ?? calibratedBudgetMs(calibration)
    if (!Number.isFinite(budgetMs) || budgetMs < 3 || budgetMs > 50)
      throw new Error(`Invalid idle rAF budget estimate: ${budgetMs}ms`)
    report.environment = {
      width: await client.evaluate<number>("innerWidth"),
      height: await client.evaluate<number>("innerHeight"),
      dpr: await client.evaluate<number>("devicePixelRatio"),
      screen: await client.evaluate<string>("`${screen.width}x${screen.height}`"),
      theme: await client.evaluate<string>("document.documentElement.getAttribute('data-theme')"),
      frameBudgetMs: budgetMs,
      estimatedRefreshHz: +(1000 / budgetMs).toFixed(1),
      refreshCalibration: {
        method: config.budgetMs ? "explicit --budget-ms override" : "1200ms idle rAF median",
        p50Ms: +calibration.p50Ms.toFixed(2),
        p95Ms: +calibration.p95Ms.toFixed(2),
        samples: calibration.samples,
      },
      initialGeometry: initial,
      method:
        "CDP Input.dispatchMouseEvent mouseWheel events. rAF is renderer callback cadence, not physical presentation telemetry.",
    }

    for (const mode of config.modes) {
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        for (const condition of config.conditions) {
          const trialIndex = report.trials.length + 1
          const trial = await runTrial(client, config, initial, mode, condition, repeat + 1, trialIndex, budgetMs)
          if (!trial.validation.valid)
            report.errors.push(`trial ${trialIndex} invalid: ${trial.validation.invalidReasons.join(", ")}`)
          report.trials.push(trial)
          console.log(
            JSON.stringify({
              phase: "sample",
              trialIndex,
              mode,
              repeat: repeat + 1,
              condition,
              valid: trial.validation.valid,
              frames: trial.result.windowed.summary.frames,
              p95Ms: trial.result.windowed.summary.p95,
              p99Ms: trial.result.windowed.summary.p99,
              maxMs: trial.result.windowed.summary.max,
              longTasks: trial.result.longTasks.length,
            }),
          )
        }
      }
    }

    if (config.trace) {
      let traceIndex = 1
      for (const mode of config.modes) {
        for (const condition of config.conditions) {
          const geometry = await inspect(client)
          assertGeometry(initial, geometry)
          assertConditionBlur("baseline", initial.blur, geometry)
          report.traces.push(await runTrace(client, config, geometry, mode, condition, traceIndex++, budgetMs))
          console.log(
            JSON.stringify({
              phase: "trace",
              mode,
              condition,
              path: report.traces.at(-1).path,
              frameSequence: report.traces.at(-1).summary.frameSequence,
              scrollJank: report.traces.at(-1).summary.scrollJankV4,
            }),
          )
        }
      }
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    try {
      await restoreCondition(client)
      if (originalTop !== undefined)
        await client.evaluate(
          `(() => { const viewport=document.querySelector('[data-component="quick-assistant-viewport"]'); if(viewport) viewport.scrollTop=${originalTop}; return true })()`,
        )
      await client.evaluate(`window.__qaScrollBenchmark?.cleanup()`)
    } catch (error) {
      report.errors.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    report.finishedAt = new Date().toISOString()
    report.finalGeometry = await inspect(client).catch(() => null)
    try {
      await Bun.write(config.reportPath, JSON.stringify(report, null, 2))
    } finally {
      client.close()
    }
  }
  if (report.errors.length)
    throw new Error(`Benchmark completed with errors: ${report.errors.join("; ")}; report=${config.reportPath}`)
  console.log(
    JSON.stringify({
      phase: "complete",
      report: config.reportPath,
      trials: report.trials.length,
      traces: report.traces.length,
    }),
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
