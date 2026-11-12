import { describe, expect, test } from "bun:test"
import {
  builtinCatalog,
  catalogCompatibility,
  hostCompatibility,
  pendingCatalogEntries,
  resetCatalogCompatibility,
} from "./catalog"

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

describe("hostCompatibility", () => {
  test("accepts host versions inside the declared range", () => {
    for (const range of [">=1.18.0", "^1.18.0", "*", "1.x"]) {
      expect(hostCompatibility({ opencode: range }, "1.18.64")).toEqual({ ok: true, declared: true, range })
    }
  })

  test("rejects host versions outside the declared range", () => {
    for (const range of [">=2.0.0", "<1.18.0"]) {
      expect(hostCompatibility({ opencode: range }, "1.18.64")).toEqual({ ok: false, declared: true, range })
    }
  })

  test("treats a missing range as compatible but undeclared", () => {
    expect(hostCompatibility(undefined, "1.18.64")).toEqual({ ok: true, declared: false })
    expect(hostCompatibility({}, "1.18.64")).toEqual({ ok: true, declared: false })
    expect(hostCompatibility({ opencode: ">=2.0.0" }, undefined).ok).toBe(true)
  })

  test("skips the gate for non-semver and major-0 host builds", () => {
    expect(hostCompatibility({ opencode: ">=2.0.0" }, "local").ok).toBe(true)
    expect(hostCompatibility({ opencode: ">=2.0.0" }, "0.0.0").ok).toBe(true)
  })
})

describe("catalogCompatibility", () => {
  test("evaluates the descriptor's declared range once and caches the verdict", async () => {
    resetCatalogCompatibility()
    const document = JSON.stringify({
      schemaVersion: 1,
      id: "local.wls-repl",
      version: "1.0.0",
      engines: { opencode: ">=99.0.0" },
      artifact: { url: "https://example.com/ext.tgz", sha256: "ab".repeat(32) },
    })
    const fetched: string[] = []
    const doFetch = (async (url: RequestInfo | URL) => {
      fetched.push(String(url))
      return new Response(document)
    }) as unknown as typeof fetch
    const url = "https://example.com/stable.json"
    expect((await catalogCompatibility(url, doFetch, "1.18.64")).ok).toBe(false)
    expect((await catalogCompatibility(url, doFetch, "1.18.64")).ok).toBe(false)
    // The descriptor is fetched once; the artifact URL is never requested.
    expect(fetched.filter((item) => item === url)).toHaveLength(1)
    expect(fetched.some((item) => item.endsWith(".tgz"))).toBe(false)
    resetCatalogCompatibility()
  })

  test("a descriptor without engines stays compatible but undeclared", async () => {
    resetCatalogCompatibility()
    const document = JSON.stringify({
      schemaVersion: 1,
      id: "local.wls-repl",
      version: "1.0.0",
      artifact: { url: "https://example.com/ext.tgz", sha256: "ab".repeat(32) },
    })
    const doFetch = (async () => new Response(document)) as unknown as typeof fetch
    expect(await catalogCompatibility("https://example.com/undeclared.json", doFetch, "1.18.64")).toEqual({
      ok: true,
      declared: false,
    })
    resetCatalogCompatibility()
  })
})
