import { describe, expect, test } from "bun:test"
import { compareByProviderOrder, compareProviderGroups } from "./provider-order"

describe("compareByProviderOrder", () => {
  test("orders providers by config key order", () => {
    const order = ["axonhub", "deepseek", "aether"]
    const ids = ["aether", "axonhub", "deepseek", "volces"]
    const sorted = ids.slice().sort((a, b) => compareByProviderOrder(order, a, b))
    expect(sorted).toEqual(["axonhub", "deepseek", "aether", "volces"])
  })

  test("puts unknown providers after configured ones, sorted by id", () => {
    const order = ["axonhub"]
    const ids = ["zeta", "axonhub", "alpha"]
    const sorted = ids.slice().sort((a, b) => compareByProviderOrder(order, a, b))
    expect(sorted).toEqual(["axonhub", "alpha", "zeta"])
  })
})

describe("compareProviderGroups", () => {
  test("uses config order when present", () => {
    const order = ["go", "aether"]
    const fallback = ["opencode", "anthropic"]
    expect(compareProviderGroups(order, "aether", "go", fallback)).toBeGreaterThan(0)
    expect(compareProviderGroups(order, "go", "aether", fallback)).toBeLessThan(0)
  })

  test("falls back to popularProviders when config order is empty", () => {
    const fallback = ["opencode", "anthropic", "openai"]
    expect(compareProviderGroups([], "anthropic", "openai", fallback)).toBeLessThan(0)
    expect(compareProviderGroups([], "openai", "opencode", fallback)).toBeGreaterThan(0)
    expect(compareProviderGroups([], "custom-a", "custom-b", fallback)).toBeLessThan(0)
  })
})
