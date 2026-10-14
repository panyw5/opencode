export type TaskSort = "created" | "recent"

type TaskTime = { id: string; time: { created: number } }

function sortTasks<T extends TaskTime>(tasks: readonly T[], sort: TaskSort, recent: (task: T) => number | undefined): T[] {
  return tasks.slice().sort((a, b) => {
    if (sort === "recent") {
      const left = recent(a)
      const right = recent(b)
      if (left === undefined && right !== undefined) return 1
      if (left !== undefined && right === undefined) return -1
      if (left !== undefined && right !== undefined && left !== right) return right - left
    }
    return b.time.created - a.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

export function sortScheduledTasks<T extends TaskTime & { lastRunAt?: number }>(tasks: readonly T[], sort: TaskSort): T[] {
  return sortTasks(tasks, sort, (task) => task.lastRunAt)
}

export function sortProjectTasks<T extends TaskTime & { lastSessionAt?: number }>(tasks: readonly T[], sort: TaskSort): T[] {
  return sortTasks(tasks, sort, (task) => task.lastSessionAt)
}
