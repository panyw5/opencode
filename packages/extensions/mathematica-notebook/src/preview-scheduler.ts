import { PREVIEW_LIMITS as L, type CellsResponse, type Preview } from "./preview-protocol"

type Listener = (result: Preview | Error) => void
type Task = { index: number; listeners: Set<Listener>; running: boolean }
type Batch = { tasks: Task[]; controller: AbortController }

// One scheduler per viewer: bounded data cache, no retained DOM, shared batches.
export function createPreviewScheduler(
  fetch: (revision: string, indexes: number[], signal: AbortSignal) => Promise<CellsResponse>,
  log: (message: string) => void,
  frames = {
    request: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancel: (id: number) => cancelAnimationFrame(id),
  },
) {
  const tasks = new Map<number, Task>()
  const cache = new Map<number, { result: Preview; bytes: number }>()
  const batches = new Set<Batch>()
  const commits: (() => void)[] = []
  let bytes = 0
  let revision = ""
  let generation = 0
  let frame: number | undefined
  let commitFrame: number | undefined
  let disposed = false
  const commit = () => {
    commitFrame = undefined
    const started = performance.now()
    // Each preview is independently bounded. Avoid mounting an entire RPC batch
    // in a single task, which defeats list virtualization on rich notebooks.
    while (commits.length && performance.now() - started < 4) commits.shift()!()
    if (commits.length) commitFrame = frames.request(commit)
  }
  const deliver = (task: Task, result: Preview | Error, epoch: number) => {
    commits.push(() => {
      if (disposed || epoch !== generation) return
      for (const listener of task.listeners) listener(result)
    })
    if (commitFrame === undefined) commitFrame = frames.request(commit)
  }
  const schedule = () => {
    if (!disposed && frame === undefined) frame = frames.request(flush)
  }
  const flush = () => {
    frame = undefined
    while (batches.size < 2) {
      const selected = [...tasks.values()].filter((task) => !task.running && task.listeners.size).slice(0, L.batch)
      if (!selected.length) break
      for (const task of selected) task.running = true
      const epoch = generation
      const batch: Batch = { tasks: selected, controller: new AbortController() }
      batches.add(batch)
      log(`notebook preview batch cells=${selected.length} queued=${tasks.size}`)
      void fetch(
        revision,
        selected.map((task) => task.index),
        batch.controller.signal,
      )
        .then((response) => {
          if (epoch !== generation || response.revision !== revision || batch.controller.signal.aborted) return
          for (const task of selected) {
            const result = response.cells.find((cell) => cell.index === task.index)?.preview
            // A byte-limited batch may return a prefix; leave the rest queued.
            if (!result) {
              task.running = false
              continue
            }
            const size = JSON.stringify(result).length * 2 + 128
            const old = cache.get(task.index)
            if (old) bytes -= old.bytes
            cache.delete(task.index)
            cache.set(task.index, { result, bytes: size })
            bytes += size
            while (cache.size > 128 || bytes > 8 * 1024 * 1024) {
              const [key, entry] = cache.entries().next().value!
              cache.delete(key)
              bytes -= entry.bytes
            }
            if (tasks.get(task.index) === task) tasks.delete(task.index)
            deliver(task, result, epoch)
          }
        })
        .catch((error) => {
          if (epoch !== generation) return
          for (const task of selected) {
            if (tasks.get(task.index) === task) tasks.delete(task.index)
            if (!batch.controller.signal.aborted)
              deliver(task, error instanceof Error ? error : Error(String(error)), epoch)
          }
        })
        .finally(() => {
          batches.delete(batch)
          schedule()
        })
    }
  }
  const reset = (next: string) => {
    generation++
    revision = next
    for (const batch of batches) batch.controller.abort()
    batches.clear()
    tasks.clear()
    cache.clear()
    commits.length = 0
    bytes = 0
  }
  return {
    reset,
    // Synchronous cache read used to seed a remounted cell before the first
    // paint, so virtualization never flashes a loading frame on a cache hit.
    peek(index: number) {
      const hit = cache.get(index)
      if (!hit) return
      cache.delete(index)
      cache.set(index, hit)
      return hit.result
    },
    request(index: number, listener: Listener) {
      const hit = cache.get(index)
      if (hit) {
        cache.delete(index)
        cache.set(index, hit)
        listener(hit.result)
        return () => {}
      }
      let task = tasks.get(index)
      if (!task) {
        task = { index, listeners: new Set(), running: false }
        tasks.set(index, task)
      }
      task.listeners.add(listener)
      schedule()
      const subscribed = task
      return () => {
        subscribed.listeners.delete(listener)
        if (!subscribed.listeners.size && !subscribed.running) tasks.delete(index)
        for (const batch of batches) {
          if (!batch.tasks.every((item) => !item.listeners.size)) continue
          for (const item of batch.tasks) if (tasks.get(item.index) === item) tasks.delete(item.index)
          batch.controller.abort()
        }
      }
    },
    dispose() {
      disposed = true
      reset("")
      if (frame !== undefined) frames.cancel(frame)
      if (commitFrame !== undefined) frames.cancel(commitFrame)
    },
  }
}
export type PreviewScheduler = ReturnType<typeof createPreviewScheduler>
