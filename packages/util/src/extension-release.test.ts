import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  EXTENSION_ID_MAX,
  EXTENSION_ID_PATTERN,
  MAX_ARCHIVE_BYTES,
  MAX_DESCRIPTOR_BYTES,
  MAX_RELEASE_URL_LENGTH,
  ReleaseProtocolError,
  isSha256Hex,
  normalizeReleaseHttpsUrl,
  normalizeSha256Hex,
  parseReleaseDescriptor,
} from "./extension-release"

const descriptor = () => ({
  schemaVersion: 1 as const,
  id: "example.viewer",
  version: "1.2.3",
  artifact: { url: "https://cdn.example.test/viewer-1.2.3.tgz?token=private-token", sha256: "ab".repeat(32) },
})

const reason = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseProtocolError)
    expect(String(error)).not.toContain("private-token")
    expect(String(error)).not.toContain("secret-password")
    return (error as ReleaseProtocolError).reason
  }
  throw new Error("Expected a release protocol failure")
}

describe("shared limits", () => {
  test("archive and descriptor byte ceilings", () => {
    expect(MAX_ARCHIVE_BYTES).toBe(100 * 1024 * 1024)
    expect(MAX_DESCRIPTOR_BYTES).toBe(64 * 1024)
    expect(MAX_RELEASE_URL_LENGTH).toBe(16_384)
  })
})

