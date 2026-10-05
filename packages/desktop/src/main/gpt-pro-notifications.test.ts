import { describe, expect, test } from "bun:test"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { collectGptProNotification } from "./gpt-pro-notifications"

const job = (): GptProJob => ({
  id: "gpt_test",
  owner: "/repo\nses_parent",
  requestID: "request",
  phase: "generating",
  prompt: "Question",
  url: "https://chatgpt.com/c/test",
  createdAt: 0,
  updatedAt: 0,
  submitted: true,
  revision: 1,
  background: true,
  text: "First",
})

describe("background Pro notification outbox", () => {
  test("foreground, unchanged and empty answers do not emit periodic inputs", () => {
    const j = job()
    j.background = false
    expect(collectGptProNotification(j, 60_000, 60_000)).toBeUndefined()
    j.background = true
    j.text = ""
    expect(collectGptProNotification(j, 60_000, 60_000)).toBeUndefined()
    j.text = "First"
    expect(collectGptProNotification(j, 60_000, 60_000)?.text).toBe("First")
    expect(collectGptProNotification(j, 120_000, 60_000)).toBeUndefined()
  })
  test("progress is throttled, appends are incremental and rewrites replace snapshots", () => {
    const j = job()
    expect(collectGptProNotification(j, 59_999, 60_000)).toBeUndefined()
    expect(collectGptProNotification(j, 60_000, 60_000)?.format).toBe("snapshot")
    j.text = "First second"
    j.revision++
    expect(collectGptProNotification(j, 65_000, 60_000)).toBeUndefined()
    expect(collectGptProNotification(j, 120_000, 60_000)).toMatchObject({ format: "append", text: " second" })
    j.text = "Corrected answer"
    j.revision++
    expect(collectGptProNotification(j, 180_000, 60_000)).toMatchObject({
      format: "snapshot",
      text: "Corrected answer",
    })
    expect(j.notifications?.map((n) => n.id)).toEqual([
      "gpt_test:notification:1",
      "gpt_test:notification:2",
      "gpt_test:notification:3",
    ])
  })
  test("completion is immediate, includes the final snapshot and is emitted once", () => {
    const j = job()
    collectGptProNotification(j, 60_000, 60_000)
    j.phase = "completed"
    expect(collectGptProNotification(j, 60_001, 60_000)).toMatchObject({
      kind: "completed",
      text: "First",
      format: "snapshot",
    })
    expect(collectGptProNotification(j, 120_000, 60_000)).toBeUndefined()
    const restored = structuredClone(j)
    expect(collectGptProNotification(restored, 180_000, 60_000)).toBeUndefined()
    expect(restored.notifications).toHaveLength(2)
  })
  test("pause alerts once, resume does not resend and another pause is observable", () => {
    const j = job()
    j.phase = "paused"
    expect(collectGptProNotification(j, 1, 60_000)?.kind).toBe("state")
    expect(collectGptProNotification(j, 60_000, 60_000)).toBeUndefined()
    j.phase = "generating"
    collectGptProNotification(j, 60_001, 60_000)
    j.phase = "paused"
    expect(collectGptProNotification(j, 60_002, 60_000)?.kind).toBe("state")
  })
  test("large snapshots are explicitly marked as truncated", () => {
    const j = job()
    j.text = "x".repeat(20_001)
    const event = collectGptProNotification(j, 60_000, 60_000)!
    expect(event.truncated).toBe(true)
    expect(event.text).toHaveLength(20_000)
  })
})
