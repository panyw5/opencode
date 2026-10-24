import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { fetchReleaseDescriptor, parseReleaseDescriptor, runCatalogInstall } from "./catalog-install"

const artifactSha256 = createHash("sha256")
  .update(new Uint8Array([7, 8, 9]))
  .digest("hex")

const descriptor = {
  schemaVersion: 1,
  id: "local.wls-repl",
  version: "1.18.58",
  artifact: {
    url: "https://downloads.example.com/wls-1.18.58.tgz",
    sha256: artifactSha256,
  },
}

describe("parseReleaseDescriptor", () => {
  test("accepts a valid descriptor", () => {
    const parsed = parseReleaseDescriptor(descriptor)
    expect(parsed.id).toBe("local.wls-repl")
    expect(parsed.artifactSha256).toBe(artifactSha256)
  })

  test("rejects non-https, credentialed or malformed artifacts", () => {
    expect(() =>
      parseReleaseDescriptor({ ...descriptor, artifact: { url: "http://x/y.tgz", sha256: "a".repeat(64) } }),
    ).toThrow(/https/)
    expect(() =>
      parseReleaseDescriptor({ ...descriptor, artifact: { url: "https://u:p@x/y.tgz", sha256: "a".repeat(64) } }),
    ).toThrow(/https/)
    expect(() =>
      parseReleaseDescriptor({ ...descriptor, artifact: { url: "https://x/y.tgz", sha256: "short" } }),
    ).toThrow(/digest/)
    expect(() => parseReleaseDescriptor({ id: "x" })).toThrow()
  })
})

describe("fetchReleaseDescriptor", () => {
  test("rejects non-https release urls before fetching", async () => {
    await expect(fetchReleaseDescriptor("http://example.com/stable.json")).rejects.toThrow(/https/)
  })
})

const ARTIFACT_BYTES = new Uint8Array([7, 8, 9])

function fakeFetch(descriptorBody: string) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("stable.json")) {
      return new Response(descriptorBody, { status: 200 })
    }
    return new Response(ARTIFACT_BYTES, { status: 200 })
  }) as typeof fetch
}

describe("runCatalogInstall", () => {
  test("stages verified bytes, prepares and commits with enable=true", async () => {
    const calls: Array<{ op: string; payload: Record<string, unknown> }> = []
    const cleanups: string[] = []
    const result = await runCatalogInstall(
      { id: "local.wls-repl", name: "wls", author: "p", releaseUrl: "https://x.invalid/stable.json" },
      {
        stage: async (staged) => {
          expect([...staged]).toEqual([...ARTIFACT_BYTES])
          return { ok: true, value: { path: "/tmp/staged.tgz" } }
        },
        op: async (op, payload) => {
          calls.push({ op, payload })
          if (op === "prepare") {
            return {
              ok: true,
              value: { operationId: "op-1", token: "tok", kind: "install" },
            }
          }
          return { ok: true, value: { state: "committed" } }
        },
        cleanup: async (path) => {
          cleanups.push(path)
        },
      },
      () => {},
      fakeFetch(JSON.stringify(descriptor)),
    )
    expect(calls.map((call) => call.op)).toEqual(["prepare", "commit"])
    expect(calls[0]!.payload.request).toMatchObject({
      kind: "install",
      source: { type: "local", path: "/tmp/staged.tgz", sha256: artifactSha256 },
    })
    expect(calls[1]!.payload).toMatchObject({ operationId: "op-1", token: "tok", input: { enable: true } })
    expect(cleanups).toEqual(["/tmp/staged.tgz"])
    void result
  })

  test("mismatched digest aborts before staging", async () => {
    const badDescriptor = { ...descriptor, artifact: { url: "https://x.invalid/y.tgz", sha256: "b".repeat(64) } }
    let staged = false
    await expect(
      runCatalogInstall(
        { id: "local.wls-repl", name: "wls", author: "p", releaseUrl: "https://x.invalid/stable.json" },
        {
          stage: async () => {
            staged = true
            return { ok: true, value: { path: "/tmp/staged.tgz" } }
          },
          op: async () => ({ ok: true, value: {} }),
          cleanup: async () => undefined,
        },
        () => {},
        fakeFetch(JSON.stringify(badDescriptor)),
      ),
    ).rejects.toThrow(/digest/)
    expect(staged).toBe(false)
  })

  test("descriptor id mismatch aborts", async () => {
    await expect(
      runCatalogInstall(
        { id: "other.extension", name: "x", author: "p", releaseUrl: "https://x.invalid/stable.json" },
        {
          stage: async () => ({ ok: true, value: { path: "/tmp/x" } }),
          op: async () => ({ ok: true, value: {} }),
          cleanup: async () => undefined,
        },
        () => {},
        fakeFetch(JSON.stringify(descriptor)),
      ),
    ).rejects.toThrow(/does not match/)
  })
})
