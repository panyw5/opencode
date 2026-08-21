import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createSessionStatusService } from "./session-status-service"
import { createSessionControllerHarness, deferred } from "./session-service-test-utils"

describe("session status controller", () => {
  test("dedupes concurrent refresh calls", async () => {
    const request = deferred<{ data?: Record<string, SessionStatus> }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      status: async () => {
        calls += 1
        return request.promise
      },
    })
    const service = createSessionStatusService(harness.deps)
    const first = service.refresh("/project")
    const second = service.refresh("/project")
    expect(calls).toBe(1)
    request.resolve({ data: { session: { type: "busy" } } })
    await Promise.all([first, second])
    expect(service.get("/project", "session")).toEqual({ type: "busy" })
    expect(service.inspect()).toEqual({ inflight: 0 })
  })

  test("reset lets a new refresh start and stale finally keeps it registered", async () => {
    const first = deferred<{ data?: Record<string, SessionStatus> }>()
    const second = deferred<{ data?: Record<string, SessionStatus> }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      status: async () => (++calls === 1 ? first.promise : second.promise),
    })
    const service = createSessionStatusService(harness.deps)
    const stale = service.refresh("/project")
    harness.reset()
    service.clearDirectory("/project")
    const fresh = service.refresh("/project")
    expect(calls).toBe(2)
    first.resolve({ data: { session: { type: "busy" } } })
    await stale
    const joined = service.refresh("/project")
    expect(calls).toBe(2)
    second.resolve({ data: { session: { type: "retry", attempt: 1, message: "wait", next: 2 } } })
    await Promise.all([fresh, joined])
    expect(service.get("/project", "session")?.type).toBe("retry")
    expect(service.inspect()).toEqual({ inflight: 0 })
  })
})
