import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { optionalOmitUndefined } from "../src/schema"

describe("optionalOmitUndefined", () => {
  const Value = Schema.Struct({
    value: optionalOmitUndefined(Schema.Literal("present")),
  })

  test("decodes an omitted wire field", () => {
    expect(Schema.decodeUnknownSync(Value)({})).toEqual({})
  })

  test("omits an explicit undefined type value while encoding", () => {
    const encoded = Schema.encodeUnknownSync(Value)({ value: undefined })

    expect(encoded).toEqual({})
    expect(Object.hasOwn(encoded, "value")).toBe(false)
  })

  test("keeps decode and encode validation directions distinct", () => {
    expect(() => Schema.decodeUnknownSync(Value)({ value: undefined })).toThrow('Expected "present", got undefined')
    expect(() => Schema.encodeUnknownSync(Value)({ value: "invalid" })).toThrow()
  })
})
