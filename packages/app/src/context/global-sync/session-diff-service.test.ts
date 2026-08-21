import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { createSessionDiffService } from "./session-diff-service"
import { createSessionControllerHarness, deferred } from "./session-service-test-utils"

const diff = (file: string) => ({ file, before: "", after: file, additions: 1, deletions: 0 }) as SnapshotFileDiff

describe("session diff controller", () => {
  test("dedupes requests and drops a response older than session.diff", async () => {
    const request = deferred<{ data?: SnapshotFileDiff[] }>()
    let calls = 0
    const harness = createSessionControllerHarness({
      diff: async () => {
        calls += 1
        return request.promise
      },
    })
    const service = createSessionDiffService(harness.deps)
    const first = service.refresh("/project", "session")
    const second = service.refresh("/project", "session")
    expect(calls).toBe(1)
    harness.child[1]("session_diff", "session", [diff("event")])
    service.event("/project", "session")
    request.resolve({ data: [diff("stale-http")] })
    await Promise.all([first, second])
    expect(service.get("/project", "session")).toEqual([diff("event")])
    expect(service.inspect()).toEqual({ inflight: 0, revision: 0 })
  })

  test("does not write after directory reset", async () => {
    const request = deferred<{ data?: SnapshotFileDiff[] }>()
    const harness = createSessionControllerHarness({ diff: async () => request.promise })
    const service = createSessionDiffService(harness.deps)
    const loading = service.refresh("/project", "session")
    harness.reset()
    service.clearDirectory("/project")
    request.resolve({ data: [diff("stale")] })
    await loading
    expect(service.get("/project", "session")).toBeUndefined()
    expect(service.inspect()).toEqual({ inflight: 0, revision: 0 })
  })
})
