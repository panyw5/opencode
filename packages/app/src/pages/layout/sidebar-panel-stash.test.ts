import { describe, expect, test } from "bun:test"
import {
  panelStashId,
  projectTaskEditorStashId,
  scheduledEditorStashId,
  stashRailEntry,
  unstashRailEntry,
  type StashedRailEntry,
} from "./sidebar-panel-stash"

const entry = (id: string, restore: () => void = () => {}): StashedRailEntry => ({
  id,
  label: id,
  icon: "clock",
  restore,
})

describe("sidebar rail stash", () => {
  test("newest stashed entry sits at the head of the stack", () => {
    const stack = stashRailEntry(stashRailEntry([], entry("a")), entry("b"))
    expect(stack.map((item) => item.id)).toEqual(["b", "a"])
  })

  test("re-stashing the same id moves it to the head without duplicating", () => {
    const stack = stashRailEntry(stashRailEntry([], entry("a")), entry("b"))
    const reStashed = stashRailEntry(stack, entry("a", () => {}))
    expect(reStashed).toHaveLength(2)
    expect(reStashed.map((item) => item.id)).toEqual(["a", "b"])
  })

  test("unstash removes only the matching id", () => {
    const stack = stashRailEntry(stashRailEntry([], entry("a")), entry("b"))
    expect(unstashRailEntry(stack, "a").map((item) => item.id)).toEqual(["b"])
    expect(unstashRailEntry(stack, "missing")).toHaveLength(2)
  })

  test("panel stash ids collapse trailing slashes on the same worktree", () => {
    expect(panelStashId("scheduled", "/Users/example/chat/")).toBe(panelStashId("scheduled", "/Users/example/chat"))
    expect(panelStashId("scheduled", "/Users/example/chat")).not.toBe(panelStashId("projectTasks", "/Users/example/chat"))
    expect(panelStashId("scheduled", "/Users/example/chat")).not.toBe(panelStashId("scheduled", "/Users/example/other"))
  })

  test("editor stash ids differ by task and worktree", () => {
    const dir = "/Users/example/chat"
    expect(scheduledEditorStashId("task_1", dir)).toBe(scheduledEditorStashId("task_1", `${dir}/`))
    expect(scheduledEditorStashId("task_1", dir)).not.toBe(scheduledEditorStashId("task_2", dir))
    expect(scheduledEditorStashId("task_1", dir)).not.toBe(scheduledEditorStashId(undefined, dir))
    expect(scheduledEditorStashId("task_1", dir)).not.toBe(projectTaskEditorStashId("task_1", dir))
  })
})
