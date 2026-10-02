import fs from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Command } from "@/command"
import { GlobalBus } from "@/bus/global"
import { Event } from "@/server/event"

const log = Log.create({ service: "server.global-config-watcher" })

// Only the merged global config files — the directory also holds opencode.db,
// logs, and channel state whose churn must not trigger refreshes.
const WATCHED_FILES = new Set(["config.json", "opencode.json", "opencode.jsonc"])
const DEBOUNCE_MS = 500

let started = false

/**
 * Watch the global config files for hand edits and publish `global.config.updated`.
 *
 * Config changes made through the app's own API publish that event themselves
 * (see the global config handlers), but edits written directly to
 * `~/.config/opencode/opencode.jsonc` (or config.json / opencode.json) never
 * reach connected clients — the desktop app then keeps serving stale
 * provider/model metadata (e.g. model variants added by hand) until a reload.
 * Watch the files, revalidate the server-side config caches, and emit the same
 * event so every client refreshes.
 */
export function startGlobalConfigWatcher() {
  if (started) return
  started = true

  const dir = Global.Path.config
  const mtimes = new Map<string, number>()
  let lastInfo: string | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    debounce = undefined
    let changed = false
    for (const name of WATCHED_FILES) {
      const file = path.join(dir, name)
      try {
        const mtime = fs.statSync(file).mtimeMs
        if (mtimes.get(name) !== mtime) {
          mtimes.set(name, mtime)
          changed = true
        }
      } catch {
        if (mtimes.delete(name)) changed = true
      }
    }
    if (!changed) return

    const program = Effect.gen(function* () {
      const config = yield* Config.Service
      // Drop cached global + per-instance config so the next reads see the
      // hand edit; provider.list() keys its cache off the instance config.
      yield* config.invalidate()
      const info = yield* config.getGlobal()
      const serialized = JSON.stringify(info)
      // Comment/formatting-only edits parse to the same config — skip the
      // client notification (and the provider re-fetch it triggers).
      if (serialized === lastInfo) return
      lastInfo = serialized
      const command = yield* Command.Service
      yield* command.invalidate()
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: Event.ConfigUpdated.type, properties: info },
      })
      log.info("global config updated from disk")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Command.defaultLayer, Config.defaultLayer).pipe(Layer.provide(Config.defaultLayer)),
      ),
      Effect.catchCause((cause) => {
        log.error("global config refresh failed", { cause: String(cause) })
        return Effect.void
      }),
    )
    void Effect.runPromise(program)
  }

  const schedule = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(flush, DEBOUNCE_MS)
  }

  try {
    const watcher = fs.watch(dir, { persistent: false }, (_, filename) => {
      if (!filename || WATCHED_FILES.has(filename)) schedule()
    })
    watcher.on("error", (error) => {
      log.error("global config watcher failed", { error: String(error) })
    })
    log.info("watching global config files", { dir, files: [...WATCHED_FILES].join(",") })
  } catch (error) {
    log.error("failed to watch global config files", { dir, error: String(error) })
  }
}
