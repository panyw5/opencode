import type { FileContent } from "@opencode-ai/sdk/v2"
import { createFreshRequestQueue } from "@/utils/fresh-request-queue"

type ContentLoaderDeps = {
  scope(): string
  normalize(input: string): string
  loaded(file: string): boolean
  read(file: string): Promise<{ data?: FileContent }>
  onLoading(file: string): void
  onContent(file: string, content: FileContent | undefined): void
  onError(file: string, error: unknown): void
}

export function createFileContentLoader(deps: ContentLoaderDeps) {
  const inflight = new Map<string, Promise<void>>()
  const revisions = new Map<string, number>()
  const refreshes = createFreshRequestQueue<void>()
  let epoch = 0
  const load = (input: string, options?: { force?: boolean }): Promise<void> => {
    const file = deps.normalize(input)
    if (!file) return Promise.resolve()
    const scope = deps.scope()
    const key = `${scope}\n${file}`
    if (!options?.force && deps.loaded(file)) return Promise.resolve()
    const pending = inflight.get(key)
    if (pending) {
      if (!options?.force) return pending
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      const mark = epoch
      return refreshes.enqueue(
        key,
        pending,
        () => (mark === epoch && deps.scope() === scope ? load(file, { force: true }) : Promise.resolve()),
        () => undefined,
      )
    }
    const mark = epoch
    const revision = revisions.get(key) ?? 0
    const current = () =>
      inflight.get(key) === promise &&
      epoch === mark &&
      deps.scope() === scope &&
      (revisions.get(key) ?? 0) === revision
    deps.onLoading(file)
    console.debug(`[file-content] load-start scope=${scope} file=${file} epoch=${mark}`)
    const promise = deps
      .read(file)
      .then((response) => {
        if (!current()) {
          console.debug(`[file-content] discard scope=${scope} file=${file} epoch=${mark}`)
          return
        }
        console.debug(`[file-content] commit scope=${scope} file=${file} bytes=${response.data?.content.length ?? 0}`)
        deps.onContent(file, response.data)
      })
      .catch((error) => {
        if (!current()) return
        console.warn(
          `[file-content] error scope=${scope} file=${file} detail=${error instanceof Error ? error.message : String(error)}`,
        )
        deps.onError(file, error)
      })
      .finally(() => {
        if (inflight.get(key) !== promise) return
        inflight.delete(key)
        revisions.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }
  return {
    load,
    reset() {
      epoch++
      console.debug(`[file-content] reset epoch=${epoch} pending=${inflight.size}`)
      inflight.clear()
      revisions.clear()
      refreshes.clearAll()
    },
  }
}
