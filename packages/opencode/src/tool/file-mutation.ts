import { Effect, Semaphore } from "effect"
import type { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import * as Log from "@opencode-ai/core/util/log"
import path from "node:path"

const log = Log.create({ service: "tool.file-mutation" })
const locks = new Map<string, Semaphore.Semaphore>()

export function lock(file: string) {
  const key = path.resolve(file)
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

export function withLocks<A, E, R>(files: string[], action: Effect.Effect<A, E, R>) {
  return [...new Set(files.map((file) => path.resolve(file)))]
    .sort()
    .reduceRight((effect, file) => lock(file).withPermits(1)(effect), action)
}

/** Permission prompts can outlive the baseline read. Never overwrite a stale baseline. */
export const assertCurrent = Effect.fn("FileMutation.assertCurrent")(function* (
  fs: AppFileSystem.Interface,
  file: string,
  expected: string | null,
) {
  const exists = yield* fs.existsSafe(file)
  const current = exists ? (yield* Bom.readFile(fs, file)).text : null
  if (current === expected) {
    log.info("file mutation baseline verified", { file, exists })
    return
  }
  log.warn("file mutation baseline changed", { file, expectedExists: expected !== null, exists })
  return yield* Effect.die(new Error(`File changed while preparing edit; read it again before retrying: ${file}`))
})
