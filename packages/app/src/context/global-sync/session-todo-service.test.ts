import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { createSessionTodoService } from "./session-todo-service"
import { createSessionControllerHarness, deferred } from "./session-service-test-utils"

const todo = (content: string): Todo => ({ content, status: "pending", priority: "high" })

describe("session todo controller", () => {
  test("dedupes requests and drops a response older than todo.updated", async () => {
    const request = deferred<{ data?: Todo[] }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      todo: async () => {
        calls += 1
        return request.promise
      },
    })
    const service = createSessionTodoService(harness.deps)
    const first = service.refresh("/project", "session")
    const second = service.refresh("/project", "session")
    expect(calls).toBe(1)
    service.set("/project", "session", [todo("event")])
    service.event("/project", "session")
    request.resolve({ data: [todo("stale-http")] })
    await Promise.all([first, second])
    expect(service.get("/project", "session")).toEqual([todo("event")])
    expect(service.inspect()).toEqual({ inflight: 0, revision: 0 })
  })

  test("does not write after directory reset", async () => {
    const request = deferred<{ data?: Todo[] }>()
    const harness = createSessionControllerHarness({ todo: async () => request.promise })
    const service = createSessionTodoService(harness.deps)
    const loading = service.refresh("/project", "session")
    harness.reset()
    service.clearDirectory("/project")
    request.resolve({ data: [todo("stale")] })
    await loading
    expect(service.get("/project", "session")).toBeUndefined()
    expect(service.inspect()).toEqual({ inflight: 0, revision: 0 })
  })

})
