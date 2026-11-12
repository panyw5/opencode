import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { requestJsonDocument, type DownloadAddress, type DownloadTransport } from "../../src/extension/download"
import {
  normalizeReleaseUrl,
  parseReleaseDescriptor,
  releaseCompatible,
  resolveRelease,
} from "../../src/extension/release"

const url = "https://releases.example.test/viewer/stable.json"
const artifact = "https://cdn.example.test/viewer-1.2.3.tgz?token=private-token"
const publicIP: DownloadAddress = { address: "93.184.216.34", family: 4 }
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const descriptor = () => ({
  schemaVersion: 1 as const,
  id: "example.viewer",
  version: "1.2.3",
  artifact: { url: artifact, sha256: "ab".repeat(32) },
})

function transport(
  options: {
    bytes?: Uint8Array
    lookup?: DownloadTransport["lookup"]
    request?: DownloadTransport["request"]
  } = {},
) {
  const requests: Parameters<DownloadTransport["request"]>[0][] = []
  const lookups: string[] = []
  const network: DownloadTransport = {
    async lookup(hostname, signal) {
      lookups.push(hostname)
      return options.lookup ? options.lookup(hostname, signal) : [publicIP]
    },
    async request(input) {
      requests.push(input)
      if (options.request) return options.request(input)
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield options.bytes ?? Buffer.from(JSON.stringify(descriptor()))
        })(),
      }
    },
  }
  const fetch: typeof requestJsonDocument = (url, options) =>
    requestJsonDocument(url, { ...options, transport: network })
  return { fetch, requests, lookups }
}

async function redacted(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("private-token")
    expect(String(error)).not.toContain("secret-password")
    expect((error as Error).cause).toBeUndefined()
    return error as Error
  }
  throw new Error("Expected a release failure")
}

describe("release descriptor URL", () => {
  test("uses standard normalization without merging distinct paths", () => {
    expect(normalizeReleaseUrl("HTTPS://Releases.Example.Test:443/a/../Viewer/%7e/stable.json")).toBe(
      "https://releases.example.test/Viewer/%7e/stable.json",
    )
    expect(normalizeReleaseUrl("https://example.test")).toBe("https://example.test/")
    expect(normalizeReleaseUrl("https://example.test/版本.json")).toBe("https://example.test/%E7%89%88%E6%9C%AC.json")
    expect(normalizeReleaseUrl("https://example.test/Viewer")).not.toBe(
      normalizeReleaseUrl("https://example.test/viewer"),
    )
    expect(normalizeReleaseUrl("https://example.test/viewer/")).not.toBe(
      normalizeReleaseUrl("https://example.test/viewer"),
    )
    expect(normalizeReleaseUrl("https://example.test:8443/viewer")).toBe("https://example.test:8443/viewer")
  })

  test.each([
    "",
    "stable.json",
    "/stable.json",
    "//releases.example.test/stable.json",
    "http://releases.example.test/stable.json",
    "file:///stable.json",
    "data:application/json,{}",
    "https:releases.example.test/stable.json",
    "https:///releases.example.test/stable.json",
    "https://",
    " https://releases.example.test/stable.json",
    "https://releases.example.test/stable file.json",
    "https://releases.example.test/\tstable.json",
    "https://releases.example.test/\nstable.json",
    "https://releases.example.test/\u0000stable.json",
    "https://releases.example.test/\u007fstable.json",
    "https://releases.example.test/ stable.json",
    "https://releases.example.test\\@host/stable.json",
    "https://user:secret-password@releases.example.test/stable.json",
    "https://user@releases.example.test/stable.json",
    "https://@releases.example.test/stable.json",
    "https://%72eleases.example.test/stable.json",
    "https://134744072/stable.json",
    "https://0x08080808/stable.json",
    "https://010.010.010.010/stable.json",
    "https://releases.example.test/stable.json?token=private-token",
    "https://releases.example.test/stable.json?",
    "https://releases.example.test/stable.json#private-token",
    "https://releases.example.test/stable.json#",
    `https://releases.example.test/${"a".repeat(16_384)}`,
  ])("rejects ambiguous, credentialed or non-stable URL (%#)", (value) => {
    expect(() => normalizeReleaseUrl(value)).toThrow()
    try {
      normalizeReleaseUrl(value)
    } catch (error) {
      expect(String(error)).not.toContain("private-token")
      expect(String(error)).not.toContain("secret-password")
    }
  })

  test("allows percent-encoded path separators as path data and enforces the exact length ceiling", () => {
    const prefix = "https://example.test/"
    const value = `${prefix}${"a".repeat(16_384 - prefix.length)}`
    expect(normalizeReleaseUrl(value)).toBe(value)
    expect(() => normalizeReleaseUrl(`${value}a`)).toThrow()
    expect(normalizeReleaseUrl("https://example.test/%3F%23%20.json")).toBe("https://example.test/%3F%23%20.json")
  })
})