describe("sha256 hex validation", () => {
  test("accepts exactly 64 hexadecimal digits and lowercases", () => {
    expect(isSha256Hex("ab".repeat(32))).toBe(true)
    expect(isSha256Hex("AB".repeat(32))).toBe(true)
    expect(normalizeSha256Hex("AB".repeat(32))).toBe("ab".repeat(32))
  })
  test.each([undefined, null, 1, "", "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${"a".repeat(64)}`])(
    "rejects non-digest values (%#)",
    (value) => {
      expect(isSha256Hex(value)).toBe(false)
      expect(normalizeSha256Hex(value)).toBeUndefined()
    },
  )
})

describe("extension id pattern parity", () => {
  test("util literal mirrors schema.ts ID_PATTERN byte-for-byte", () => {
    const source = readFileSync(new URL("../../opencode/src/extension/schema.ts", import.meta.url), "utf8")
    const match = /\bID_PATTERN\s*=\s*(\/[^/\n]+\/[a-z]*)/.exec(source)
    expect(match).not.toBeNull()
    expect(`/${EXTENSION_ID_PATTERN.source}/`).toBe(match![1])
  })
  test("id cap matches the schema bound", () => {
    expect(EXTENSION_ID_MAX).toBe(64)
    expect(EXTENSION_ID_PATTERN.test("a.b")).toBe(true)
    expect(EXTENSION_ID_PATTERN.test("nodot")).toBe(false)
  })
})

describe("release URL normalization", () => {
  test("uses standard WHATWG normalization", () => {
    expect(normalizeReleaseHttpsUrl("HTTPS://Releases.Example.Test:443/a/../Viewer/%7e/stable.json", { descriptor: true })).toBe(
      "https://releases.example.test/Viewer/%7e/stable.json",
    )
    expect(normalizeReleaseHttpsUrl("https://example.test", { descriptor: true })).toBe("https://example.test/")
    expect(normalizeReleaseHttpsUrl("https://example.test:8443/viewer", { descriptor: true })).toBe(
      "https://example.test:8443/viewer",
    )
  })

  test.each([
    "",
    "stable.json",
    "//releases.example.test/stable.json",
    "http://releases.example.test/stable.json",
    "file:///stable.json",
    "data:application/json,{}",
    "https:releases.example.test/stable.json",
    "https:///releases.example.test/stable.json",
    "https://",
    " https://releases.example.test/stable.json",
    "https://releases.example.test/stable file.json",
    "https://releases.example.test/\u0000stable.json",
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
  ])("rejects ambiguous, credentialed or non-stable descriptor URLs (%#)", (value) => {
    expect(reason(() => normalizeReleaseHttpsUrl(value, { descriptor: true }))).toBe("url")
  })

  test("artifact URLs keep a signed query but reject fragments", () => {
    expect(
      normalizeReleaseHttpsUrl("https://cdn.example.test/viewer.tgz?token=private-token", { descriptor: false }),
    ).toBe("https://cdn.example.test/viewer.tgz?token=private-token")
    expect(
      reason(() => normalizeReleaseHttpsUrl("https://cdn.example.test/viewer.tgz#hash", { descriptor: false })),
    ).toBe("url")
  })

  test("enforces the exact length ceiling", () => {
    const prefix = "https://example.test/"
    const value = `${prefix}${"a".repeat(16_384 - prefix.length)}`
    expect(normalizeReleaseHttpsUrl(value, { descriptor: true })).toBe(value)
    expect(reason(() => normalizeReleaseHttpsUrl(`${value}a`, { descriptor: true }))).toBe("url")
  })

  test("rejects non-string input", () => {
    expect(reason(() => normalizeReleaseHttpsUrl(undefined, { descriptor: true }))).toBe("url")
    expect(reason(() => normalizeReleaseHttpsUrl(42, { descriptor: false }))).toBe("url")
  })
})

describe("release descriptor parsing", () => {
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
  })

  test.each([undefined, null, false, 1, "{}", [], new Date(), new Map()].map((value) => [value] as const))(
    "rejects non-record data (%#)",
    (value) => {
      expect(reason(() => parseReleaseDescriptor(value))).toBe("structure")
    },
  )

  test("requires exactly the declared fields", () => {
    const input = descriptor()
    for (const key of Object.keys(input)) {
      const value: Record<string, unknown> = { ...input }
      delete value[key]
      expect(reason(() => parseReleaseDescriptor(value))).toBe("fields")
    }
    expect(reason(() => parseReleaseDescriptor({ ...input, extra: true }))).toBe("fields")
    expect(reason(() => parseReleaseDescriptor({ ...input, artifact: { ...input.artifact, extra: true } }))).toBe(
      "fields",
    )
    expect(reason(() => parseReleaseDescriptor({ ...input, [Symbol("extra")]: true }))).toBe("fields")
    expect(reason(() => parseReleaseDescriptor(Object.create(input)))).toBe("structure")
    expect(parseReleaseDescriptor(Object.assign(Object.create(null), input))).toEqual(input)
  })

  test.each([undefined, null, false, "1", 0, 2, -1, 1.1])("rejects unknown schema versions (%#)", (schemaVersion) => {
    expect(reason(() => parseReleaseDescriptor({ ...descriptor(), schemaVersion }))).toBe("schemaVersion")
  })

  test.each(["", "viewer", "Example.viewer", ".viewer", "example.", "example..viewer", `a.${"b".repeat(63)}`, null, 1])(
    "rejects invalid extension ids (%#)",
    (id) => expect(reason(() => parseReleaseDescriptor({ ...descriptor(), id }))).toBe("id"),
  )

  test("accepts the complete valid ID grammar and maximum length", () => {
    for (const id of ["a.b", "example.my-viewer", `a.${"b".repeat(62)}`]) {
      expect(parseReleaseDescriptor({ ...descriptor(), id }).id).toBe(id)
    }
  })

  test("applies the optional host version check", () => {
    const semverish = (version: string) => /^\d+\.\d+\.\d+$/.test(version)
    expect(reason(() => parseReleaseDescriptor({ ...descriptor(), version: "latest" }, { isValidVersion: semverish }))).toBe(
      "version",
    )
    expect(parseReleaseDescriptor(descriptor(), { isValidVersion: semverish }).version).toBe("1.2.3")
    expect(reason(() => parseReleaseDescriptor({ ...descriptor(), version: "" }))).toBe("version")
    expect(reason(() => parseReleaseDescriptor({ ...descriptor(), version: 1 }))).toBe("version")
  })

  test.each([undefined, null, [], "artifact", {}, { url: "https://cdn.example.test/x.tgz" }].map((v) => [v] as const))(
    "rejects missing and malformed artifact objects (%#)",
    (artifact) => expect(reason(() => parseReleaseDescriptor({ ...descriptor(), artifact }))).toMatch(/structure|fields/),
  )

  test("distinguishes artifact field type, URL and digest failures", () => {
    expect(
      reason(() => parseReleaseDescriptor({ ...descriptor(), artifact: { url: true, sha256: "ab".repeat(32) } })),
    ).toBe("artifactUrlType")
    expect(
      reason(() =>
        parseReleaseDescriptor({ ...descriptor(), artifact: { url: "http://cdn.example.test/x.tgz", sha256: "ab".repeat(32) } }),
      ),
    ).toBe("artifactUrl")
    expect(
      reason(() =>
        parseReleaseDescriptor({
          ...descriptor(),
          artifact: { url: "https://cdn.example.test/x.tgz", sha256: "x" },
        }),
      ),
    ).toBe("artifactSha256")
  })

  test("validation errors never echo descriptor fields or credentials", () => {
    for (const value of [
      { ...descriptor(), version: "private-token" },
      { ...descriptor(), id: "private-token" },
      { ...descriptor(), artifact: { url: "https://user:secret-password@host/?token=private-token", sha256: "x" } },
      { ...descriptor(), artifact: { url: descriptor().artifact.url, sha256: "private-token" } },
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

  test("keeps a declared engines.opencode range and reports its absence", () => {
    expect(parseReleaseDescriptor({ ...descriptor(), engines: { opencode: ">=1.0.0" } }).engines).toEqual({
      opencode: ">=1.0.0",
    })
    expect(parseReleaseDescriptor(descriptor()).engines).toBeUndefined()
  })

  test("applies the optional host range check", () => {
    const strict = (range: string) => range === ">=1.0.0"
    expect(
      parseReleaseDescriptor({ ...descriptor(), engines: { opencode: ">=1.0.0" } }, { isValidRange: strict }).engines,
    ).toEqual({ opencode: ">=1.0.0" })
    expect(
      reason(() =>
        parseReleaseDescriptor({ ...descriptor(), engines: { opencode: "nope" } }, { isValidRange: strict }),
      ),
    ).toBe("engines")
  })

  test.each([{}, { opencode: 1 }, { opencode: "" }, { opencode: ">=1.0.0", node: ">=18" }, "1.0.0", []].map((v) => [v] as const))(
    "rejects malformed engines declarations (%#)",
    (engines) =>
      expect(reason(() => parseReleaseDescriptor({ ...descriptor(), engines }))).toMatch(/engines|fields|structure/),
  )
})
