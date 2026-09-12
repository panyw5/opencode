import { batch, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2"

/**
 * Review data service for the right-side panels (specs/performance/
 * right-side-panels-optimization.md §4.2).
 *
 * Owns the git/branch VCS list lifecycle for one connection + workspace,
 * independent of whether the review DOM is mounted:
 *
 *  - single-flight per mode: an in-flight request is never canceled by new
 *    events; events keep merging into `dirty` and at most one follow-up flush
 *    runs after the response commits.
 *  - merged refresh: file events only mark `dirty` and are flushed on a short
 *    window (150ms) capped by a max merge wait, so an event storm produces a
 *    serial chain of refreshes, never concurrent full diffs.
 *  - stable updates: responses reconcile by `file`, so untouched records keep
 *    object identity and the list is never cleared before the refresh lands.
 *  - errors keep the previous data, mark dirty and retry with bounded
 *    backoff; nothing retries while the panel is hidden.
 *  - responses only commit to the connection/workspace epoch they were
 *    requested from; stale responses are dropped.
 */

export type VcsMode = "git" | "branch"

export type ReviewRefreshReason =
  | "open"
  | "warmup"
  | "event"
  | "branch"
  | "turn-idle"
  | "manual"
  | "workspace"
  | "retry"

export type ReviewVcsState = {
  data: FileDiff[]
  /** True until the very first request for this mode settles. */
  initialLoading: boolean
  /** True while a background refresh runs after data already exists. */
  refreshing: boolean
  error: string | undefined
  /** Events arrived that the current data does not reflect yet. */
  dirty: boolean
}

const FLUSH_WINDOW_MS = 150
const MAX_MERGE_WAIT_MS = 1000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const SLOW_REQUEST_MS = 300

type ReviewVcsInternal = ReviewVcsState & {
  requestedGeneration: number
  appliedGeneration: number
  inflight: Promise<void> | undefined
  retryTimer: number | undefined
  retryCount: number
  dirtySince: number | undefined
}

const freshEntry = (): ReviewVcsInternal => ({
  data: [],
  initialLoading: true,
  refreshing: false,
  error: undefined,
  dirty: false,
  requestedGeneration: 0,
  appliedGeneration: 0,
  inflight: undefined,
  retryTimer: undefined,
  retryCount: 0,
  dirtySince: undefined,
})

export function createReviewDataService(input: {
  /** Workspace identity; a change here isolates in-flight requests (epoch). */
  directory: () => string | undefined
  /** Whether VCS data is available at all (e.g. project is a git repo). */
  enabled: () => boolean
  /** Whether the panel currently wants data; hidden panels never schedule work. */
  visible: () => boolean
  /** Only the active mode is refreshed by event flushes. */
  active?: () => VcsMode | undefined
  fetch: (mode: VcsMode) => Promise<FileDiff[]>
}) {
  const modes = ["git", "branch"] as const
  const [state, setState] = createStore<Record<VcsMode, ReviewVcsInternal>>({
    git: freshEntry(),
    branch: freshEntry(),
  })

  let flushTimer: number | undefined
  // Bumped on reset so a same-directory in-flight response cannot land after
  // the entry was recreated (epoch alone does not cover workspace-local resets).
  let isolation = 0
  // Window-aggregated event counter for observability: file storms log one
  // merged line per flush instead of one line per file event.
  let mergedEvents = 0

  const epoch = () => input.directory() ?? ""
  const debug = (message: string) => console.debug(`[review-data] ${message}`)

  const clearModeTimers = (mode: VcsMode) => {
    const entry = untrack(() => state[mode])
    if (entry.retryTimer !== undefined) {
      window.clearTimeout(entry.retryTimer)
      setState(mode, "retryTimer", undefined)
    }
  }

  const scheduleFlush = () => {
    if (flushTimer !== undefined) return
    const since = untrack(() => {
      let first: number | undefined
      for (const mode of modes) {
        const value = state[mode].dirtySince
        if (value !== undefined && (first === undefined || value < first)) first = value
      }
      return first
    })
    const elapsed = since === undefined ? 0 : Date.now() - since
    const delay = Math.max(0, Math.min(FLUSH_WINDOW_MS, MAX_MERGE_WAIT_MS - elapsed))
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined
      flush()
    }, delay)
  }

  const flush = () => {
    if (flushTimer !== undefined) {
      window.clearTimeout(flushTimer)
      flushTimer = undefined
    }
    const visible = untrack(input.visible)
    // Hidden panels keep dirty but never start work; ensure() re-consumes the
    // pending dirty state when the panel becomes visible again.
    if (!visible) return
    const active = untrack(() => input.active?.())
    const starting: string[] = []
    for (const mode of modes) {
      const entry = untrack(() => state[mode])
      if (!entry.dirty || entry.inflight) continue
      if (entry.retryTimer !== undefined) continue
      // Event storms only refresh what the panel is looking at; other modes
      // stay dirty and are consumed by ensure() when they become active.
      if (active !== undefined && mode !== active) continue
      starting.push(mode)
      start(mode, "event")
    }
    debug(`flush active=${active ?? "none"} mergedEvents=${mergedEvents} starting=${starting.join("+") || "none"}`)
    mergedEvents = 0
  }

  const start = (mode: VcsMode, reason: ReviewRefreshReason) => {
    if (!untrack(input.enabled)) return
    if (untrack(() => state[mode].inflight)) return
    const at = epoch()
    const atIsolation = isolation
    const generation = untrack(() => state[mode].requestedGeneration) + 1
    batch(() => {
      setState(mode, "requestedGeneration", generation)
      setState(mode, "dirty", false)
      setState(mode, "dirtySince", undefined)
      setState(mode, "refreshing", !untrack(() => state[mode].initialLoading))
    })
    const startedAt = Date.now()

    const task = input
      .fetch(mode)
      .then((data) => {
        if (epoch() !== at || isolation !== atIsolation) {
          debug(`drop stale response mode=${mode} reason=${reason} generation=${generation}`)
          return
        }
        const took = Date.now() - startedAt
        if (took > SLOW_REQUEST_MS) {
          debug(`slow vcs fetch mode=${mode} reason=${reason} ms=${took} files=${data.length}`)
        } else {
          debug(`vcs fetch done mode=${mode} reason=${reason} ms=${took} files=${data.length}`)
        }
        batch(() => {
          setState(mode, "appliedGeneration", generation)
          // Reconcile by file so untouched records keep object identity and
          // mounted diff bodies are not rebuilt.
          setState(mode, "data", reconcile(data, { key: "file" }))
          setState(mode, "initialLoading", false)
          setState(mode, "refreshing", false)
          setState(mode, "error", undefined)
          setState(mode, "retryCount", 0)
        })
        // Events that landed during the request keep the list marked dirty;
        // commit the (temporarily old) value, then run one follow-up flush.
        if (untrack(() => state[mode].dirty)) scheduleFlush()
      })
      .catch((error) => {
        if (epoch() !== at || isolation !== atIsolation) return
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[review-data] vcs fetch failed mode=${mode} reason=${reason} error=${message}`)
        const retries = untrack(() => state[mode].retryCount) + 1
        batch(() => {
          // Keep the previous data visible; only the error/dirty markers move.
          setState(mode, "initialLoading", false)
          setState(mode, "refreshing", false)
          setState(mode, "error", message)
          setState(mode, "retryCount", retries)
          setState(mode, "dirty", true)
        })
        if (retries <= RETRY_DELAYS_MS.length && untrack(input.visible)) {
          const delay = RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length) - 1]!
          setState(
            mode,
            "retryTimer",
            window.setTimeout(() => {
              setState(mode, "retryTimer", undefined)
              flush()
            }, delay),
          )
        }
      })
      .finally(() => {
        if (untrack(() => state[mode].inflight) === task) setState(mode, "inflight", undefined)
      })

    setState(mode, "inflight", task)
  }

  /** Load now when the mode has no data yet or pending dirty events. */
  const ensure = (mode: VcsMode, reason: ReviewRefreshReason = "open") => {
    const entry = untrack(() => state[mode])
    if (!entry.initialLoading && !entry.dirty) return
    if (entry.inflight) return
    // A pending flush fires within the merge window; let it batch this in.
    if (entry.retryTimer !== undefined) return
    if (!entry.initialLoading && flushTimer !== undefined) return
    start(mode, reason)
  }

  /** Explicit refresh (manual/idle/branch). Single-flight; merges into dirty. */
  const refresh = (mode: VcsMode | undefined, reason: ReviewRefreshReason) => {
    const list = mode ? [mode] : modes
    for (const item of list) {
      if (!untrack(input.enabled)) continue
      clearModeTimers(item)
      const entry = untrack(() => state[item])
      if (entry.inflight) {
        batch(() => {
          setState(item, "dirty", true)
          setState(item, "dirtySince", Date.now())
        })
        continue
      }
      start(item, reason)
    }
  }

  /** File events: merge into dirty, refresh on the coalescing window. */
  const notifyEvents = () => {
    if (!untrack(input.enabled)) return
    const now = Date.now()
    mergedEvents++
    batch(() => {
      for (const mode of modes) {
        // Events invalidate both modes; each becomes stale (dirty) until its
        // next request commits. Never-opened modes stay unloaded and are
        // fetched by ensure() when the panel actually shows them.
        if (!untrack(() => state[mode].dirty)) {
          setState(mode, "dirty", true)
          setState(mode, "dirtySince", now)
        } else if (untrack(() => state[mode].dirtySince) === undefined) {
          setState(mode, "dirtySince", now)
        }
      }
    })
    scheduleFlush()
  }

  /** Workspace/connection switch: cancel pending work, isolate old results. */
  const reset = (reason: ReviewRefreshReason = "workspace") => {
    if (flushTimer !== undefined) {
      window.clearTimeout(flushTimer)
      flushTimer = undefined
    }
    isolation++
    batch(() => {
      for (const mode of modes) {
        clearModeTimers(mode)
        setState(mode, reconcile(freshEntry()))
      }
    })
    debug(`reset reason=${reason} isolation=${isolation}`)
  }

  const dispose = () => {
    if (flushTimer !== undefined) {
      window.clearTimeout(flushTimer)
      flushTimer = undefined
    }
    for (const mode of modes) clearModeTimers(mode)
  }

  const inspect = () =>
    untrack(() => ({
      git: {
        inflight: state.git.inflight !== undefined,
        dirty: state.git.dirty,
        requested: state.git.requestedGeneration,
        applied: state.git.appliedGeneration,
        retries: state.git.retryCount,
      },
      branch: {
        inflight: state.branch.inflight !== undefined,
        dirty: state.branch.dirty,
        requested: state.branch.requestedGeneration,
        applied: state.branch.appliedGeneration,
        retries: state.branch.retryCount,
      },
      epoch: epoch(),
    }))

  return { state, ensure, refresh, notifyEvents, reset, dispose, inspect }
}

export type ReviewDataService = ReturnType<typeof createReviewDataService>