describe("release descriptor parser", () => {
  test("validates schema v1, returns a copy and normalizes artifact URL and digest", () => {
    const input = descriptor()
    input.artifact.url = "HTTPS://CDN.Example.Test:443/a/../viewer.tgz?token=private-token"
    input.artifact.sha256 = input.artifact.sha256.toUpperCase()
    const parsed = parseReleaseDescriptor(input)
    expect(parsed).toEqual({
      ...descriptor(),
      artifact: { url: "https://cdn.example.test/viewer.tgz?token=private-token", sha256: "ab".repeat(32) },
    })
    expect(parsed).not.toBe(input)
    expect(parsed.artifact).not.toBe(input.artifact)
    expect(input.artifact.sha256).toBe("AB".repeat(32))
  })

  test.each([undefined, null, false, 1, "{}", [], new Date(), new Map()].map((value) => [value] as const))(
    "rejects non-record data (%#)",
    (value) => {
      expect(() => parseReleaseDescriptor(value)).toThrow("structure")
    },
  )

  test("requires exactly the declared top-level and artifact fields", () => {
    const input = descriptor()
    for (const key of Object.keys(input)) {
      const value: Record<string, unknown> = { ...input }
      delete value[key]
      expect(() => parseReleaseDescriptor(value)).toThrow()
    }
    for (const key of ["url", "sha256"]) {
      const value: Record<string, unknown> = { ...input.artifact }
      delete value[key]
      expect(() => parseReleaseDescriptor({ ...input, artifact: value })).toThrow()
    }
    for (const key of ["scripts", "signature", "command", "url", "private-token", "__proto__"]) {
      expect(() => parseReleaseDescriptor({ ...input, [key]: "private-token" })).toThrow("fields")
      expect(() => parseReleaseDescriptor({ ...input, artifact: { ...input.artifact, [key]: true } })).toThrow(
        key === "url" ? "HTTPS URL" : "fields",
      )
    }
    expect(() => parseReleaseDescriptor({ ...input, [Symbol("extra")]: true })).toThrow("fields")
    const inherited = Object.create(input)
    expect(() => parseReleaseDescriptor(inherited)).toThrow("structure")
    expect(parseReleaseDescriptor(Object.assign(Object.create(null), input))).toEqual(input)
  })

  test.each([undefined, null, false, "1", 0, 2, -1, 1.1])("rejects unknown schema versions (%#)", (schemaVersion) => {
    expect(() => parseReleaseDescriptor({ ...descriptor(), schemaVersion })).toThrow("schema version")
  })

  test.each([
    "",
    "viewer",
    "Example.viewer",
    ".viewer",
    "example.",
    "example..viewer",
    "example.view_er",
    "a. b",
    "a/b.c",
    "a.b\n",
    `a.${"b".repeat(63)}`,
    null,
    1,
  ])("uses the host ID grammar and 64-character limit (%#)", (id) =>
    expect(() => parseReleaseDescriptor({ ...descriptor(), id })).toThrow("ID"),
  )

  test("allows the host's complete valid ID grammar and maximum length", () => {
    for (const id of ["a.b", "example.my-viewer", `a.${"b".repeat(62)}`]) {
      expect(parseReleaseDescriptor({ ...descriptor(), id }).id).toBe(id)
    }
  })

  test.each([undefined, null, 1, "", "latest", "^1.2.3", "1.2", "1.2.03", "1.2.3.4", "1.2.3\nprivate-token"])(
    "requires a valid semver version (%#)",
    (version) => expect(() => parseReleaseDescriptor({ ...descriptor(), version })).toThrow("version"),
  )

  test("preserves valid version strings for exact manifest identity comparison", () => {
    for (const version of ["0.0.0", "1.2.3-beta.1+build.5", "v1.2.3"]) {
      expect(parseReleaseDescriptor({ ...descriptor(), version }).version).toBe(version)
    }
  })

  test.each(
    [undefined, null, [], "artifact", {}, { url: artifact }, { sha256: "ab".repeat(32) }].map(
      (value) => [value] as const,
    ),
  )("rejects missing and malformed artifact objects (%#)", (artifact) =>
    expect(() => parseReleaseDescriptor({ ...descriptor(), artifact })).toThrow(),
  )

  test.each([
    undefined,
    null,
    1,
    "",
    "viewer.tgz",
    "/viewer.tgz",
    "//cdn.example.test/viewer.tgz",
    "http://cdn.example.test/viewer.tgz",
    "file:///viewer.tgz",
    "https:cdn.example.test/viewer.tgz",
    "https:///cdn.example.test/viewer.tgz",
    "https://user:secret-password@cdn.example.test/viewer.tgz",
    "https://@cdn.example.test/viewer.tgz",
    "https://cdn.example.test/viewer.tgz#private-token",
    "https://cdn.example.test/viewer.tgz#",
    "https://cdn.example.test/viewer file.tgz",
    "https://cdn.example.test\\@host/viewer.tgz",
    `https://cdn.example.test/${"x".repeat(16_384)}`,
  ])("requires absolute credential-free HTTPS artifacts without fragments (%#)", (url) => {
    expect(() => parseReleaseDescriptor({ ...descriptor(), artifact: { url, sha256: "ab".repeat(32) } })).toThrow()
  })

  test.each([
    undefined,
    null,
    1,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    ` ${"a".repeat(64)}`,
    `${"a".repeat(64)}\n`,
    `sha256-${"a".repeat(64)}`,
  ])("requires exactly 64 hexadecimal SHA-256 characters (%#)", (sha256) =>
    expect(() => parseReleaseDescriptor({ ...descriptor(), artifact: { url: artifact, sha256 } })).toThrow("SHA-256"),
  )

  test("validation errors do not include descriptor fields or artifact credentials/query", () => {
    for (const value of [
      { ...descriptor(), version: "private-token" },
      { ...descriptor(), id: "private-token" },
      { ...descriptor(), artifact: { url: "https://user:secret-password@host/?token=private-token", sha256: "x" } },
      { ...descriptor(), artifact: { url: artifact, sha256: "private-token" } },
      { ...descriptor(), "private-token": "secret-password" },
    ]) {
      try {
        parseReleaseDescriptor(value)
        throw new Error("Expected descriptor failure")
      } catch (error) {
        expect(String(error)).not.toContain("private-token")
        expect(String(error)).not.toContain("secret-password")
      }
    }
  })

  test("keeps a declared engines.opencode range; absent stays absent", () => {
    expect(parseReleaseDescriptor({ ...descriptor(), engines: { opencode: ">=1.0.0" } }).engines).toEqual({
      opencode: ">=1.0.0",
    })
    expect(parseReleaseDescriptor(descriptor()).engines).toBeUndefined()
  })

  test.each([{}, { opencode: 1 }, { opencode: "" }, { opencode: "latest" }, { opencode: ">=1.0.0", node: ">=18" }, "1.0.0", []].map(
    (value) => [value] as const,
  ))("rejects malformed engines declarations (%#)", (engines) =>
    expect(() => parseReleaseDescriptor({ ...descriptor(), engines })).toThrow(),
  )
})

