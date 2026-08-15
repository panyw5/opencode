import type { SessionBarTab } from "@/context/layout"
import { workspaceKey } from "@/pages/layout/helpers"

export function withParentSessionTab(
  tabs: readonly SessionBarTab[],
  directory: string,
  parentID: string,
  maxTabs: number,
): SessionBarTab[] {
  const key = workspaceKey(directory)
  if (tabs.some((tab) => tab.id === parentID && workspaceKey(tab.directory) === key)) {
    return [...tabs]
  }
  const next = [
    ...tabs,
    {
      directory,
      id: parentID,
      title: undefined as string | undefined,
      parentID: undefined as string | null | undefined,
    },
  ]
  if (next.length <= maxTabs) return next
  return next.slice(next.length - maxTabs)
}

export type SessionBarAncestor = {
  id: string
  title?: string
  parentID?: string | null
}

/** Collect missing ancestor tabs from nearest parent up to the root (nearest-first). */
export function collectMissingAncestorTabs(
  openIDs: ReadonlySet<string>,
  parentID: string,
  byID: ReadonlyMap<string, { id: string; title?: string; parentID?: string }>,
): SessionBarAncestor[] {
  const chain: SessionBarAncestor[] = []
  const seen = new Set<string>()
  let currentID: string | undefined = parentID
  while (currentID && !openIDs.has(currentID) && !seen.has(currentID)) {
    seen.add(currentID)
    const session = byID.get(currentID)
    chain.push({
      id: currentID,
      title: session?.title,
      parentID: session ? (session.parentID ?? null) : undefined,
    })
    currentID = session?.parentID
  }
  return chain
}
