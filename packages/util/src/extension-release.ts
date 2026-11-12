/**
 * Shared release-channel download and descriptor rules used by the server
 * installer (packages/opencode), the desktop main process (packages/desktop)
 * and the web host (packages/app). Pure and dependency-free: transports and
 * SSRF defenses (DNS pinning, public-address filtering) stay server-side.
 */

/** Maximum compressed size accepted for an extension archive download. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
/** Maximum size accepted for a release descriptor (stable.json) document. */
export const MAX_DESCRIPTOR_BYTES = 64 * 1024
/** Maximum size accepted for a detached descriptor signature (stable.json.sig). */
export const MAX_SIGNATURE_BYTES = 4 * 1024
/** Maximum accepted length for a release or artifact URL spelling. */
export const MAX_RELEASE_URL_LENGTH = 16_384

// Canonical extension id shape. The authoritative literal is `ID_PATTERN` in
// packages/opencode/src/extension/schema.ts; this copy is pinned byte-for-byte
// by extension-release.test.ts so it cannot drift from the server schema.
export const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
export const EXTENSION_ID_MAX = 64

const SHA256_PATTERN = /^[\da-f]{64}$/i
// Full git object names: 40 hex (SHA-1 repositories) or 64 hex (SHA-256 repositories).
const COMMIT_PATTERN = /^[\da-f]{40}$|^[\da-f]{64}$/i

/** True when the value is a 64-character hexadecimal SHA-256. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

/** True when the value is a full hexadecimal git commit hash (SHA-1 or SHA-256). */
export function isCommitHex(value: unknown): value is string {
  return typeof value === "string" && COMMIT_PATTERN.test(value)
}

/** Lowercased digest, or undefined when the value is not a 64-character hex SHA-256. */
export function normalizeSha256Hex(value: unknown): string | undefined {
  return isSha256Hex(value) ? value.toLowerCase() : undefined
}

/** Stable failure tags so each host can map shared validation to its own errors. */
export type ReleaseFailure =
  | "structure"
  | "fields"
  | "schemaVersion"
  | "id"
  | "version"
  | "engines"
  | "sequence"
  | "artifactUrlType"
  | "artifactUrl"
  | "artifactSha256"
  | "source"
  | "url"

/** Validation failure. Messages are stable, generic and never echo input. */
export class ReleaseProtocolError extends Error {
  override readonly name = "ReleaseProtocolError"
  constructor(
    readonly reason: ReleaseFailure,
    message: string,
  ) {
    super(message)
  }
}

function fail(reason: ReleaseFailure, message: string): never {
  throw new ReleaseProtocolError(reason, message)
}

// A WHATWG URL host that canonicalizes to an IPv4 address is always rendered
// dotted-decimal; matching the canonical form replaces node:net isIP() so this
// module also runs in browser contexts.
const CANONICAL_IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

/**
 * Canonical credential-free HTTPS URL. Descriptor URLs must not carry a query
 * or fragment (stable source identity); artifact URLs may carry a signed
 * query but never a fragment.
 */
export function normalizeReleaseHttpsUrl(value: unknown, options: { descriptor: boolean }): string {
  // Reject backslashes, encoded hosts and unusual spellings before parsing,
  // rather than accidentally accepting a canonicalized rewrite of the host.
  if (
    typeof value !== "string" ||
    value.length > MAX_RELEASE_URL_LENGTH ||
    /[\s\\\u0000-\u001f\u007f]/.test(value)
  )
    fail("url", "invalid HTTPS URL")
  if (value.includes("#") || (options.descriptor && value.includes("?")))
    fail(
      "url",
      options.descriptor
        ? "descriptor URL must not contain a query or fragment"
        : "artifact URL must not contain a fragment",
    )
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1]
  if (!authority || authority.includes("@") || authority.includes("%"))
    fail("url", "URL must use an explicit HTTPS authority without credentials")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail("url", "invalid HTTPS URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    fail("url", "URL must use HTTPS without credentials")
  // Reject obfuscated numeric IP spellings whose raw form differs from the canonical IPv4 host.
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":")[0]
  if (CANONICAL_IPV4.test(url.hostname) && rawHost.toLowerCase() !== url.hostname)
    fail("url", "encoded IP addresses are not allowed")
  if (url.href.length > MAX_RELEASE_URL_LENGTH) fail("url", "invalid HTTPS URL")
  return url.href
}

