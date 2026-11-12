import { describe, expect, test } from "bun:test"
import { SECRET_MASK } from "@/extensions/api"
import type { SettingDefinition } from "@/extensions/types"
import {
  buildSettingsPatch,
  enumDraftOptions,
  initialDraft,
  initialDraftValue,
  secretConfigured,
} from "./settings-extensions-utils"

const stringDef: SettingDefinition = { type: "string", title: "Endpoint" }
const numberDef: SettingDefinition = { type: "number", title: "Port" }
const booleanDef: SettingDefinition = { type: "boolean", title: "Enabled" }
const enumDef: SettingDefinition = { type: "string", title: "Mode", enum: ["fast", "slow"] }
const numericEnumDef: SettingDefinition = { type: "number", title: "Level", enum: [1, 2, 3] }
const secretDef: SettingDefinition = { type: "string", title: "Token", secret: true }

describe("initialDraftValue", () => {
  test("seeds from the stored snapshot before the manifest default", () => {
    expect(initialDraftValue(stringDef, "https://example.com")).toBe("https://example.com")
    expect(initialDraftValue({ ...stringDef, default: "fallback" }, undefined)).toBe("fallback")
    expect(initialDraftValue(stringDef, undefined)).toBe("")
    expect(initialDraftValue(numberDef, 8080)).toBe("8080")
    expect(initialDraftValue({ ...numberDef, default: 3000 }, undefined)).toBe("3000")
    expect(initialDraftValue(numberDef, undefined)).toBe("")
    expect(initialDraftValue(booleanDef, true)).toBe(true)
    expect(initialDraftValue({ ...booleanDef, default: true }, undefined)).toBe(true)
    expect(initialDraftValue(booleanDef, undefined)).toBe(false)
    expect(initialDraftValue(numericEnumDef, 2)).toBe("2")
    expect(initialDraftValue(enumDef, undefined)).toBe("")
  })

  test("never seeds a secret from the stored (masked) value", () => {
    expect(initialDraftValue(secretDef, SECRET_MASK)).toBe("")
    expect(initialDraftValue(secretDef, "plaintext")).toBe("")
    expect(initialDraftValue(secretDef, undefined)).toBe("")
  })
})

describe("buildSettingsPatch", () => {
  const draft = (values: Record<string, string | boolean>) => values
  const untouched = new Set<string>()

  test("returns undefined when nothing changed", () => {
    const definitions = { host: stringDef, port: numberDef, on: booleanDef }
    const stored = { host: "http://localhost", port: 8080, on: true }
    expect(
      buildSettingsPatch(definitions, stored, draft({ host: "http://localhost", port: "8080", on: true }), untouched),
    ).toBeUndefined()
    expect(buildSettingsPatch(definitions, stored, draft({}), untouched)).toBeUndefined()
  })

  test("sends typed values and normalizes numbers", () => {
    const definitions = { host: stringDef, port: numberDef }
    const patch = buildSettingsPatch(definitions, { host: "a", port: 1 }, draft({ host: "b", port: "2" }), untouched)
    expect(patch).toEqual({ host: "b", port: 2 })
  })

  test("treats an empty string or number as null when a value existed", () => {
    const definitions = { host: stringDef, port: numberDef }
    const patch = buildSettingsPatch(definitions, { host: "a", port: 8080 }, draft({ host: "", port: "" }), untouched)
    expect(patch).toEqual({ host: null, port: null })
  })

  test("omits empty values that were already unset and invalid numbers", () => {
    const definitions = { host: stringDef, port: numberDef }
    expect(buildSettingsPatch(definitions, {}, draft({ host: "", port: "" }), untouched)).toBeUndefined()
    expect(buildSettingsPatch(definitions, { port: 1 }, draft({ port: "abc" }), untouched)).toBeUndefined()
    // 1e3 and 1000 are the same number: no spurious patch.
    expect(buildSettingsPatch(definitions, { port: 1000 }, draft({ port: "1e3" }), untouched)).toBeUndefined()
  })

  test("sends booleans only when the switch changed", () => {
    const definitions = { on: booleanDef }
    expect(buildSettingsPatch(definitions, { on: false }, draft({ on: true }), untouched)).toEqual({ on: true })
    expect(buildSettingsPatch(definitions, { on: false }, draft({ on: false }), untouched)).toBeUndefined()
  })

  test("sends the raw typed enum value and null for not-set", () => {
    const definitions = { mode: enumDef, level: numericEnumDef }
    const patch = buildSettingsPatch(
      definitions,
      { mode: "fast", level: 1 },
      draft({ mode: "slow", level: "2" }),
      untouched,
    )
    expect(patch).toEqual({ mode: "slow", level: 2 })
    const cleared = buildSettingsPatch(definitions, { mode: "fast" }, draft({ mode: "", level: "1" }), untouched)
    expect(cleared).toEqual({ mode: null, level: 1 })
    // Selecting "not set" when nothing was stored is a no-op.
    expect(buildSettingsPatch(definitions, {}, draft({ mode: "", level: "" }), untouched)).toBeUndefined()
  })

  test("never sends an untouched secret, even when the field is empty", () => {
    const definitions = { token: secretDef }
    expect(buildSettingsPatch(definitions, { token: SECRET_MASK }, draft({ token: "" }), untouched)).toBeUndefined()
    expect(buildSettingsPatch(definitions, {}, draft({ token: "" }), untouched)).toBeUndefined()
  })

  test("a touched secret sends its new value, or null when cleared", () => {
    const definitions = { token: secretDef }
    const touched = new Set(["token"])
    expect(buildSettingsPatch(definitions, { token: SECRET_MASK }, draft({ token: "new" }), touched)).toEqual({
      token: "new",
    })
    expect(buildSettingsPatch(definitions, { token: SECRET_MASK }, draft({ token: "" }), touched)).toEqual({
      token: null,
    })
    // The mask is never echoed back to the server.
    expect(
      buildSettingsPatch(definitions, { token: SECRET_MASK }, draft({ token: SECRET_MASK }), touched),
    ).toBeUndefined()
  })

  test("touching a field without changing the value stays out of the patch", () => {
    const definitions = { host: stringDef }
    const touched = new Set(["host"])
    expect(buildSettingsPatch(definitions, { host: "a" }, draft({ host: "a" }), touched)).toBeUndefined()
  })
})

describe("enumDraftOptions", () => {
  test("appends the translated not-set entry", () => {
    const options = enumDraftOptions(enumDef, "Not set")
    expect(options).toEqual([
      { value: "fast", label: "fast" },
      { value: "slow", label: "slow" },
      { value: "", label: "Not set" },
    ])
  })
})

describe("secretConfigured", () => {
  test("only the server mask counts as configured", () => {
    expect(secretConfigured(SECRET_MASK)).toBe(true)
    expect(secretConfigured(undefined)).toBe(false)
    expect(secretConfigured("plaintext")).toBe(false)
  })
})

describe("initialDraft", () => {
  test("seeds every declared key", () => {
    const draft = initialDraft({ a: stringDef, b: numberDef, c: secretDef }, { a: "x", b: 5, c: SECRET_MASK })
    expect(draft).toEqual({ a: "x", b: "5", c: "" })
  })
})
