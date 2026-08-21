import { describe, expect, test } from "bun:test"
import { createSessionInfoService } from "./session-info-service"
import { createSessionControllerHarness, deferred, sessionInfo } from "./session-service-test-utils"

describe("session info controller", () => {
  test("dedupes concurrent ensure calls and commits once", async () => {
    const request = deferred<{ data?: ReturnType<typeof sessionInfo> }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      get: async () => {
        calls += 1
        return request.promise
      },
    })
    const service = createSessionInfoService(harness.deps)
    const first = service.ensure("/project", "session")
    const second = service.ensure("/project", "session")
    expect(calls).toBe(1)
    request.resolve({ data: sessionInfo() })
    expect(await first).toMatchObject({ id: "session" })
    expect(await second).toMatchObject({ id: "session" })
    expect(service.get("/project", "session")).toMatchObject({ id: "session" })
    expect(harness.pins).toBe(0)
  })

  test("does not commit after directory reset", async () => {
    const request = deferred<{ data?: ReturnType<typeof sessionInfo> }>()
    const harness = createSessionControllerHarness({ get: async () => request.promise })
    const service = createSessionInfoService(harness.deps)
    const loading = service.ensure("/project", "session")
    harness.reset()
    request.resolve({ data: sessionInfo() })
    expect(await loading).toBeUndefined()
    expect(service.get("/project", "session")).toBeUndefined()
  })

  test("directory reopen starts a new request instead of joining stale info", async () => {
    const first = deferred<{ data?: ReturnType<typeof sessionInfo> }>()
    const second = deferred<{ data?: ReturnType<typeof sessionInfo> }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      get: async () => (++calls === 1 ? first.promise : second.promise),
    })
    const service = createSessionInfoService(harness.deps)
    const stale = service.ensure("/project", "session")
    harness.reset()
    service.clearDirectory("/project")
    const fresh = service.ensure("/project", "session")
    expect(calls).toBe(2)
    first.resolve({ data: sessionInfo("session", 1) })
    expect(await stale).toBeUndefined()
    second.resolve({ data: sessionInfo("session", 2) })
    expect(await fresh).toMatchObject({ time: { updated: 2 } })
  })

  test("session clear prevents an inflight info response from reviving it", async () => {
    const request = deferred<{ data?: ReturnType<typeof sessionInfo> }>()
    const harness = createSessionControllerHarness({ get: async () => request.promise })
    const service = createSessionInfoService(harness.deps)
    const loading = service.ensure("/project", "session")
    service.clear("/project", ["session"])
    request.resolve({ data: sessionInfo() })
    expect(await loading).toBeUndefined()
    expect(service.get("/project", "session")).toBeUndefined()
  })
})
