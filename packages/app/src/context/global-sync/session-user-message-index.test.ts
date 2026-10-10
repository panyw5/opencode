import { describe, expect, test } from "bun:test"
import type { UserMessageIndexItem } from "@opencode-ai/sdk/v2/client"
import { createSessionUserMessageIndex } from "./session-user-message-index"
import { deferred } from "./session-service-test-utils"

const item = (id: string) => ({ id, time: { created: 1 }, preview: id }) as UserMessageIndexItem

function harness(load: () => Promise<{ data: UserMessageIndexItem[] }>) {
  let version = 0
  const service = createSessionUserMessageIndex({
    key: (directory, sessionID) => `${directory}\n${sessionID}`,
    version: () => version,
    current: () => true,
    load,
  })
  return { service, reset: () => version++ }
}

describe("user message index", () => {
  test("filters deletion events that arrive before the first snapshot", async () => {
    const request = deferred<{ data: UserMessageIndexItem[] }>()
    const { service } = harness(() => request.promise)
    const loading = service.ensure("/project", "session")
    service.remove("/project", "session", "deleted")
    request.resolve({ data: [item("deleted"), item("kept")] })
    await loading
    expect(service.get("/project", "session")).toEqual([item("kept")])
    expect(service.inspect()).toEqual({ requests: 0, cached: 1 })
  })

  test("cannot restore a cached deleted item from an older forced snapshot", async () => {
    const request = deferred<{ data: UserMessageIndexItem[] }>()
    let calls = 0
    const { service } = harness(() => (++calls === 1 ? Promise.resolve({ data: [item("deleted")] }) : request.promise))
    await service.ensure("/project", "session")
    const loading = service.ensure("/project", "session", { force: true })
    service.remove("/project", "session", "deleted")
    request.resolve({ data: [item("deleted")] })
    await loading
    expect(service.get("/project", "session")).toEqual([])
  })

  test("discards a response after changing the backend at the same directory", async () => {
    const request = deferred<{ data: UserMessageIndexItem[] }>()
    const { service, reset } = harness(() => request.promise)
    const loading = service.ensure("/project", "session")
    reset()
    request.resolve({ data: [item("old-backend")] })
    await loading
    expect(service.get("/project", "session")).toBeUndefined()
  })

  test("repeated clears and stale failures cannot modify the replacement request", async () => {
    const first = deferred<{ data: UserMessageIndexItem[] }>()
    const second = deferred<{ data: UserMessageIndexItem[] }>()
    let calls = 0
    const { service } = harness(() => (++calls === 1 ? first.promise : second.promise))
    const old = service.ensure("/project", "session")
    await Promise.resolve()
    service.clear("/project", ["session"])
    service.clear("/project", ["session"])
    const fresh = service.ensure("/project", "session")
    first.reject(new Error("canceled request"))
    await old
    expect(service.loading("/project", "session")).toBe(true)
    expect(service.failed("/project", "session")).toBe(false)
    expect(service.ensure("/project", "session")).toBe(fresh)
    second.resolve({ data: [item("fresh")] })
    await fresh
    expect(service.get("/project", "session")).toEqual([item("fresh")])
  })

  test("deletions do not leak into another session or a new request generation", async () => {
    const { service } = harness(async () => ({ data: [item("same-id")] }))
    service.remove("/project", "session", "same-id")
    await service.ensure("/project", "other")
    expect(service.get("/project", "other")).toEqual([item("same-id")])
    service.clearAll("test")
    await service.ensure("/project", "session")
    expect(service.get("/project", "session")).toEqual([item("same-id")])
    service.clearAll("test-complete")
    expect(service.inspect()).toEqual({ requests: 0, cached: 0 })
  })
})
