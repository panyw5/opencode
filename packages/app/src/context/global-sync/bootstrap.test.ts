import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Project } from "@opencode-ai/sdk/v2/client"
import { mergePermissionRefresh, upsertProject } from "./bootstrap"

const permission = (id: string, sessionID = "session") =>
  ({ id, sessionID, permission: "bash", patterns: ["*"] }) as PermissionRequest

describe("upsertProject", () => {
  test("inserts missing projects in id order", () => {
    const projects = [{ id: "a" }, { id: "c" }] as Project[]
    const next = upsertProject(projects, { id: "b", worktree: "/repo", vcs: "git" } as Project)

    expect(next.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(next.find((item) => item.id === "b")?.vcs).toBe("git")
  })

  test("replaces existing projects with current discovery data", () => {
    const projects = [{ id: "repo", worktree: "/old" }] as Project[]
    const next = upsertProject(projects, { id: "repo", worktree: "/repo", vcs: "git" } as Project)

    expect(next).toHaveLength(1)
    expect(next[0]?.worktree).toBe("/repo")
    expect(next[0]?.vcs).toBe("git")
  })
})

describe("mergePermissionRefresh", () => {
  test("preserves a permission asked while the list request is in flight", () => {
    const asked = permission("new")
    const result = mergePermissionRefresh({}, { session: [asked] }, [])

    expect(result).toEqual({ session: [asked] })
  })

  test("does not resurrect a permission replied to while the list request is in flight", () => {
    const replied = permission("replied")
    const result = mergePermissionRefresh({ session: [replied] }, {}, [replied])

    expect(result).toEqual({})
  })

  test("keeps snapshot authority when no event changed local state", () => {
    const stale = permission("stale")
    const remote = permission("remote", "other")
    const result = mergePermissionRefresh({ session: [stale] }, { session: [stale] }, [remote])

    expect(result).toEqual({ other: [remote] })
  })

  test("merges remote state with concurrent additions and removals", () => {
    const removed = permission("a")
    const kept = permission("b")
    const added = permission("c")
    const remote = permission("d", "other")
    const result = mergePermissionRefresh(
      { session: [removed, kept] },
      { session: [kept, added] },
      [removed, kept, remote],
    )

    expect(result).toEqual({ session: [kept, added], other: [remote] })
  })
})
