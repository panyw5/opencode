import { Cause, Effect, Layer, Context, Schema } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir, realpath } from "fs/promises"
import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Git } from "@/git"
import { lazy } from "@/util/lazy"
import { Config } from "@/config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import * as Log from "@opencode-ai/core/util/log"

declare const OPENCODE_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000

// Native watchers deliver events in batches. Heavy filesystem churn (git gc,
// builds, checkouts) can produce tens of thousands of events in a single
// callback. Publishing each one individually floods every Bus subscriber (SSE
// clients, the desktop bridge) and freezes both the server event loop and the
// UI. Batch the callback into short windows, coalesce duplicates, and collapse
// oversized floods to one event per directory.
const FLUSH_INTERVAL_MS = 100
const MAX_EVENTS_PER_FLUSH = 2_000

export type WatcherFileEvent = {
  file: string
  event: "add" | "change" | "unlink"
}

/**
 * Merge raw watcher events by path. The most recent kind wins, except that a
 * path created during the window stays "add" unless it was deleted again (the
 * renderer must both reload open editors and refresh the parent tree node).
 */
export function coalesceEvents(events: WatcherFileEvent[]): WatcherFileEvent[] {
  const byPath = new Map<string, { event: WatcherFileEvent["event"]; added: boolean }>()
  for (const evt of events) {
    const prev = byPath.get(evt.file)
    byPath.set(evt.file, {
      event: evt.event,
      added: (prev?.added ?? false) || evt.event === "add",
    })
  }
  return Array.from(byPath, ([file, item]) => ({
    file,
    event: item.added && item.event !== "unlink" ? ("add" as const) : item.event,
  }))
}

/**
 * Collapse add/unlink events to one representative per (parent directory,
 * kind). The renderer only uses them to refresh the parent directory, so
 * per-file granularity is not needed; "change" events are kept as-is because
 * they carry per-file reload semantics for open editors.
 */
export function collapseByDirectory(events: WatcherFileEvent[]): WatcherFileEvent[] {
  const collapsed: WatcherFileEvent[] = []
  const seen = new Set<string>()
  for (const evt of events) {
    if (evt.event === "change") {
      collapsed.push(evt)
      continue
    }
    const key = `${evt.event}\n${path.dirname(evt.file)}`
    if (seen.has(key)) continue
    seen.add(key)
    collapsed.push(evt)
  }
  return collapsed
}

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    Schema.Struct({
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* () {
          if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          const ctx = yield* InstanceState.context

          log.info("init", { directory: ctx.directory })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })
          const bridge = yield* EffectBridge.make()
          const subs: ParcelWatcher.AsyncSubscription[] = []
          const closed = new WeakSet<ParcelWatcher.AsyncSubscription>()
          const close = async (sub: ParcelWatcher.AsyncSubscription, dir: string, reason: string) => {
            if (closed.has(sub)) return
            closed.add(sub)
            log.warn(`unsubscribe begin directory=${dir} reason=${reason}`)
            await sub.unsubscribe()
            log.warn(`unsubscribe settled directory=${dir} reason=${reason}`)
          }
          let queue: WatcherFileEvent[] = []
          let flushTimer: ReturnType<typeof setTimeout> | undefined
          const KINDS = { create: "add", update: "change", delete: "unlink" } as const

          function scheduleFlush() {
            if (flushTimer) return
            flushTimer = setTimeout(() => {
              flushTimer = undefined
              flush()
            }, FLUSH_INTERVAL_MS)
          }

          function flush() {
            if (queue.length === 0) return
            const raw = queue
            queue = []

            let events = coalesceEvents(raw)
            if (events.length > MAX_EVENTS_PER_FLUSH) {
              events = collapseByDirectory(events)
              log.warn("file event flood collapsed to directories", {
                directory: ctx.directory,
                received: raw.length,
                publishing: events.length,
              })
            }
            if (events.length > MAX_EVENTS_PER_FLUSH) {
              log.warn("file event flood truncated", {
                directory: ctx.directory,
                received: raw.length,
                publishing: MAX_EVENTS_PER_FLUSH,
              })
              events = events.slice(0, MAX_EVENTS_PER_FLUSH)
            }

            for (const evt of events) void Bus.publish(ctx, Event.Updated, evt)
          }

          const cb: ParcelWatcher.SubscribeCallback = bridge.bind((err, evts) => {
            if (err) {
              log.warn(`callback error directory=${ctx.directory} error=${String(err)}`)
              return
            }
            for (const evt of evts) {
              const kind = KINDS[evt.type]
              if (!kind) continue
              queue.push({ file: evt.path, event: kind })
            }
            if (queue.length > 0) scheduleFlush()
          })

          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              log.warn(`finalize begin directory=${ctx.directory} subscriptions=${String(subs.length)}`)
              for (const sub of subs) await close(sub, ctx.directory, "scope-finalizer").catch(() => undefined)
              if (flushTimer) clearTimeout(flushTimer)
              flushTimer = undefined
              queue = []
              log.warn(`finalize settled directory=${ctx.directory} subscriptions=${String(subs.length)}`)
            }),
          )

          const subscribe = (dir: string, ignore: string[]) => {
            log.warn(`subscribe begin directory=${dir} backend=${backend} ignoreCount=${String(ignore.length)}`)
            const pending = w.subscribe(dir, cb, { ignore, backend })
            return Effect.gen(function* () {
              const sub = yield* Effect.promise(() => pending)
              subs.push(sub)
              log.warn(`subscribe success directory=${dir} backend=${backend}`)
            }).pipe(
              Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
              Effect.catchCause((cause) => {
                log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                pending.then((sub) => close(sub, dir, "subscribe-timeout")).catch(() => undefined)
                return Effect.void
              }),
            )
          }

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []

          if (yield* Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
            yield* Effect.forkScoped(
              subscribe(ctx.directory, [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(ctx.directory)]),
            )
          }

          if (ctx.project.vcs === "git") {
            const result = yield* git.run(["rev-parse", "--git-dir"], {
              cwd: ctx.worktree,
            })
            const resolved = result.exitCode === 0 ? path.resolve(ctx.worktree, result.text().trim()) : undefined
            const vcsDir = resolved ? yield* Effect.promise(() => realpath(resolved).catch(() => resolved)) : undefined
            if (
              vcsDir &&
              !cfgIgnores.includes(".git") &&
              !cfgIgnores.includes(vcsDir) &&
              (!resolved || !cfgIgnores.includes(resolved))
            ) {
              const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                (entry) => entry !== "HEAD",
              )
              yield* Effect.forkScoped(subscribe(vcsDir, ignore))
            }
          }
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))

export * as FileWatcher from "./watcher"
