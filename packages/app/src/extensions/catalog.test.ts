import { describe, expect, test } from "bun:test"
import { builtinCatalog, pendingCatalogEntries } from "./catalog"

describe("builtin catalog", () => {
  test("every entry carries a credential-free https release URL", () => {
    for (const entry of builtinCatalog) {
      const url = new URL(entry.releaseUrl)
      expect(url.protocol).toBe("https:")
      expect(url.username).toBe("")
      expect(url.search).toBe("")
      expect(url.pathname.endsWith(".json")).toBe(true)
    }
  })

  test("pendingCatalogEntries filters out installed ids", () => {
    expect(pendingCatalogEntries([])).toHaveLength(builtinCatalog.length)
    expect(pendingCatalogEntries(["local.wls-repl"])).toHaveLength(builtinCatalog.length - 1)
    expect(pendingCatalogEntries(["other.extension"]).map((entry) => entry.id)).toContain("local.wls-repl")
  })
})
