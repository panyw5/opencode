import fuzzysort from "fuzzysort"

/** Filter without changing the panels' existing ordering or worktree grouping. */
export function filterTasks<T>(tasks: T[], query: string, keys: (keyof T & string)[]): T[] {
  const search = query.trim()
  if (!search) return tasks
  const needle = search.toLocaleLowerCase()
  const matches = new Set(fuzzysort.go(search, tasks, { keys, threshold: 0.25 }).map((result) => result.obj))
  // Exact fragments must remain searchable even deep inside long descriptions.
  // Weak subsequence matches across an entire document are not useful results.
  return tasks.filter(
    (task) =>
      matches.has(task) ||
      keys.some((key) => {
        const value = task[key]
        return typeof value === "string" && value.toLocaleLowerCase().includes(needle)
      }),
  )
}
