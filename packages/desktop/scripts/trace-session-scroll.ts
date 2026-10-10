import { listTargets, pickPageTarget } from "./cdp"

type Response = { id?: number; result?: any; error?: { message: string }; method?: string; params?: any }
type TraceEvent = {
  name: string
  cat?: string
  ph: string
  pid: number
  tid: number
  ts: number
  dur?: number
  args?: any
}

const sessionID = process.argv[2]
const count = Number(process.argv[3] ?? 180)
const deltaY = Number(process.argv[4] ?? -24)
const delayMs = Number(process.argv[5] ?? 8)
const inspectReads = process.argv.includes("--inspect-reads")
if (!sessionID || !Number.isInteger(count) || count < 1 || count > 300 || !Number.isFinite(deltaY)) {
  throw new Error("usage: bun trace-session-scroll.ts <session-id> [count] [deltaY] [delayMs]")
}

const target = pickPageTarget(await listTargets())
if (!target) throw new Error("No development Electron renderer at CDP 9222")
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true })
  socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true })
})

let nextID = 1
const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
const listeners = new Map<string, Set<(params: any) => void>>()
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as Response
  if (message.id !== undefined) {
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
    return
  }
  if (!message.method) return
  for (const listener of listeners.get(message.method) ?? []) listener(message.params)
})

const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = nextID++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const once = (method: string) =>
  new Promise<any>((resolve) => {
    const callback = (params: any) => {
      listeners.get(method)?.delete(callback)
      resolve(params)
    }
    if (!listeners.has(method)) listeners.set(method, new Set())
    listeners.get(method)!.add(callback)
  })
const evaluate = async <T>(expression: string): Promise<T> => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.result?.description ?? "Renderer evaluation failed")
  return response.result.value as T
}

const state = await evaluate<{ session: string | null; top: number; height: number }>(`(() => {
  const root = document.querySelector('[data-slot="scroll-view-viewport"]')
  return {
    session: document.querySelector('[data-component="sidebar-session"][data-active="true"]')?.getAttribute('data-session-id') ?? null,
    top: root?.scrollTop ?? 0,
    height: root?.scrollHeight ?? 0,
  }
})()`)
if (state.session !== sessionID) throw new Error(`Wrong session: ${state.session ?? "none"}`)
console.log(
  `[trace] session=${sessionID} top=${Math.round(state.top)} height=${Math.round(state.height)} count=${count}`,
)

await evaluate(`(() => {
  const root = document.querySelector('[data-slot="scroll-view-viewport"]')
  const inspectReads = ${inspectReads}
  window.__sessionScrollTraceProbe?.stop?.()
  window.__opencodeTimelineBatchPhases = []
  const probe = { frames: [], wheels: [], scrolls: [], tasks: [], slowReads: [], start: performance.now(), stop() {} }
  let owner = root
  let descriptor
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, 'scrollHeight')
    owner = Object.getPrototypeOf(owner)
  }
  const ownDescriptor = Object.getOwnPropertyDescriptor(root, 'scrollHeight')
  if (inspectReads && descriptor?.get) Object.defineProperty(root, 'scrollHeight', {
    configurable: true,
    get() {
      const before = performance.now()
      const value = descriptor.get.call(this)
      const ms = performance.now() - before
      if (ms >= 5) probe.slowReads.push({ property: 'scrollHeight', at: before - probe.start, ms, stack: new Error().stack?.split('\\n').slice(1, 7) })
      return value
    },
  })
  let topOwner = root
  let topDescriptor
  while (topOwner && !topDescriptor) {
    topDescriptor = Object.getOwnPropertyDescriptor(topOwner, 'scrollTop')
    topOwner = Object.getPrototypeOf(topOwner)
  }
  const ownTopDescriptor = Object.getOwnPropertyDescriptor(root, 'scrollTop')
  if (inspectReads && topDescriptor?.get && topDescriptor?.set) Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get() {
      const before = performance.now()
      const value = topDescriptor.get.call(this)
      const ms = performance.now() - before
      if (ms >= 5) probe.slowReads.push({ property: 'scrollTop', at: before - probe.start, ms, stack: new Error().stack?.split('\\n').slice(1, 7) })
      return value
    },
    set(value) { topDescriptor.set.call(this, value) },
  })
  let active = true
  let frameID
  const frame = (time) => {
    if (!active) return
    probe.frames.push([time - probe.start, 0])
    frameID = requestAnimationFrame(frame)
  }
  const wheel = (event) => probe.wheels.push([performance.now() - probe.start, event.deltaY, 0])
  const scroll = () => probe.scrolls.push([performance.now() - probe.start, 0])
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.tasks.push([entry.startTime - probe.start, entry.duration])
  })
  observer.observe({ entryTypes: ['longtask'] })
  root.addEventListener('wheel', wheel, { passive: true })
  root.addEventListener('scroll', scroll, { passive: true })
  frameID = requestAnimationFrame(frame)
  probe.stop = () => {
    active = false
    cancelAnimationFrame(frameID)
    root.removeEventListener('wheel', wheel)
    root.removeEventListener('scroll', scroll)
    observer.disconnect()
    if (inspectReads) {
      if (ownDescriptor) Object.defineProperty(root, 'scrollHeight', ownDescriptor)
      else Reflect.deleteProperty(root, 'scrollHeight')
      if (ownTopDescriptor) Object.defineProperty(root, 'scrollTop', ownTopDescriptor)
      else Reflect.deleteProperty(root, 'scrollTop')
    }
  }
  window.__sessionScrollTraceProbe = probe
  return true
})()`)

