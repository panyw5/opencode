import { describe, expect, test } from "bun:test"
import type { RecentProjectTask } from "@opencode-ai/sdk/v2/client"
import { filterManagedProjectTasks } from "./project-tasks-utils"

const task = (id: string, overrides: Partial<RecentProjectTask> = {}): RecentProjectTask => ({
  id,
  projectID: "a",
  title: id,
  description: "",
  descriptionPath: "prd.md",
  status: "open",
  progress: { total: 0, completed: 0, inProgress: 0, pending: 0, cancelled: 0 },
  sessionCount: 0,
  sessionDirectories: [],
  directory: "/tmp/a",
  time: { created: 1, updated: 1 },
  recentAt: 1,
  ...overrides,
})
const defaults = { projectID: "all", status: "active", query: "", sort: "recent" } as const

describe("project task manager", () => {
  test("unarchived includes completed tasks and all statuses includes archived tasks", () => {
    const tasks = [task("open"), task("done", { status: "done" }), task("archived", { status: "archived" })]
    expect(filterManagedProjectTasks(tasks, defaults).map((task) => task.id)).toEqual(["done", "open"])
    expect(filterManagedProjectTasks(tasks, { ...defaults, status: "all" })).toHaveLength(3)
    expect(filterManagedProjectTasks(tasks, { ...defaults, status: "archived" }).map((task) => task.id)).toEqual([
      "archived",
    ])
  })
  test("combines project and status filters", () => {
    const tasks = [task("a"), task("b", { projectID: "b", status: "in_progress" }), task("c", { projectID: "b" })]
    expect(
      filterManagedProjectTasks(tasks, { ...defaults, projectID: "b", status: "in_progress" }).map((task) => task.id),
    ).toEqual(["b"])
  })
  test("searches title, project, path and ID without mutating input", () => {
    const tasks = [
      task("ptask_unique", { title: "Release", projectName: "Physics", directory: "/tmp/custom-path" }),
      task("other"),
    ]
    for (const query of ["Release", "Physics", "custom-path", "ptask_unique"]) {
      expect(filterManagedProjectTasks(tasks, { ...defaults, query }).map((task) => task.id)).toEqual(["ptask_unique"])
    }
    expect(tasks.map((task) => task.id)).toEqual(["ptask_unique", "other"])
  })
  test("mixes creation and linked activity by recentAt, with deterministic creation ordering", () => {
    const tasks = [task("old", { recentAt: 100 }), task("new", { recentAt: 50, time: { created: 50, updated: 500 } })]
    expect(filterManagedProjectTasks(tasks, defaults).map((task) => task.id)).toEqual(["old", "new"])
    expect(filterManagedProjectTasks(tasks, { ...defaults, sort: "created" }).map((task) => task.id)).toEqual([
      "new",
      "old",
    ])
  })
})
