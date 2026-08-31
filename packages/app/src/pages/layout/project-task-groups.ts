import { sameWorkspacePath, workspaceKey, workspacePathAliases } from "./helpers"

export type ProjectTaskWorktreeGroup<T> = {
  directory: string
  tasks: T[]
}

type GroupableTask = {
  sessionDirectories?: string[]
}

export function taskNeedsDirectoryHydrate(task: { sessionDirectories?: string[] | null }): boolean {
  return !Array.isArray(task.sessionDirectories)
}

export function directoriesFromSessions(sessions: Array<{ directory?: string | null }>): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    const directory = session.directory?.trim()
    if (!directory) continue
    const key = workspaceKey(directory)
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(directory)
  }
  return dirs
}

/** Map a session directory onto the longest matching worktree / sandbox root. */
export function matchWorktreeRoot(directory: string, worktrees: string[]): string | undefined {
  if (!directory) return undefined
  for (const worktree of worktrees) {
    if (sameWorkspacePath(directory, worktree)) return worktree
  }

  const dirKey = workspaceKey(directory)
  let best: { worktree: string; len: number } | undefined
  for (const worktree of worktrees) {
    for (const alias of workspacePathAliases(worktree)) {
      const root = workspaceKey(alias)
      if (!root || root === "/") continue
      if (dirKey === root || dirKey.startsWith(`${root}/`)) {
        if (!best || root.length > best.len) best = { worktree, len: root.length }
      }
    }
  }
  return best?.worktree
}

/**
 * Group project tasks by worktree. `worktrees[0]` is the main checkout.
 * Unmounted tasks land on the main worktree. A task mounted in multiple
 * worktrees appears in each matching block.
 */
export function groupProjectTasksByWorktree<T extends GroupableTask>(input: {
  tasks: T[]
  worktrees: string[]
}): ProjectTaskWorktreeGroup<T>[] {
  const worktrees = input.worktrees.filter((directory) => directory.trim().length > 0)
  if (worktrees.length === 0) {
    return input.tasks.length > 0 ? [{ directory: "", tasks: input.tasks.slice() }] : []
  }

  const main = worktrees[0]
  const buckets = new Map<string, T[]>()
  for (const worktree of worktrees) {
    const key = workspaceKey(worktree)
    if (!buckets.has(key)) buckets.set(key, [])
  }

  const extra: ProjectTaskWorktreeGroup<T>[] = []
  const extraIndex = new Map<string, number>()

  const add = (directory: string, task: T) => {
    const key = workspaceKey(directory)
    const known = buckets.get(key)
    if (known) {
      if (!known.includes(task)) known.push(task)
      return
    }
    const existing = extraIndex.get(key)
    if (existing !== undefined) {
      const group = extra[existing]
      if (group && !group.tasks.includes(task)) group.tasks.push(task)
      return
    }
    extraIndex.set(key, extra.length)
    extra.push({ directory, tasks: [task] })
  }

  for (const task of input.tasks) {
    const dirs = (task.sessionDirectories ?? []).map((directory) => directory.trim()).filter(Boolean)
    if (dirs.length === 0) {
      add(main, task)
      continue
    }
    const roots = new Set<string>()
    for (const directory of dirs) {
      roots.add(matchWorktreeRoot(directory, worktrees) ?? directory)
    }
    for (const root of roots) add(root, task)
  }

  return [
    ...worktrees
      .filter((worktree, index) => worktrees.findIndex((item) => workspaceKey(item) === workspaceKey(worktree)) === index)
      .map((directory) => ({
        directory,
        tasks: buckets.get(workspaceKey(directory)) ?? [],
      })),
    ...extra,
  ]
}