await send("Tracing.start", {
  categories: "devtools.timeline,toplevel,blink.user_timing,disabled-by-default-devtools.timeline.frame",
  transferMode: "ReturnAsStream",
  options: "record-as-much-as-possible",
})
await evaluate(`performance.mark('session-scroll-wheel-start')`)
for (let i = 0; i < count; i++) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 900, y: 450, deltaX: 0, deltaY })
  if (i + 1 < count) await Bun.sleep(delayMs)
}
await Bun.sleep(250)
const idleAnchorBefore = await evaluate<{ key?: string; top?: number; scrollTop?: number }>(`(() => {
  const root = document.querySelector('[data-slot="scroll-view-viewport"]')
  const box = root.getBoundingClientRect()
  const line = box.top + box.height / 2
  const row = [...root.querySelectorAll('[data-timeline-key]')].find((node) => {
    const rect = node.getBoundingClientRect()
    return rect.top <= line && rect.bottom >= line
  })
  return { key: row?.getAttribute('data-timeline-key'), top: row?.getBoundingClientRect().top, scrollTop: root.scrollTop }
})()`)
const probe = await evaluate<{
  frames: [number, number][]
  wheels: [number, number, number][]
  scrolls: [number, number][]
  tasks: [number, number][]
  slowReads: { property: string; at: number; ms: number; stack?: string[] }[]
  batchPhases: { id: number; stage: string; at: number }[]
  start: number
}>(`(() => {
  const probe = window.__sessionScrollTraceProbe
  probe.stop()
  delete window.__sessionScrollTraceProbe
  return { frames: probe.frames, wheels: probe.wheels, scrolls: probe.scrolls, tasks: probe.tasks, slowReads: probe.slowReads, batchPhases: window.__opencodeTimelineBatchPhases ?? [], start: probe.start }
})()`)
const complete = once("Tracing.tracingComplete")
await send("Tracing.end")
const { stream } = await complete
let trace = ""
while (true) {
  const chunk = await send("IO.read", { handle: stream, size: 1_000_000 })
  trace += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString() : chunk.data
  if (chunk.eof) break
}
await send("IO.close", { handle: stream })
await Bun.sleep(1_000)
const idleAnchorAfter = await evaluate<{ top?: number; scrollTop?: number }>(`(() => {
  const root = document.querySelector('[data-slot="scroll-view-viewport"]')
  const row = [...root.querySelectorAll('[data-timeline-key]')].find((node) => node.getAttribute('data-timeline-key') === ${JSON.stringify(idleAnchorBefore.key)})
  return { top: row?.getBoundingClientRect().top, scrollTop: root.scrollTop }
})()`)
socket.close()

