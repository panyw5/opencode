import { describe, expect, test } from "bun:test"
import { filterTasks } from "./task-search"

describe("task search", () => {
  const tasks = [
    { title: "Release desktop", description: "构建桌面应用" },
    { title: "Review", description: "Check scheduled backups" },
    { title: "Archive", description: "" },
  ]

  test("empty and whitespace queries preserve all tasks", () => {
    expect(filterTasks(tasks, "", ["title", "description"])).toBe(tasks)
    expect(filterTasks(tasks, "   ", ["title", "description"])).toBe(tasks)
  })

  test("matches titles case-insensitively with non-contiguous characters", () => {
    expect(filterTasks(tasks, " RDT ", ["title", "description"])).toEqual([tasks[0]])
  })

  test("matches descriptions including Chinese text", () => {
    expect(filterTasks(tasks, "backup", ["title", "description"])).toEqual([tasks[1]])
    expect(filterTasks(tasks, "桌面", ["title", "description"])).toEqual([tasks[0]])
  })

  test("preserves existing order and returns no matches", () => {
    expect(filterTasks(tasks, "re", ["title", "description"])).toEqual(tasks)
    expect(filterTasks(tasks, "zzzzzz", ["title", "description"])).toEqual([])
  })

  test("searches scheduled task names and prompts", () => {
    const scheduled = [{ name: "Daily job", prompt: "Verify release artifacts" }]
    expect(filterTasks(scheduled, "djb", ["name", "prompt"])).toEqual(scheduled)
    expect(filterTasks(scheduled, "artifacts", ["name", "prompt"])).toEqual(scheduled)
  })

  test("rejects weak matches scattered across long descriptions", () => {
    const tasks = [{ name: "Maintenance", prompt: `daily ${"x".repeat(500)} refresh ${"x".repeat(500)} artifacts` }]
    expect(filterTasks(tasks, "dfa", ["name", "prompt"])).toEqual([])
    expect(filterTasks(tasks, "artifacts", ["name", "prompt"])).toEqual(tasks)
  })
})
