import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { buildTaskSessionLookup, taskChildSessions, taskSessionIndex } from "./message-task-session"

const session = (input: { id: string; parentID?: string; created?: number; archived?: boolean }): Session =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: { created: input.created ?? 0, updated: input.created ?? 0, archived: input.archived ? 1 : undefined },
  }) as unknown as Session

describe("buildTaskSessionLookup", () => {
  test("indexes every session by id", () => {
    const a = session({ id: "ses_a" })
    const b = session({ id: "ses_b" })
    const lookup = buildTaskSessionLookup([a, b])
    expect(lookup.byID.get("ses_a")).toBe(a)
    expect(lookup.byID.get("ses_b")).toBe(b)
  })

  test("groups non-archived children by parent, sorted by created then id", () => {
    const lookup = buildTaskSessionLookup([
      session({ id: "child-b", parentID: "parent", created: 200 }),
      session({ id: "child-a", parentID: "parent", created: 100 }),
      session({ id: "child-c", parentID: "parent", created: 100 }),
      session({ id: "archived", parentID: "parent", created: 300, archived: true }),
      session({ id: "root", created: 50 }),
    ])
    expect(lookup.childrenByParentID.get("parent")?.map((s) => s.id)).toEqual(["child-a", "child-c", "child-b"])
    expect(lookup.childrenByParentID.has("root")).toBe(false)
  })

  test("taskChildSessions returns the same ordering as taskSessionSiblings", () => {
    const children = [
      session({ id: "c2", parentID: "p", created: 2 }),
      session({ id: "c1", parentID: "p", created: 1 }),
    ]
    const others = [session({ id: "x", parentID: "q", created: 0 }), session({ id: "y" })]
    const lookup = buildTaskSessionLookup([...children, ...others])

    const indexed = taskChildSessions(lookup, "p")
    const scanned = taskSessionIndex({ childSessionId: "c1", parentSessionId: "p", sessions: [...children, ...others] })
    expect(scanned).toBe(1)
    expect(indexed.findIndex((s) => s.id === "c1") + 1).toBe(1)
    expect(indexed.map((s) => s.id)).toEqual(["c1", "c2"])
  })

  test("taskChildSessions handles missing lookups and blank ids", () => {
    expect(taskChildSessions(undefined, "p")).toEqual([])
    expect(taskChildSessions(buildTaskSessionLookup([]), "")).toEqual([])
    expect(taskChildSessions(buildTaskSessionLookup([]), "p")).toEqual([])
  })
})
