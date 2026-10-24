import { describe, expect, test } from "bun:test"
import { builtinCatalog, pendingCatalogEntries } from "./catalog"

describe("builtin catalog", () => {
  test("wls-repl entry carries a credential-free https release URL", () => {
    const entry = builtinCatalog.find((item) => item.id === "local.wls-repl")
    expect(entry).toBeDefined()
    const url = new URL(entry!.releaseUrl)
    expect(url.protocol).toBe("https:")
    expect(url.username).toBe("")
    expect(url.search).toBe("")
    expect(url.pathname.endsWith(".json")).toBe(true)
  })

  test("pendingCatalogEntries filters out installed ids", () => {
    expect(pendingCatalogEntries([])).toHaveLength(builtinCatalog.length)
    expect(pendingCatalogEntries(["local.wls-repl"])).toHaveLength(0)
    expect(pendingCatalogEntries(["other.extension"]).map((entry) => entry.id)).toContain("local.wls-repl")
  })
})
