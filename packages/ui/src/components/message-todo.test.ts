import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2"
import { todoSnapshot } from "./message-todo"

const todo = (content: string, status = "pending"): Todo => ({ content, status, priority: "medium" })

describe("todoSnapshot", () => {
  test("shows the complete list when todos are first created", () => {
    expect(todoSnapshot(undefined, [todo("one"), todo("two"), todo("three")])).toEqual([
      { todo: todo("one") },
      { todo: todo("two") },
      { todo: todo("three") },
    ])
  })

  test("shows a modified line with one line of context on each side", () => {
    const previous = [todo("zero"), todo("one"), todo("two"), todo("three"), todo("four")]
    const current = [todo("zero"), todo("one"), todo("two", "completed"), todo("three"), todo("four")]

    expect(todoSnapshot(previous, current)).toEqual([
      { todo: todo("one"), change: undefined, gapBefore: false },
      { todo: todo("two", "completed"), change: "modified", gapBefore: false },
      { todo: todo("three"), change: undefined, gapBefore: false },
    ])
  })

  test("merges nearby windows and marks a gap between distant changes", () => {
    const previous = ["a", "b", "c", "d", "e", "f", "g"].map((value) => todo(value))
    const current = previous.map((value, index) =>
      index === 1 || index === 6 ? { ...value, status: "completed" } : value,
    )
    const result = todoSnapshot(previous, current)

    expect(result.map((row) => row.todo.content)).toEqual(["a", "b", "c", "f", "g"])
    expect(result.map((row) => row.gapBefore)).toEqual([false, false, false, true, false])
  })

  test("keeps a replaced task visible as one modified line", () => {
    expect(todoSnapshot([todo("one"), todo("two"), todo("three")], [todo("one"), todo("new"), todo("three")])).toEqual([
      { todo: todo("one"), change: undefined, gapBefore: false },
      { todo: todo("new"), change: "modified", gapBefore: false },
      { todo: todo("three"), change: undefined, gapBefore: false },
    ])
  })

  test("keeps inserted and removed tasks visible", () => {
    expect(todoSnapshot([todo("one"), todo("three")], [todo("one"), todo("two"), todo("three")])).toEqual([
      { todo: todo("one"), change: undefined, gapBefore: false },
      { todo: todo("two"), change: "added", gapBefore: false },
      { todo: todo("three"), change: undefined, gapBefore: false },
    ])
    expect(todoSnapshot([todo("one"), todo("two"), todo("three")], [todo("one"), todo("three")])).toEqual([
      { todo: todo("one"), change: undefined, gapBefore: false },
      { todo: todo("two"), change: "removed", gapBefore: false },
      { todo: todo("three"), change: undefined, gapBefore: false },
    ])
  })
})
