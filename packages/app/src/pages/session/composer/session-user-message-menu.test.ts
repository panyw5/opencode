import { describe, expect, test } from "bun:test"
import { canShowUserMessageMenuItems } from "./session-user-message-menu"

describe("canShowUserMessageMenuItems", () => {
  test("hides items until history is fully loaded", () => {
    expect(canShowUserMessageMenuItems({ loading: false, complete: false })).toBe(false)
    expect(canShowUserMessageMenuItems({ loading: true, complete: false })).toBe(false)
    expect(canShowUserMessageMenuItems({ loading: true, complete: true })).toBe(false)
  })

  test("shows items only after a completed load", () => {
    expect(canShowUserMessageMenuItems({ loading: false, complete: true })).toBe(true)
  })
})
