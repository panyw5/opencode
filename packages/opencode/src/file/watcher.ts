import { Cause, Deferred, Duration, Effect, Layer, Context, Schedule, Schema } from "effect"
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

export function planEvents(events: WatcherFileEvent[], limit = MAX_EVENTS_PER_FLUSH) {
  const merged = coalesceEvents(events)
  // Losing precision is safe only if consumers know the whole scope is stale.
  return { events: merged.length > limit ? [] : merged, invalidated: merged.length > limit }
}

export const Event = {
  Invalidated: BusEvent.define("file.watcher.invalidated", Schema.Struct({ directory: Schema.String })),
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
          const subs = new Set<ParcelWatcher.AsyncSubscription>()
          const closed = new WeakSet<ParcelWatcher.AsyncSubscription>()
          const close = async (sub: ParcelWatcher.AsyncSubscription, dir: string, reason: string) => {
            if (closed.has(sub)) return
            closed.add(sub)
            subs.delete(sub)
            log.warn(`unsubscribe begin directory=${dir} reason=${reason}`)
            await sub.unsubscribe()
            log.warn(`unsubscribe settled directory=${dir} reason=${reason}`)
          }
          let queue: WatcherFileEvent[] = []
          let invalidated = false
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
            if (queue.length === 0 && !invalidated) return
            const raw = queue
            queue = []

            const plan = planEvents(raw)
            if (plan.invalidated || invalidated) {
              invalidated = false
              log.warn("file event flood invalidated scope", {
                directory: ctx.directory,
                received: raw.length,
              })
              void Bus.publish(ctx, Event.Invalidated, { directory: ctx.directory })
              return
            }

            for (const evt of plan.events) void Bus.publish(ctx, Event.Updated, evt)
          }

          const cb: ParcelWatcher.SubscribeCallback = bridge.bind((err, evts) => {
            if (err) {
              log.warn(`callback error directory=${ctx.directory} error=${String(err)}`)
              invalidated = true
              queue = []
              scheduleFlush()
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
              log.warn(`finalize begin directory=${ctx.directory} subscriptions=${String(subs.size)}`)
              for (const sub of subs) await close(sub, ctx.directory, "scope-finalizer").catch(() => undefined)
              if (flushTimer) clearTimeout(flushTimer)
              flushTimer = undefined
              queue = []
              invalidated = false
              log.warn(`finalize settled directory=${ctx.directory} subscriptions=${String(subs.size)}`)
            }),
          )

          const subscribe = (dir: string, ignore: string[]) => {
            return Effect.gen(function* () {
              const failed = yield* Deferred.make<never, Error>()
              log.warn(`subscribe begin directory=${dir} backend=${backend} ignoreCount=${String(ignore.length)}`)
              const pending = w.subscribe(
                dir,
                bridge.bind((error, events) => {
                  cb(error, events)
                  if (error) bridge.fork(Deferred.fail(failed, new Error(String(error))))
                }),
                { ignore, backend },
              )
              yield* Effect.acquireRelease(
                Effect.promise(() => pending).pipe(
                  Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
                  Effect.catchCause((cause) => {
                    pending.then((sub) => close(sub, dir, "subscribe-failed")).catch(() => undefined)
                    return Effect.fail(new Error(Cause.pretty(cause)))
                  }),
                ),
                (sub) => Effect.promise(() => close(sub, dir, "subscription-ended")).pipe(Effect.ignore),
              ).pipe(
                Effect.tap((sub) =>
                  Effect.sync(() => {
                    subs.add(sub)
                  }),
                ),
              )
              log.warn(`subscribe success directory=${dir} backend=${backend}`)
              yield* Deferred.await(failed)
            }).pipe(
              Effect.scoped,
              Effect.tapError((error) =>
                Effect.sync(() => log.warn(`subscription retry directory=${dir} error=${error.message}`)),
              ),
              Effect.retry({
                schedule: Schedule.exponential("1 second").pipe(
                  Schedule.modifyDelay((_, delay) => Effect.succeed(Math.min(Duration.toMillis(delay), 30_000))),
                ),
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
