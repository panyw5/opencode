import { workspaceKey } from "@/pages/layout/helpers"
import type { SessionBarTab } from "@/context/layout"

/**
 * Directories whose full session list should warm on cold start. Only the
 * workspace behind the active route qualifies; background-tab directories stay
 * cold so the backend instance is built lazily on first switch.
 */
export function pickWarmDirectories(tabs: Array<Pick<SessionBarTab, "directory">>, activeDirectory: string): string[] {
  const activeKey = workspaceKey(activeDirectory)
  if (!activeKey) return []
  const dirs = new Set<string>()
  for (const tab of tabs) {
    if (workspaceKey(tab.directory) !== activeKey) continue
    dirs.add(tab.directory)
  }
  return [...dirs]
}

/**
 * Whether a tab needs a per-session metadata fetch. Cold background tabs rely
 * on their persisted title (zero requests); the fetch only covers tabs with no
 * stored title, or sessions missing from an already-loaded directory list.
 */
export function shouldFetchTabMeta(input: { title?: string; sessionsReady: boolean; sessionInList: boolean }): boolean {
  if (input.sessionsReady) return !input.sessionInList
  return !input.title
}
