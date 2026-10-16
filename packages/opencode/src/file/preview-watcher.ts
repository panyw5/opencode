import { watch, type FSWatcher } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Queue, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "file.preview-watcher" })

export const Change = Schema.Struct({
  type: Schema.Literal("file.watcher.updated"),
  properties: Schema.Struct({ file: Schema.String, event: Schema.Literal("change") }),
})

// Watch existing parents up to the workspace boundary, filtering to one leaf.
// No recursive scan, file polling, or project runtime lease is required.
export const subscribe = (input: string) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = path.resolve(ctx.directory, input)
    if (file === path.resolve(ctx.directory)) return yield* Effect.die(new Error("A file path is required"))
    if (!containsPath(file, { ...ctx, nativeDirectory: ctx.nativeDirectory ?? ctx.directory })) {
      return yield* Effect.die(new Error("Access denied: path escapes project directory"))
    }
    const bridge = yield* EffectBridge.make()
    const event: typeof Change.Type = { type: "file.watcher.updated", properties: { file, event: "change" } }
    return Stream.callback<typeof Change.Type>((queue) =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          log.info(`subscribe file=${file}`)
          const watchers = new Map<string, { handle: FSWatcher; identity: string }>()
          let timer: ReturnType<typeof setTimeout> | undefined
          let closed = false
          const failed = (error: unknown) => {
            if (closed) return
            log.warn(`error file=${file} detail=${String(error)}`)
            Queue.endUnsafe(queue)
          }
          const attach = async () => {
            const relative = path.relative(ctx.directory, file)
            const boundary = relative.startsWith(`..${path.sep}`) ? ctx.worktree : ctx.directory
            let directory = path.dirname(file)
            while (true) {
              const info = await stat(directory).catch(() => undefined)
              if (closed) return
              const existing = watchers.get(directory)
              const identity = info?.isDirectory() ? `${info.dev}:${info.ino}` : undefined
              if (existing && existing.identity !== identity) {
                existing.handle.close()
                watchers.delete(directory)
              }
              if (identity && !watchers.has(directory)) {
                const parent = directory
                const leaf = path.relative(parent, file).split(path.sep)[0]
                const handle = watch(
                  parent,
                  bridge.bind((kind, name) => {
                    if (name && String(name) !== leaf && String(name) !== path.basename(parent)) return
                    if (timer) return
                    timer = setTimeout(
                      bridge.bind(() => {
                        timer = undefined
                        if (closed) return
                        log.info(`changed file=${file} kind=${kind}`)
                        Queue.offerUnsafe(queue, event)
                        void attach().catch(failed)
                      }),
                      50,
                    )
                  }),
                )
                handle.on("error", bridge.bind(failed))
                watchers.set(parent, { handle, identity })
                log.info(`ready file=${file} parent=${parent}`)
              }
              const ancestor = path.dirname(directory)
              if (!path.relative(boundary, directory) || ancestor === directory) break
              directory = ancestor
            }
          }
          const close = () => {
            closed = true
            if (timer) clearTimeout(timer)
            for (const watcher of watchers.values()) watcher.handle.close()
            watchers.clear()
          }
          try {
            await attach()
            if (!watchers.size) throw new Error(`No accessible parent for ${file}`)
          } catch (error) {
            close()
            throw error
          }
          // Initial reconciliation happens only after native watch registration.
          Queue.offerUnsafe(queue, event)
          return close
        }),
        (close) =>
          Effect.sync(() => {
            close()
            log.info(`unsubscribe file=${file}`)
          }),
      ),
    )
  })
