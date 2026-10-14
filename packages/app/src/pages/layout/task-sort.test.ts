import { describe, expect, test } from "bun:test"
import { sortProjectTasks, sortScheduledTasks } from "./task-sort"

for (const kind of ["scheduled", "project"] as const) {
  describe(`${kind} task sort`, () => {
    const task = (id: string, created: number, recent?: number) => ({
      id,
      time: { created, updated: 999 - created },
      lastRunAt: recent,
      lastSessionAt: recent,
    })
    const sort = kind === "scheduled"
      ? sortScheduledTasks<ReturnType<typeof task>>
      : sortProjectTasks<ReturnType<typeof task>>
    const ids = (tasks: { id: string }[]) => tasks.map((task) => task.id)

    test("creation time is descending regardless of activity", () => {
      expect(ids(sort([task("old", 1, 100), task("new", 2, 10)], "created"))).toEqual(["new", "old"])
    })

    test("recent activity is descending with missing activity last", () => {
      expect(ids(sort([task("none", 100), task("old", 3, 10), task("new", 1, 20), task("zero", 2, 0)], "recent")))
        .toEqual(["new", "old", "zero", "none"])
    })

    test("ties and missing activity fall back to creation time then id", () => {
      const tasks = [task("b", 3, 10), task("c", 1, 10), task("a", 3, 10)]
      expect(ids(sort(tasks, "recent"))).toEqual(["a", "b", "c"])
      expect(ids(sort(tasks, "created"))).toEqual(["a", "b", "c"])
      expect(ids(sort([task("b", 3), task("c", 1), task("a", 3)], "recent"))).toEqual(["a", "b", "c"])
    })

    test("does not mutate the input array or task objects", () => {
      const tasks = Object.freeze([Object.freeze(task("old", 1)), Object.freeze(task("new", 2))])
      for (const mode of ["created", "recent"] as const) {
        const result = sort(tasks, mode)
        expect(result).not.toBe(tasks)
        expect(result[0]).toBe(tasks[1])
        expect(ids([...tasks])).toEqual(["old", "new"])
      }
    })
  })
}

test("project status and updated time never outrank selected time", () => {
  const tasks = [
    { id: "progress", status: "in_progress", time: { created: 1, updated: 100 }, lastSessionAt: 1 },
    { id: "open", status: "open", time: { created: 2, updated: 1 }, lastSessionAt: 2 },
  ]
  for (const mode of ["created", "recent"] as const) {
    expect(sortProjectTasks(tasks, mode).map((task) => task.id)).toEqual(["open", "progress"])
  }
})

test("each panel uses its own activity timestamp", () => {
  const tasks = [
    { id: "run", time: { created: 1 }, lastRunAt: 20, lastSessionAt: 10 },
    { id: "session", time: { created: 2 }, lastRunAt: 10, lastSessionAt: 20 },
  ]
  expect(sortScheduledTasks(tasks, "recent").map((task) => task.id)).toEqual(["run", "session"])
  expect(sortProjectTasks(tasks, "recent").map((task) => task.id)).toEqual(["session", "run"])
})
