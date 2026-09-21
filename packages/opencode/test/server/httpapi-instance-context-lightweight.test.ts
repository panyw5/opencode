import { describe, expect, test } from "bun:test"
import {
  canUseLightweightInstanceContext,
  internalProjectRegistration,
} from "../../src/server/routes/instance/httpapi/middleware/instance-context"

describe("HttpApi lightweight instance context routes", () => {
  test("preserves internal project registration for background HTTP requests", () => {
    expect(internalProjectRegistration({ visibility: "internal", kind: "math" })).toEqual({
      visibility: "internal",
      kind: "math",
    })
    expect(internalProjectRegistration({ visibility: "user", kind: "math" })).toBeUndefined()
    expect(internalProjectRegistration(undefined)).toBeUndefined()
  })

  test("keeps session list reads on the lightweight path", () => {
    expect(canUseLightweightInstanceContext({ group: "session", endpoint: "list" })).toBe(true)
    expect(canUseLightweightInstanceContext({ group: "v2.session", endpoint: "sessions" })).toBe(true)
  })

  test("keeps write and execution session routes on the full instance path", () => {
    expect(canUseLightweightInstanceContext({ group: "session", endpoint: "create" })).toBe(false)
    expect(canUseLightweightInstanceContext({ group: "session", endpoint: "prompt" })).toBe(false)
    expect(canUseLightweightInstanceContext({ group: "session", endpoint: "shell" })).toBe(false)
    expect(canUseLightweightInstanceContext({ group: "v2.session", endpoint: "prompt" })).toBe(false)
  })
})
