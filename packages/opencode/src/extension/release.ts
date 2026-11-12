import semver from "semver"
import {
  MAX_DESCRIPTOR_BYTES,
  MAX_SIGNATURE_BYTES,
  ReleaseProtocolError,
  isSha256Hex,
  normalizeReleaseHttpsUrl,
  parseReleaseDescriptor as parseDescriptor,
  type ReleaseDescriptorShape,
} from "@opencode-ai/util/extension-release"
import { requestJsonDocument } from "./download"
import { satisfiesHostRange } from "@/plugin/shared"
import {
  SignatureError,
  TRUSTED_KEYS,
  signatureURL,
  trustedKeysFor,
  verifyDescriptorSignature,
  type TrustedKey,
} from "./trust"

export type ReleaseDescriptor = ReleaseDescriptorShape

export type ResolvedRelease = Omit<ReleaseDescriptor, "schemaVersion"> & {
  descriptor: string
  descriptorSha256: string
  /** Present only after a trusted-origin detached signature verified. */
  signature?: { keyId: string }
}

function fail(message: string): never {
  // Never include descriptor/artifact input or validation-library errors: URLs may contain secrets.
  throw new Error(`Extension release: ${message}`)
}

function rethrow(error: unknown): never {
  if (error instanceof ReleaseProtocolError) fail(error.message)
  throw error
}

/** Stable source identity uses the initial URL, never a redirect destination. */
export function normalizeReleaseUrl(value: string): string {
  try {
    return normalizeReleaseHttpsUrl(value, { descriptor: true })
  } catch (error) {
    return rethrow(error)
  }
}

function sha256(value: unknown): string {
  if (!isSha256Hex(value)) fail("a 64-character hexadecimal SHA-256 is required")
  return value.toLowerCase()
}

/** Validate data only: parsing neither fetches artifacts nor loads extension code. */
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  try {
    return parseDescriptor(value, {
      isValidVersion: (version) => semver.valid(version) !== null,
      isValidRange: (range) => semver.validRange(range) !== null,
    })
  } catch (error) {
    return rethrow(error)
  }
}

/**
 * Host compatibility gate for a parsed descriptor. Mirrors the install-time
 * engines.opencode check in plugin/shared (checkPluginCompatibility): an
 * absent range is unrestricted, and a host version that is not a usable semver
 * (development "local" builds, major 0) skips the gate entirely.
 */
export function releaseCompatible(release: Pick<ReleaseDescriptor, "engines">, hostVersion: string): boolean {
  const range = release.engines?.opencode
  if (typeof range !== "string") return true
  if (!semver.valid(hostVersion) || semver.major(hostVersion) === 0) return true
  return satisfiesHostRange(hostVersion, range)
}

export async function resolveRelease(
  url: string,
  options: {
    signal?: AbortSignal
    transport?: typeof requestJsonDocument
    /** Trusted-key injection for tests; requests never select verification keys. */
    trustedKeys?: readonly TrustedKey[]
  } = {},
): Promise<ResolvedRelease> {
  const descriptor = normalizeReleaseUrl(url)
  const transport = options.transport ?? requestJsonDocument
  const document = await transport(descriptor, {
    signal: options.signal,
    maxBytes: MAX_DESCRIPTOR_BYTES,
  })
  const parsed = parseReleaseDescriptor(document.value)
  // A trusted origin must present a detached Ed25519 signature over the exact
  // descriptor bytes; origins outside the trust list keep unsigned behaviour.
  const trusted = trustedKeysFor(descriptor, options.trustedKeys ?? TRUSTED_KEYS)
  let signature: { keyId: string } | undefined
  if (trusted.length) {
    if (!document.bytes) throw new SignatureError("Extension release signature: descriptor bytes unavailable")
    let signed: Awaited<ReturnType<typeof requestJsonDocument>>
    try {
      signed = await transport(signatureURL(descriptor), {
        signal: options.signal,
        maxBytes: MAX_SIGNATURE_BYTES,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new SignatureError("Extension release signature: signature unavailable")
    }
    signature = verifyDescriptorSignature({
      url: descriptor,
      descriptor: document.bytes,
      document: signed.value,
      keys: trusted,
    })
  }
  return {
    descriptor,
    id: parsed.id,
    version: parsed.version,
    engines: parsed.engines,
    ...(parsed.sequence === undefined ? {} : { sequence: parsed.sequence }),
    artifact: parsed.artifact,
    ...(parsed.source === undefined ? {} : { source: parsed.source }),
    descriptorSha256: sha256(document.sha256),
    ...(signature === undefined ? {} : { signature }),
  }
}
