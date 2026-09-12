import type { FileIdentityContext } from "@/context/file/identity"
import { fileIdentityKey } from "@/context/file/identity"

/**
 * Pure-path change tree for the "changes" panel
 * (specs/performance/right-side-panels-optimization.md §5.5).
 *
 * Built directly from the changed paths in one pass over the path segments —
 * close to O(total segments + local sorts) — never from the real directory
 * tree, so deleted paths render and no filesystem listing is requested.
 *
 * Path contract: only `/` splits segments. A POSIX backslash is a filename
 * character and stays inside a segment; Windows git output already uses `/`.
 * Identity keys fold case only for Windows-local workspaces while `path`
 * keeps the authoritative manifest spelling.
 */

export type ChangeKind = "add" | "del" | "mix"

export type ChangeTreeEntry = {
  path: string
  kind: ChangeKind
}

export type ChangeTreeNode = {
  /** Comparison identity (case-folded on Windows-local workspaces). */
  key: string
  /** Authoritative spelling of the workspace-relative logical path. */
  path: string
  name: string
  type: "file" | "directory"
  kind: ChangeKind
  /** Directories only, sorted directories-first then by name. */
  children: ChangeTreeNode[]
  /** Segment lookup for O(1) trie insertion (internal). */
  byKey: Map<string, ChangeTreeNode>
}

export type ChangeTree = {
  root: ChangeTreeNode
  /** fileKey -> node, including the virtual root under "". */
  index: Map<string, ChangeTreeNode>
}

export const changeRootKey = ""

const mergeKind = (a: ChangeKind | undefined, b: ChangeKind): ChangeKind => {
  if (!a || a === b) return b
  return "mix"
}

const compareNodes = (a: ChangeTreeNode, b: ChangeTreeNode) => {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  return a.name.localeCompare(b.name)
}

const sortTree = (node: ChangeTreeNode) => {
  if (node.children.length === 0) return
  node.children.sort(compareNodes)
  for (const child of node.children) sortTree(child)
}

export function buildChangeTree(entries: readonly ChangeTreeEntry[], options?: { foldCase?: boolean }): ChangeTree {
  const fold = options?.foldCase ?? false
  const keyOf = (value: string) => (fold ? value.toLowerCase() : value)
  const root: ChangeTreeNode = {
    key: changeRootKey,
    path: "",
    name: "",
    type: "directory",
    kind: "mix",
    children: [],
    byKey: new Map(),
  }
  const index = new Map<string, ChangeTreeNode>([[changeRootKey, root]])
  let conflictWarned = false

  for (const entry of entries) {
    if (!entry.path) continue
    const segments = entry.path.split("/")
    let node = root
    let path = ""
    for (let depth = 0; depth < segments.length; depth++) {
      const segment = segments[depth]!
      const isLeaf = depth === segments.length - 1
      path = path ? `${path}/${segment}` : segment
      const segmentKey = keyOf(segment)
      let child = node.byKey.get(segmentKey)
      if (!child) {
        child = {
          key: keyOf(path),
          path,
          name: segment,
          type: isLeaf ? "file" : "directory",
          kind: entry.kind,
          children: [],
          byKey: new Map(),
        }
        node.byKey.set(segmentKey, child)
        node.children.push(child)
        index.set(child.key, child)
      } else {
        child.kind = mergeKind(child.kind, entry.kind)
        if (child.type !== (isLeaf ? "file" : "directory")) {
          // A path collides with an existing node of the other type (e.g. `a`
          // and `a/b`): keep the first authoritative spelling and surface the
          // conflict instead of silently merging two different files.
          if (!conflictWarned) {
            console.warn(`[change-tree] conflicting paths share one node: ${child.path} vs ${path}`)
            conflictWarned = true
          }
          break
        }
      }
      node = child
    }
  }

  sortTree(root)
  return { root, index }
}

/**
 * Aggregate change kind per directory for a set of changed paths. Used by the
 * all-files tree badges: a Map lookup per visible node instead of subscribing
 * to patch contents.
 */
export function aggregateChangeKinds(entries: readonly ChangeTreeEntry[], context: FileIdentityContext) {
  const out = new Map<string, ChangeKind>()
  for (const entry of entries) {
    if (!entry.path) continue
    const segments = entry.path.split("/")
    let dir = ""
    for (let depth = 0; depth < segments.length - 1; depth++) {
      dir = dir ? `${dir}/${segments[depth]}` : segments[depth]!
      const key = fileIdentityKey(dir, context)
      out.set(key, mergeKind(out.get(key), entry.kind))
    }
  }
  return out
}