const events = (JSON.parse(trace).traceEvents ?? []) as TraceEvent[]
const names = events.filter((event) => event.ph === "M" && event.name === "thread_name")
const main = names.find((event) => event.args?.name === "CrRendererMain")
const timeline = main ? events.filter((event) => event.pid === main.pid && event.tid === main.tid) : events
const mark = timeline.find((event) => event.name === "session-scroll-wheel-start")
const long = timeline
  .filter((event) => event.ph === "X" && (event.dur ?? 0) >= 8_000)
  .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
  .slice(0, 30)
  .map((event) => ({
    name: event.name,
    ms: +((event.dur ?? 0) / 1000).toFixed(1),
    at: mark ? +((event.ts - mark.ts) / 1000).toFixed(1) : undefined,
    source:
      event.name === "FunctionCall"
        ? `${event.args?.data?.url ?? "unknown"}:${event.args?.data?.lineNumber ?? "?"}`
        : undefined,
    args: JSON.stringify(event.args?.data ?? event.args ?? {}).slice(0, 240),
  }))
const first = probe.wheels[0]?.[0] ?? 0
const last = probe.wheels.at(-1)?.[0] ?? first
const frames = probe.frames.filter((frame) => frame[0] >= first - 30 && frame[0] <= last + 100)
const gaps = frames.slice(1).map((frame, index) => ({
  at: +frame[0].toFixed(1),
  ms: +(frame[0] - frames[index][0]).toFixed(1),
  scroll: +(frame[1] - frames[index][1]).toFixed(1),
}))
const batches = new Map<number, { stage: string; at: number }[]>()
for (const phase of probe.batchPhases) {
  const entries = batches.get(phase.id) ?? []
  entries.push({ stage: phase.stage, at: phase.at - probe.start })
  batches.set(phase.id, entries)
}
const slowBatches = [...batches.entries()]
  .filter(([id]) => id > 0)
  .map(([id, entries]) => ({
    id,
    at: entries[0]?.at ?? 0,
    ms: (entries.at(-1)?.at ?? 0) - (entries[0]?.at ?? 0),
    stages: entries.map((entry, index) => ({
      stage: entry.stage,
      ms: +(entry.at - (entries[index - 1]?.at ?? entry.at)).toFixed(2),
    })),
  }))
  .filter((batch) => batch.at >= first - 100 && batch.at <= last + 100)
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 10)
const report = {
  bytes: trace.length,
  traceEvents: events.length,
  mainThread: main ? `${main.pid}:${main.tid}` : "unknown",
  wheels: probe.wheels.length,
  scrolls: probe.scrolls.length,
  startTop: state.top,
  endTop: idleAnchorBefore.scrollTop,
  postIdleShift: {
    scroll:
      idleAnchorAfter.scrollTop === undefined || idleAnchorBefore.scrollTop === undefined
        ? undefined
        : +(idleAnchorAfter.scrollTop - idleAnchorBefore.scrollTop).toFixed(1),
    visual:
      idleAnchorAfter.top === undefined || idleAnchorBefore.top === undefined
        ? undefined
        : +(idleAnchorAfter.top - idleAnchorBefore.top).toFixed(1),
  },
  frameGaps: gaps
    .filter((gap) => gap.ms > 25)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 20),
  longTasks: probe.tasks
    .filter((task) => task[0] >= first - 100 && task[0] <= last + 100)
    .map(([at, ms]) => ({ at: +at.toFixed(1), ms: +ms.toFixed(1) })),
  slowReads: probe.slowReads
    .filter((read) => read.at >= first - 100 && read.at <= last + 100)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10),
  slowBatches,
  resizeEvents: probe.batchPhases
    .filter((phase) => phase.id === 0 && phase.at - probe.start >= first - 100 && phase.at - probe.start <= last + 100)
    .map((phase) => ({ at: +(phase.at - probe.start).toFixed(1), stage: phase.stage })),
  traceLongEvents: long,
}
console.log(
  JSON.stringify(
    process.argv.includes("--brief")
      ? {
          wheels: report.wheels,
          scrolls: report.scrolls,
          startTop: report.startTop,
          endTop: report.endTop,
          frameGaps: report.frameGaps,
          longTasks: report.longTasks,
          postIdleShift: report.postIdleShift,
          resizeEvents: report.resizeEvents,
          slowBatches: report.slowBatches.slice(0, 3),
          traceLongEvents: report.traceLongEvents.slice(0, 6),
        }
      : report,
    null,
    2,
  ),
)
