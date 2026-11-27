import { describe, expect, test } from "bun:test"
import { isQueuedPrompt } from "../../src/session/queued-message"
import type { SessionStatus } from "../../src/session/status"
import type { MessageV2 } from "../../src/session/message-v2"

const busy = { type: "busy" } as SessionStatus.Info

const user = (time: MessageV2.User["time"]) => ({ role: "user", time }) as Pick<MessageV2.Info, "role" | "time">
const assistant = (time: MessageV2.Assistant["time"]) =>
  ({ role: "assistant", time }) as unknown as Pick<MessageV2.Info, "role" | "time">

describe("isQueuedPrompt", () => {
  test("treats an uncompleted user message while the session is busy as a queued prompt", () => {
    expect(isQueuedPrompt({ status: busy, message: user({ created: 1 }) })).toBe(true)
  })

  test("does not treat it as queued once the session is idle", () => {
    expect(isQueuedPrompt({ status: { type: "idle" } as SessionStatus.Info, message: user({ created: 1 }) })).toBe(
      false,
    )
  })

  test("rejects assistant messages", () => {
    expect(isQueuedPrompt({ status: busy, message: assistant({ created: 1 }) })).toBe(false)
  })

  test("rejects missing messages", () => {
    expect(isQueuedPrompt({ status: busy, message: undefined })).toBe(false)
  })

  test("rejects user messages that already completed", () => {
    expect(isQueuedPrompt({ status: busy, message: user({ created: 1, completed: 2 }) })).toBe(false)
  })
})
