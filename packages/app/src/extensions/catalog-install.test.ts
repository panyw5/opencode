import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import {
  fetchArtifact,
  fetchArtifactVerified,
  fetchReleaseDescriptor,
  fetchReleaseDocument,
  parseReleaseDescriptor,
} from "./catalog-install"

const bytes = new Uint8Array([7, 8, 9])
const digest = createHash("sha256").update(bytes).digest("hex")
const descriptor = {
  schemaVersion: 1,
  id: "local.wls-repl",
  version: "1.18.64",
  artifact: { url: "https://downloads.example.com/wls.tgz", sha256: digest },
}
const fetchText = (text: string) => (async () => new Response(text)) as unknown as typeof fetch

describe("release descriptor validation", () => {
  test("validates schema and preserves original JSON text for the trusted installer", async () => {
    const text = JSON.stringify(descriptor, null, 2) + "\n"
    const result = await fetchReleaseDocument("https://example.com/stable.json", fetchText(text))
    expect(result.document).toBe(text)
    expect(result.url).toBe("https://example.com/stable.json")
    expect(result.descriptor).toEqual({
      id: descriptor.id,
      version: descriptor.version,
      artifactUrl: descriptor.artifact.url,
      artifactSha256: digest,
    })
    expect(await fetchReleaseDescriptor(result.url, fetchText(text))).toEqual(result.descriptor)
  })
  test("requires schema version 1 with exact fields", () => {
    for (const value of [
      { ...descriptor, schemaVersion: 2 },
      { ...descriptor, extra: true },
      { ...descriptor, id: "bad" },
      { ...descriptor, artifact: { ...descriptor.artifact, extra: true } },
    ]) {
      expect(() => parseReleaseDescriptor(value)).toThrow(/schema version 1/)
    }
  })
  test("keeps an optional engines.opencode range and rejects malformed declarations", () => {
    const parsed = parseReleaseDescriptor({ ...descriptor, engines: { opencode: ">=1.0.0" } })
    expect(parsed.engines).toEqual({ opencode: ">=1.0.0" })
    expect(parseReleaseDescriptor(descriptor).engines).toBeUndefined()
    for (const engines of [{}, { opencode: 1 }, { opencode: "latest" }, { opencode: ">=1.0.0", node: ">=18" }, "x"]) {
      expect(() => parseReleaseDescriptor({ ...descriptor, engines })).toThrow()
    }
  })
  test("rejects unsafe descriptor URLs before fetching", async () => {
    for (const url of [
      "http://example.com/stable.json",
      "https://u:p@example.com/stable.json",
      "https://example.com/stable.json?token=secret",
      "https://example.com/stable.json#hash",
    ]) {
      await expect(
        fetchReleaseDocument(url, (() => {
          throw new Error("must not fetch")
        }) as unknown as typeof fetch),
      ).rejects.toThrow(/https/)
    }
  })
  test("reports HTML as a raw JSON URL diagnostic", async () => {
    await expect(
      fetchReleaseDocument("https://example.com/stable.json", fetchText("<html>GitHub</html>")),
    ).rejects.toThrow(/raw stable.json/)
  })
  test("bounds descriptor bytes both declared and streamed", async () => {
    await expect(fetchReleaseDocument("https://example.com/stable.json", fetchText(" ".repeat(65537)))).rejects.toThrow(
      /64 KiB/,
    )
    await expect(
      fetchReleaseDocument(
        "https://example.com/stable.json",
        (async () => new Response("x", { headers: { "content-length": "65537" } })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/64 KiB/)
  })
  test("does not expose raw fetch errors or URLs", async () => {
    await expect(
      fetchReleaseDocument("https://example.com/stable.json", (async () => {
        throw new Error("secret capability")
      }) as unknown as typeof fetch),
    ).rejects.toThrow("Release descriptor download failed; check the network/proxy")
  })
})

describe("artifact downloads", () => {
  test("fallback transport refuses redirects and a downgraded final response", async () => {
    const response = new Response(bytes)
    Object.defineProperty(response, "url", { value: "http://downloads.example.com/wls.tgz" })
    await expect(
      fetchArtifact({ id: "", version: "", artifactUrl: descriptor.artifact.url }, (async (
        _input: unknown,
        init: RequestInit,
      ) => {
        expect(init.redirect).toBe("error")
        return response
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/download failed/)
  })
  test("checks publisher digest and returns verified bytes", async () => {
    const result = await fetchArtifactVerified(
      parseReleaseDescriptor(descriptor),
      (async () => new Response(bytes)) as unknown as typeof fetch,
    )
    expect(result.digest).toBe(digest)
    expect([...result.bytes]).toEqual([...bytes])
  })
  test("archive mode computes digest when the user supplied none", async () => {
    const result = await fetchArtifact(
      { id: "", version: "", artifactUrl: descriptor.artifact.url },
      (async () => new Response(bytes)) as unknown as typeof fetch,
    )
    expect(result.digest).toBe(digest)
  })
  test("rejects mismatched digest and unsafe artifact URLs", async () => {
    await expect(
      fetchArtifactVerified(
        { ...parseReleaseDescriptor(descriptor), artifactSha256: "b".repeat(64) },
        (async () => new Response(bytes)) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/digest/)
    for (const url of [
      "http://example.com/a.tgz",
      "https://u:p@example.com/a.tgz",
      "https://example.com/a.tgz#fragment",
    ]) {
      await expect(fetchArtifactVerified({ ...parseReleaseDescriptor(descriptor), artifactUrl: url })).rejects.toThrow(
        /https/,
      )
    }
  })
  test("rejects oversize artifacts before buffering", async () => {
    await expect(
      fetchArtifactVerified(
        parseReleaseDescriptor(descriptor),
        (async () =>
          new Response(bytes, { headers: { "content-length": String(101 * 1024 * 1024) } })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/100 MiB/)
  })
})
