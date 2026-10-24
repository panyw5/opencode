import { isIP } from "node:net"
import semver from "semver"
import { requestJsonDocument } from "./download"
import { ID_PATTERN } from "./schema"

export type ReleaseDescriptor = {
  schemaVersion: 1
  id: string
  version: string
  artifact: { url: string; sha256: string }
}

export type ResolvedRelease = Omit<ReleaseDescriptor, "schemaVersion"> & {
  descriptor: string
  descriptorSha256: string
}

function fail(message: string): never {
  // Never include descriptor/artifact input or validation-library errors: URLs may contain secrets.
  throw new Error(`Extension release: ${message}`)
}

function httpsURL(value: string, descriptor: boolean) {
  if (typeof value !== "string" || value.length > 16_384 || /[\s\\\u0000-\u001f\u007f]/.test(value))
    fail("invalid HTTPS URL")
  if (value.includes("#") || (descriptor && value.includes("?")))
    fail(
      descriptor ? "descriptor URL must not contain a query or fragment" : "artifact URL must not contain a fragment",
    )
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1]
  if (!authority || authority.includes("@") || authority.includes("%"))
    fail("URL must use an explicit HTTPS authority without credentials")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail("invalid HTTPS URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname)
    fail("URL must use HTTPS without credentials")
  // Preserve the downloader's rejection of obfuscated numeric IP spellings before canonicalization.
  const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]
  if (isIP(url.hostname) === 4 && rawHost.toLowerCase() !== url.hostname) fail("encoded IP addresses are not allowed")
  if (url.href.length > 16_384) fail("invalid HTTPS URL")
  return url.href
}

/** Stable source identity uses the initial URL, never a redirect destination. */
export function normalizeReleaseUrl(value: string): string {
  return httpsURL(value, true)
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid descriptor structure")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail("invalid descriptor structure")
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
    return fail("descriptor fields must exactly match schema version 1")
  return value as Record<string, unknown>
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[\da-f]{64}$/i.test(value))
    return fail("a 64-character hexadecimal SHA-256 is required")
  return value.toLowerCase()
}

/** Validate data only: parsing neither fetches artifacts nor loads extension code. */
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  const descriptor = record(value, ["schemaVersion", "id", "version", "artifact"])
  if (descriptor.schemaVersion !== 1) fail("unsupported descriptor schema version")
  if (typeof descriptor.id !== "string" || descriptor.id.length > 64 || !ID_PATTERN.test(descriptor.id))
    fail("invalid extension ID")
  if (typeof descriptor.version !== "string" || !semver.valid(descriptor.version)) fail("invalid extension version")
  const artifact = record(descriptor.artifact, ["url", "sha256"])
  if (typeof artifact.url !== "string") fail("invalid artifact HTTPS URL")
  return {
    schemaVersion: 1,
    id: descriptor.id,
    version: descriptor.version,
    artifact: { url: httpsURL(artifact.url, false), sha256: sha256(artifact.sha256) },
  }
}

export async function resolveRelease(
  url: string,
  options: { signal?: AbortSignal; transport?: typeof requestJsonDocument } = {},
): Promise<ResolvedRelease> {
  const descriptor = normalizeReleaseUrl(url)
  const document = await (options.transport ?? requestJsonDocument)(descriptor, {
    signal: options.signal,
    maxBytes: 64 * 1024,
  })
  const parsed = parseReleaseDescriptor(document.value)
  return {
    descriptor,
    id: parsed.id,
    version: parsed.version,
    artifact: parsed.artifact,
    descriptorSha256: sha256(document.sha256),
  }
}
