import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSessionListRequests, mergeSessionListSnapshot } from "./session-list-snapshot"
import { sessionInfo } from "./session-service-test-utils"

const event = (type: string, info: Session) => ({ type, properties: { info } })

describe("session list snapshots", () => {
  test("a stale snapshot cannot restore a deleted root or remove a newly created root", () => {
    const requests = createSessionListRequests()
    const request = requests.begin("/project")
    const deleted = sessionInfo("deleted")
    const kept = sessionInfo("kept")
    const created = sessionInfo("new")
    requests.record("/project", event("session.deleted", deleted))
    requests.record("/project", event("session.created", created))
    expect(mergeSessionListSnapshot([deleted, kept], [kept, created], request.changes)).toEqual([kept, created])
    requests.finish("/project", request)
    expect(requests.inspect()).toBe(0)
  })

  test("keeps realtime metadata and archive changes over old snapshots", () => {
    const requests = createSessionListRequests()
    const request = requests.begin("/project")
    const old = sessionInfo("root", 1)
    const updated = { ...sessionInfo("root", 2), title: "new title", revert: { messageID: "boundary" } }
    requests.record("/project", event("session.updated", updated))
    expect(mergeSessionListSnapshot([old], [updated], request.changes)).toEqual([updated])
    requests.record("/project", event("session.updated", { ...updated, time: { ...updated.time, archived: 3 } }))
    expect(mergeSessionListSnapshot([old], [], request.changes)).toEqual([])
  })

  test("a later explicit restore wins over an earlier deletion or archive", () => {
    const requests = createSessionListRequests()
    const request = requests.begin("/project")
    const restored = sessionInfo("root", 3)
    requests.record("/project", event("session.deleted", sessionInfo("root")))
    requests.record("/project", event("session.updated", restored))
    expect(mergeSessionListSnapshot([], [restored], request.changes)).toEqual([restored])
  })

  test("preserves child sessions without duplicating a root moved under a parent", () => {
    const requests = createSessionListRequests()
    const request = requests.begin("/project")
    const child = { ...sessionInfo("child"), parentID: "root" }
    const root = sessionInfo("root")
    const moved = { ...sessionInfo("moved", 2), parentID: root.id }
    requests.record("/project", event("session.updated", moved))
    expect(mergeSessionListSnapshot([root, sessionInfo("moved")], [child, root, moved], request.changes)).toEqual([
      child,
      moved,
      root,
    ])
  })

  test("keeps newer existing metadata and drops roots absent from an authoritative snapshot", () => {
    const old = sessionInfo("root", 1)
    const current = sessionInfo("root", 2)
    expect(mergeSessionListSnapshot([old], [current, sessionInfo("gone")], new Map())).toEqual([current])
  })

  test("a newer cached archive cannot be restored by an older active snapshot", () => {
    const archived = { ...sessionInfo("root", 2), time: { created: 1, updated: 2, archived: 2 } }
    expect(mergeSessionListSnapshot([sessionInfo("root", 1)], [archived], new Map())).toEqual([])
  })

  test("retains the previous list's tolerance for gateway rows without timestamps", () => {
    const legacy = { id: "legacy" } as Session
    expect(mergeSessionListSnapshot([legacy], [], new Map())).toEqual([legacy])
  })

  test("request reset and stale cleanup cannot invalidate or alter a newer request", () => {
    const requests = createSessionListRequests()
    const old = requests.begin("/project")
    requests.clear("/project", "backend-reset")
    requests.clear("/project", "repeat-reset")
    const fresh = requests.begin("/project")
    requests.record("/project", event("session.deleted", sessionInfo("deleted")))
    requests.finish("/project", old)
    expect(requests.current("/project", old)).toBe(false)
    expect(requests.current("/project", fresh)).toBe(true)
    expect(old.changes.size).toBe(0)
    expect(fresh.changes.has("deleted")).toBe(true)
    requests.finish("/project", fresh)
    expect(requests.inspect()).toBe(0)
  })

  test("changes are scoped to active requests and their directory", () => {
    const requests = createSessionListRequests()
    const request = requests.begin("/project")
    requests.record("/other", event("session.deleted", sessionInfo("deleted")))
    expect(request.changes.size).toBe(0)
    requests.finish("/project", request)
    requests.record("/project", event("session.deleted", sessionInfo("deleted")))
    expect(request.changes.size).toBe(0)
    expect(requests.inspect()).toBe(0)
  })
})
