import type { FileContentMode } from "./watch-policy"

// Resolver order is already priority order. Preview-mode or lower-priority
// self readers must not suppress a replace viewer's required source text.
export function filePreviewContent(viewers: readonly { mode: string; content?: FileContentMode }[]): FileContentMode {
  return viewers.find((entry) => entry.mode === "replace")?.content === "self" ? "self" : "text"
}

type Dependencies = {
  scope(): string
  client(): unknown
  normalize(input: string): string
  whenReady(): Promise<void>
  ensure(file: string): void
  self(file: string): boolean
  load(file: string, options?: { force?: boolean }): Promise<void>
  refreshSelf(file: string): Promise<void>
}

// Preparation is a preview policy, not a replacement for explicit source reads.
// Manifest readiness can outlive the directory, client, or provider that asked.
export function createFilePreviewPreparer(deps: Dependencies) {
  let epoch = 0
  return {
    async prepare(input: string, options?: { force?: boolean }): Promise<void> {
      const file = deps.normalize(input)
      if (!file) return
      const scope = deps.scope()
      const client = deps.client()
      const mark = epoch
      try {
        await deps.whenReady()
      } catch {
        // A failed manifest load must settle preparation, not strand the tab.
        // The registry can still contain built-in or previously available viewers.
      }
      if (mark !== epoch || scope !== deps.scope() || client !== deps.client()) return
      deps.ensure(file)
      if (deps.self(file)) {
        console.debug(`[file-preview] prepare path=${file} content=self force=${!!options?.force}`)
        if (options?.force) await deps.refreshSelf(file)
        return
      }
      await deps.load(file, options)
    },
    reset() {
      epoch++
    },
  }
}