export type ReleaseDescriptorShape = {
  schemaVersion: 1
  id: string
  version: string
  /**
   * Host compatibility range mirrored from the extension package's
   * engines.opencode. Absent means the release declares no constraint.
   */
  engines?: { opencode: string }
  /** Monotonically increasing publisher counter, covered by the detached signature. */
  sequence?: number
  artifact: { url: string; sha256: string }
  /**
   * Provenance recorded by the publisher: the monorepo commit the release was
   * built from. Informational for hosts; covered by the detached signature.
   */
  source?: { commit: string }
}

export type ReleaseDescriptorOptions = {
  /** Extra host-side version check; the server passes its strict semver rule. */
  isValidVersion?: (version: string) => boolean
  /** Extra host-side semver-range check for a declared engines.opencode value. */
  isValidRange?: (range: string) => boolean
}

function record(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("structure", "invalid descriptor structure")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return fail("structure", "invalid descriptor structure")
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== "string" || (!fields.includes(key) && !optional.includes(key))) ||
    fields.some((field) => !keys.includes(field))
  )
    return fail("fields", "descriptor fields must exactly match schema version 1")
  return value as Record<string, unknown>
}

/** Validate data only: parsing neither fetches artifacts nor loads extension code. */
export function parseReleaseDescriptor(
  value: unknown,
  options: ReleaseDescriptorOptions = {},
): ReleaseDescriptorShape {
  const descriptor = record(value, ["schemaVersion", "id", "version", "artifact"], ["engines", "sequence", "source"])
  if (descriptor.schemaVersion !== 1) fail("schemaVersion", "unsupported descriptor schema version")
  if (
    typeof descriptor.id !== "string" ||
    descriptor.id.length > EXTENSION_ID_MAX ||
    !EXTENSION_ID_PATTERN.test(descriptor.id)
  )
    fail("id", "invalid extension ID")
  if (
    typeof descriptor.version !== "string" ||
    !descriptor.version ||
    (options.isValidVersion !== undefined && !options.isValidVersion(descriptor.version))
  )
    fail("version", "invalid extension version")
  const engines = descriptor.engines
  let opencode: string | undefined
  if (engines !== undefined) {
    const declared = record(engines, ["opencode"])
    const range = declared.opencode
    if (
      typeof range !== "string" ||
      !range ||
      (options.isValidRange !== undefined && !options.isValidRange(range))
    )
      fail("engines", "invalid opencode engine range")
    opencode = range
  }
  const sequence = descriptor.sequence
  if (sequence !== undefined && (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0))
    fail("sequence", "invalid descriptor sequence")
  const artifact = record(descriptor.artifact, ["url", "sha256"])
  if (typeof artifact.url !== "string") fail("artifactUrlType", "invalid artifact HTTPS URL")
  let url: string
  try {
    url = normalizeReleaseHttpsUrl(artifact.url, { descriptor: false })
  } catch (error) {
    if (error instanceof ReleaseProtocolError) return fail("artifactUrl", error.message)
    throw error
  }
  const sha256 = artifact.sha256
  if (!isSha256Hex(sha256)) fail("artifactSha256", "a 64-character hexadecimal SHA-256 is required")
  let commit: string | undefined
  if (descriptor.source !== undefined) {
    const source = record(descriptor.source, ["commit"])
    if (!isCommitHex(source.commit)) fail("source", "a full hexadecimal git commit hash is required")
    commit = source.commit.toLowerCase()
  }
  return {
    schemaVersion: 1,
    id: descriptor.id,
    version: descriptor.version,
    ...(opencode === undefined ? {} : { engines: { opencode } }),
    ...(sequence === undefined ? {} : { sequence }),
    artifact: { url, sha256: sha256.toLowerCase() },
    ...(commit === undefined ? {} : { source: { commit } }),
  }
}
