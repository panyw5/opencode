import { describe, expect, test } from "bun:test"
import { dshChoiceValues, dshDefaultsForm, dshDefaultsInput } from "./config-dsh-defaults"

describe("DSH default invocation form", () => {
  test("choice lists preserve custom profiles, timeouts and presets without duplicate defaults", () => {
    expect(dshChoiceValues(["", "headless", "review", "headless"], "review")).toEqual(["", "headless", "review"])
    expect(dshChoiceValues(["", "headless"], "custom-review")).toContain("custom-review")
    expect(dshChoiceValues(["", "60", "600"], "123.5")).toContain("123.5")
    expect(dshChoiceValues(["", "read-only", "workspace-write"], "custom-policy")).toContain("custom-policy")
    expect(dshChoiceValues(["", "headless"], "")).toEqual(["", "headless"])
  })
  test("empty fields inherit DSH behavior without pinning implicit defaults", () => {
    expect(dshDefaultsInput(dshDefaultsForm())).toEqual({})
  })

  test("round-trips ordered patches, policies, directory grants and timeout units", () => {
    const defaults = {
      profile: "review",
      working_directory: "/repo",
      timeout_ms: 120000,
      patch: ["- id: first\n  disabled: true\n", "[]"],
      permission_mode: "read-only",
      approval_policy: "never" as const,
      additional_writable_roots: ["/shared", "/other"],
    }
    const form = dshDefaultsForm(defaults)
    expect(form.timeoutSeconds).toBe("120")
    expect(dshDefaultsInput(form)).toEqual(defaults)
    expect(dshDefaultsInput(dshDefaultsForm({ patch: "[]" })).patch).toEqual(["[]"])
    form.patches.push("new")
    expect(defaults.patch).toHaveLength(2)
  })

  test("clears removed values and rejects invalid timeouts or policies", () => {
    const form = dshDefaultsForm({ profile: "review", timeout_ms: 60000, patch: ["[]"], approval_policy: "never" })
    expect(dshDefaultsInput({ ...form, profile: " ", timeoutSeconds: "", patches: [], approvalPolicy: "" })).toEqual({})
    for (const timeoutSeconds of ["abc", "0", "1801", "Infinity"]) {
      expect(() => dshDefaultsInput({ ...form, timeoutSeconds })).toThrow("timeout")
    }
    expect(() => dshDefaultsInput({ ...form, approvalPolicy: "always" })).toThrow("approval_policy")
  })
})
