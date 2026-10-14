import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFreshRequestQueue } from "@/utils/fresh-request-queue"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()
  const refreshes = createFreshRequestQueue<void>()
  const revisions = new Map<string, number>()
  let epoch = 0

  const reset = () => {
    epoch++
    console.debug(`[file-tree] reset epoch=${epoch} pending=${inflight.size}`)
    inflight.clear()
    revisions.clear()
    refreshes.clearAll()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const listDir = (input: string, opts?: { force?: boolean }): Promise<void> => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending) {
      if (!opts?.force) return pending
      revisions.set(dir, (revisions.get(dir) ?? 0) + 1)
      const mark = epoch
      const scope = options.scope()
      return refreshes.enqueue(
        dir,
        pending,
        () => (mark === epoch && scope === options.scope() ? listDir(dir, { force: true }) : Promise.resolve()),
        () => undefined,
      )
    }

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()
    const mark = epoch
    const revision = revisions.get(dir) ?? 0
    const currentRequest = () =>
      inflight.get(dir) === promise &&
      epoch === mark &&
      options.scope() === directory &&
      (revisions.get(dir) ?? 0) === revision
    console.debug(`[file-tree] load-start scope=${directory} dir=${dir} epoch=${mark}`)

    const promise = options
      .list(dir)
      .then((nodes) => {
        if (!currentRequest()) {
          console.debug(`[file-tree] discard scope=${directory} dir=${dir} epoch=${mark}`)
          return
        }
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)
        const removedDirs = prevChildren.filter(
          (child) => !nextSet.has(child) && tree.node[child]?.type === "directory",
        )

        setTree(
          "node",
          produce((draft) => {
            for (const child of prevChildren) {
              if (nextSet.has(child)) continue
              delete draft[child]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        for (const removed of removedDirs) {
          for (const path of Object.keys(tree.dir)) {
            if (path !== removed && !path.startsWith(removed + "/")) continue
            inflight.delete(path)
            revisions.delete(path)
            refreshes.clear(path)
            setTree(
              "dir",
              produce((draft) => {
                delete draft[path]
              }),
            )
          }
        }
        console.debug(`[file-tree] commit scope=${directory} dir=${dir} count=${nodes.length}`)

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nextChildren
          }),
        )
      })
      .catch((e) => {
        if (!currentRequest()) return
        const msg = e instanceof Error ? e.message : String(e)
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = msg
          }),
        )
        options.onError(msg)
      })
      .finally(() => {
        if (inflight.get(dir) !== promise) return
        inflight.delete(dir)
        revisions.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
