import { expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { createSessionMessagesService } from "../src/context/global-sync/session-messages-service"
import { createSessionControllerHarness } from "../src/context/global-sync/session-service-test-utils"

test("optimistic membership reacts to completion and cache invalidation", () => {
  createRoot((dispose) => {
    const harness = createSessionControllerHarness()
    const service = createSessionMessagesService(harness.deps)
    const input = {
      sessionID: "session",
      message: { id: "pending", sessionID: "session", role: "user", time: { created: 1 } } as Message,
      parts: [],
    }
    const pending = createMemo(() => service.optimistic.has("/project", "session", "pending"))
    expect(pending()).toBe(false)
    service.optimistic.add("/project", input)
    expect(pending()).toBe(true)
    service.optimistic.complete("/project", { sessionID: "session", messageID: "pending" })
    expect(pending()).toBe(false)
    service.optimistic.add("/project", input)
    expect(pending()).toBe(true)
    service.clearDirectory("/project")
    expect(pending()).toBe(false)
    dispose()
  })
})
