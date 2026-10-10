import { describe, expect, test } from "bun:test"
import { createFreshRequestQueue } from "./fresh-request-queue"
import { deferred } from "@/context/global-sync/session-service-test-utils"

describe("fresh request queue", () => {
  test("coalesces refreshes and runs the latest task after an old error", async () => {
    const pending = deferred<void>()
    const queue = createFreshRequestQueue<string>()
    const first = queue.enqueue(
      "key",
      pending.promise,
      async () => "old-task",
      () => "canceled",
    )
    expect(
      queue.enqueue(
        "key",
        pending.promise,
        async () => "latest-task",
        () => "canceled",
      ),
    ).toBe(first)
    pending.reject(new Error("old request failed"))
    expect(await first).toBe("latest-task")
    expect(queue.size).toBe(0)
  })

  test("clear and stale cleanup never start or erase a new request", async () => {
    const old = deferred<void>()
    const fresh = deferred<void>()
    const queue = createFreshRequestQueue<string>()
    const canceled = queue.enqueue(
      "key",
      old.promise,
      async () => "bad",
      () => "canceled",
    )
    queue.clear("key")
    const current = queue.enqueue(
      "key",
      fresh.promise,
      async () => "fresh",
      () => "canceled",
    )
    old.resolve()
    expect(await canceled).toBe("canceled")
    expect(queue.size).toBe(1)
    fresh.resolve()
    expect(await current).toBe("fresh")
    expect(queue.size).toBe(0)
  })
})
