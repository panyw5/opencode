import { describe, expect, test } from "bun:test"
import {
  advanceStickyActiveMessageID,
  displayStatusForThinking,
  latchThinkingPhase,
  THINKING_STATUS_STICKY_MS,
} from "./sticky-status"

describe("sticky active message id", () => {
  test("enters immediately when a turn becomes active", () => {
    expect(
      advanceStickyActiveMessageID({
        previous: undefined,
        next: "msg_user",
        now: 1_000,
        clearAt: undefined,
      }),
    ).toEqual({ id: "msg_user", clearAt: undefined })
  })

  test("schedules a delayed clear when the turn goes idle", () => {
    expect(
      advanceStickyActiveMessageID({
        previous: "msg_user",
        next: undefined,
        now: 1_000,
        clearAt: undefined,
        stickyMs: 200,
      }),
    ).toEqual({ id: "msg_user", clearAt: 1_200 })
  })

  test("keeps the previous id until the sticky window elapses", () => {
    expect(
      advanceStickyActiveMessageID({
        previous: "msg_user",
        next: undefined,
        now: 1_100,
        clearAt: 1_200,
        stickyMs: 200,
      }),
    ).toEqual({ id: "msg_user", clearAt: 1_200 })
  })

  test("clears after the sticky window", () => {
    expect(
      advanceStickyActiveMessageID({
        previous: "msg_user",
        next: undefined,
        now: 1_200,
        clearAt: 1_200,
        stickyMs: 200,
      }),
    ).toEqual({ id: undefined, clearAt: undefined })
  })

  test("cancels a pending clear when the turn becomes active again", () => {
    expect(
      advanceStickyActiveMessageID({
        previous: "msg_user",
        next: "msg_user",
        now: 1_100,
        clearAt: 1_200,
        stickyMs: 200,
      }),
    ).toEqual({ id: "msg_user", clearAt: undefined })
  })

  test("uses the shared sticky duration constant", () => {
    expect(THINKING_STATUS_STICKY_MS).toBe(200)
  })
})

describe("displayStatusForThinking", () => {
  test("passes through non-idle status", () => {
    expect(displayStatusForThinking({ status: "busy", stickyActive: false })).toBe("busy")
    expect(displayStatusForThinking({ status: "retry", stickyActive: true })).toBe("retry")
  })

  test("treats idle as busy while the turn is sticky-active", () => {
    expect(displayStatusForThinking({ status: "idle", stickyActive: true })).toBe("busy")
  })

  test("stays idle when nothing is sticky", () => {
    expect(displayStatusForThinking({ status: "idle", stickyActive: false })).toBe("idle")
  })
})

describe("latchThinkingPhase", () => {
  test("advances from sending to thinking", () => {
    expect(latchThinkingPhase("sending", "thinking")).toBe("thinking")
    expect(latchThinkingPhase(undefined, "sending")).toBe("sending")
  })

  test("never regresses from thinking to sending", () => {
    expect(latchThinkingPhase("thinking", "sending")).toBe("thinking")
    expect(latchThinkingPhase("thinking", "thinking")).toBe("thinking")
  })
})
