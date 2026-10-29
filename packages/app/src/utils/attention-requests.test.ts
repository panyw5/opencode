import { describe, expect, test } from "bun:test"
import { createAttentionRequestTracker } from "./attention-requests"

describe("attention request notifications", () => {
  test("deduplicates replayed requests", () => {
    const accept = createAttentionRequestTracker()
    expect(accept("/repo", "permission.asked", "per_1")).toBe(true)
    expect(accept("/repo", "permission.asked", "per_1")).toBe(false)
  })

  test("does not suppress distinct requests arriving together in one session", () => {
    const accept = createAttentionRequestTracker()
    expect(accept("/repo", "permission.asked", "per_1")).toBe(true)
    expect(accept("/repo", "question.asked", "que_1")).toBe(true)
    expect(accept("/repo", "question.asked", "que_2")).toBe(true)
  })

  test("scopes duplicates to directory and event type", () => {
    const accept = createAttentionRequestTracker()
    expect(accept("/repo", "permission.asked", "1")).toBe(true)
    expect(accept("C:\\repo", "permission.asked", "1")).toBe(true)
    expect(accept("/repo", "question.asked", "1")).toBe(true)
  })

  test("bounds replay history", () => {
    const accept = createAttentionRequestTracker(2)
    accept("/repo", "question.asked", "1")
    accept("/repo", "question.asked", "2")
    accept("/repo", "question.asked", "3")
    expect(accept("/repo", "question.asked", "2")).toBe(false)
    expect(accept("/repo", "question.asked", "1")).toBe(true)
  })
})