describe("release host compatibility", () => {
  const release = (range?: string) => ({ engines: range === undefined ? undefined : { opencode: range } })

  test("accepts host versions inside the declared range", () => {
    for (const range of [">=1.0.0", "^1.18.0", "*", "1.x"]) {
      expect(releaseCompatible(release(range), "1.18.64")).toBe(true)
    }
  })

  test("rejects host versions outside the declared range", () => {
    for (const range of [">=2.0.0", "<1.18.0", "^2.0.0"]) {
      expect(releaseCompatible(release(range), "1.18.64")).toBe(false)
    }
  })

  test("treats a missing range as unrestricted and unusable host versions as ungated", () => {
    expect(releaseCompatible(release(), "1.18.64")).toBe(true)
    expect(releaseCompatible(release(">=2.0.0"), "local")).toBe(true)
    expect(releaseCompatible(release(">=2.0.0"), "0.0.0")).toBe(true)
  })
})

describe("release resolver", () => {
  test("forwards the 64KiB bound and signal while retaining normalized initial source identity", async () => {
    const calls: [string, Parameters<typeof requestJsonDocument>[1]][] = []
    const controller = new AbortController()
    const result = await resolveRelease("HTTPS://Releases.Example.Test:443/a/../stable.json", {
      signal: controller.signal,
      transport: async (url, options) => {
        calls.push([url, options])
        return { value: descriptor(), sha256: "CD".repeat(32) }
      },
    })
    expect(calls).toEqual([
      ["https://releases.example.test/stable.json", { signal: controller.signal, maxBytes: 64 * 1024 }],
    ])
    expect(result).toEqual({
      descriptor: "https://releases.example.test/stable.json",
      id: "example.viewer",
      version: "1.2.3",
      artifact: descriptor().artifact,
      descriptorSha256: "cd".repeat(32),
    })
  })

  test("propagates a declared engines range", async () => {
    const f = transport({ bytes: Buffer.from(JSON.stringify({ ...descriptor(), engines: { opencode: ">=1.0.0" } })) })
    const result = await resolveRelease(url, { transport: f.fetch, trustedKeys: [] })
    expect(result.engines).toEqual({ opencode: ">=1.0.0" })
  })

  test("only requests the descriptor, never the artifact or extension code", async () => {
    const f = transport()
    const result = await resolveRelease(url, { transport: f.fetch })
    expect(result.descriptor).toBe(url)
    expect(f.requests.map((entry) => entry.url.href)).toEqual([url])
    expect(f.requests[0]!.address).toBe(publicIP.address)
    expect(f.lookups).toEqual(["releases.example.test"])
  })

  test("refuses an invalid source before invoking transport", async () => {
    let calls = 0
    await redacted(
      resolveRelease(`${url}?token=private-token`, {
        transport: async () => {
          calls++
          return { value: descriptor(), sha256: "0".repeat(64) }
        },
      }),
    )
    expect(calls).toBe(0)
  })

  test("different original document bytes produce different descriptor hashes", async () => {
    const compact = Buffer.from(JSON.stringify(descriptor()))
    const pretty = Buffer.from(JSON.stringify(descriptor(), null, 2))
    const first = await resolveRelease(url, { transport: transport({ bytes: compact }).fetch })
    const second = await resolveRelease(url, { transport: transport({ bytes: pretty }).fetch })
    expect(first.descriptorSha256).toBe(hash(compact))
    expect(second.descriptorSha256).toBe(hash(pretty))
    expect(first.descriptorSha256).not.toBe(second.descriptorSha256)
    expect({ ...first, descriptorSha256: "" }).toEqual({ ...second, descriptorSha256: "" })
  })

  test("accepts exactly 64KiB and rejects oversized streamed descriptors", async () => {
    const json = JSON.stringify(descriptor())
    const maximum = Buffer.from(json.padEnd(64 * 1024, " "))
    expect((await resolveRelease(url, { transport: transport({ bytes: maximum }).fetch })).descriptorSha256).toBe(
      hash(maximum),
    )
    const f = transport({ bytes: Buffer.concat([maximum, Buffer.from(" ")]) })
    await expect(resolveRelease(url, { transport: f.fetch })).rejects.toThrow("byte limit")
  })

  test("rejects bad encoding, schema and digest without returning partial results", async () => {
    for (const bytes of [
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<html>private-token</html>"),
      Buffer.from(JSON.stringify({ ...descriptor(), schemaVersion: 2 })),
    ]) {
      await redacted(resolveRelease(url, { transport: transport({ bytes }).fetch }))
    }
    await expect(
      resolveRelease(url, {
        transport: async () => ({ value: descriptor(), sha256: "invalid" }),
      }),
    ).rejects.toThrow("SHA-256")
  })

  test("retains the initial URL across safe cross-host redirects", async () => {
    const f = transport({
      request: async (input) => {
        expect(input.address).toBe(publicIP.address)
        return f.requests.length === 1
          ? {
              status: 302,
              headers: { location: "https://cdn.example.test/final.json?token=private-token" },
              body: (async function* () {})(),
            }
          : {
              status: 200,
              headers: {},
              body: (async function* () {
                yield Buffer.from(JSON.stringify(descriptor()))
              })(),
            }
      },
    })
    expect((await resolveRelease(url, { transport: f.fetch })).descriptor).toBe(url)
    expect(f.lookups).toEqual(["releases.example.test", "cdn.example.test"])
    expect(f.requests).toHaveLength(2)
  })

  test("inherits private-address, mixed-DNS, unsafe redirect and rebinding defenses", async () => {
    const privateURL = transport()
    await redacted(resolveRelease("https://127.0.0.1/stable.json", { transport: privateURL.fetch }))
    expect(privateURL.requests).toHaveLength(0)
    const mixed = transport({ lookup: async () => [publicIP, { address: "10.0.0.1", family: 4 }] })
    await redacted(resolveRelease(url, { transport: mixed.fetch }))
    expect(mixed.requests).toHaveLength(0)
    for (const location of [
      "http://cdn.example.test/stable.json",
      "https://169.254.169.254/stable.json",
      "https://user:secret-password@host/?token=private-token",
    ]) {
      const f = transport({
        request: async () => ({ status: 302, headers: { location }, body: (async function* () {})() }),
      })
      await redacted(resolveRelease(url, { transport: f.fetch }))
      expect(f.requests).toHaveLength(1)
    }
    let lookups = 0
    const rebinding = transport({
      lookup: async () => (++lookups === 1 ? [publicIP] : [{ address: "127.0.0.1", family: 4 }]),
      request: async () => ({ status: 302, headers: { location: "/again" }, body: (async function* () {})() }),
    })
    await redacted(resolveRelease(url, { transport: rebinding.fetch }))
    expect(rebinding.requests).toHaveLength(1)
  })

  test("uses the secure default transport even without dependency injection", async () => {
    // Private literals are rejected before any real network connection can be made.
    await expect(resolveRelease("https://127.0.0.1/stable.json")).rejects.toThrow("publicly routable")
  })

  test("inherits cancellation and redaction of network/TLS failures", async () => {
    const controller = new AbortController()
    controller.abort(new Error("https://host/?token=private-token"))
    const f = transport()
    expect((await redacted(resolveRelease(url, { signal: controller.signal, transport: f.fetch }))).name).toBe(
      "AbortError",
    )
    expect(f.lookups).toHaveLength(0)
    const tls = transport({
      request: async () => {
        throw new Error("https://user:secret-password@host/?token=private-token")
      },
    })
    await redacted(resolveRelease(url, { transport: tls.fetch }))
  })
})
