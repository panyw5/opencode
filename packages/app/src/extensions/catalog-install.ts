import semver from "semver"
import {
  MAX_ARCHIVE_BYTES,
  MAX_DESCRIPTOR_BYTES,
  MAX_SIGNATURE_BYTES,
  ReleaseProtocolError,
  isSha256Hex,
  normalizeReleaseHttpsUrl,
  parseReleaseDescriptor as parseSharedDescriptor,
} from "@opencode-ai/util/extension-release"
import { ExtensionInstallationError } from "./install-error"

export type ReleaseDescriptor = {
  id: string
  version: string
  artifactUrl: string
  artifactSha256: string
  /** Host compatibility range declared by the release; absent means unrestricted but undeclared. */
  engines?: { opencode: string }
}

const DESCRIPTOR_INVALID = "Release descriptor does not match schema version 1"

function httpsURL(value: string, descriptor = false) {
  try {
    return normalizeReleaseHttpsUrl(value, { descriptor })
  } catch (error) {
    if (error instanceof ReleaseProtocolError) {
      throw new ExtensionInstallationError("Release URL must be a credential-free https URL")
    }
    throw error
  }
}

/** Data-only validation; the installer repeats schema, identity and digest checks. */
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  let parsed: ReturnType<typeof parseSharedDescriptor>
  try {
    parsed = parseSharedDescriptor(value, { isValidRange: (range) => semver.validRange(range) !== null })
  } catch (error) {
    if (!(error instanceof ReleaseProtocolError)) throw error
    if (error.reason === "artifactUrl") {
      throw new ExtensionInstallationError("Release URL must be a credential-free https URL")
    }
    if (error.reason === "artifactSha256") {
      throw new ExtensionInstallationError("Artifact digest must be 64 hexadecimal digits")
    }
    throw new ExtensionInstallationError(DESCRIPTOR_INVALID)
  }
  return {
    id: parsed.id,
    version: parsed.version,
    artifactUrl: parsed.artifact.url,
    artifactSha256: parsed.artifact.sha256,
    ...(parsed.engines === undefined ? {} : { engines: parsed.engines }),
  }
}

async function boundedBytes(response: Response, limit: number, message: string): Promise<Uint8Array> {
  if (Number(response.headers?.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new ExtensionInstallationError(message)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > limit) throw new ExtensionInstallationError(message)
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new ExtensionInstallationError(message)
    return bytes
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Preserve the original JSON text for independent validation by the local installer. */
export async function fetchReleaseDocument(releaseUrl: string, doFetch: typeof fetch = fetch) {
  const url = httpsURL(releaseUrl, true)
  let response: Response
  try {
    response = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error()
  } catch {
    throw new ExtensionInstallationError("Release descriptor download failed; check the network/proxy")
  }
  let bytes: Uint8Array
  try {
    bytes = await boundedBytes(response, MAX_DESCRIPTOR_BYTES, "Release descriptor exceeds the 64 KiB download limit")
  } catch (error) {
    if (error instanceof ExtensionInstallationError) throw error
    throw new ExtensionInstallationError("Release descriptor download failed; check the network/proxy")
  }
  let document: string
  let value: unknown
  try {
    document = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    value = JSON.parse(document)
  } catch {
    throw new ExtensionInstallationError(
      "Release descriptor is not valid JSON; use a raw stable.json URL, not a web page",
    )
  }
  // The detached signature is optional here: the installer enforces it for
  // pinned trusted origins and treats a missing or unreadable one as unsigned.
  let signature: string | undefined
  try {
    const signed = await doFetch(`${url}.sig`, { redirect: "error", signal: AbortSignal.timeout(120_000) })
    if (signed.ok) {
      const bytes_sig = await boundedBytes(
        signed,
        MAX_SIGNATURE_BYTES,
        "Release signature exceeds the 4 KiB download limit",
      )
      signature = new TextDecoder("utf-8", { fatal: true }).decode(bytes_sig)
    }
  } catch {
    signature = undefined
  }
  return { url, document, signature, descriptor: parseReleaseDescriptor(value) }
}

export async function fetchReleaseDescriptor(releaseUrl: string, doFetch: typeof fetch = fetch) {
  return (await fetchReleaseDocument(releaseUrl, doFetch)).descriptor
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Chromium/system-proxy download. Main and sidecar independently recheck the digest. */
export async function fetchArtifact(
  descriptor: Omit<ReleaseDescriptor, "artifactSha256"> & { artifactSha256?: string },
  doFetch: typeof fetch = fetch,
  download?: (url: string) => Promise<Uint8Array>,
): Promise<{ bytes: Uint8Array; digest: string }> {
  const url = httpsURL(descriptor.artifactUrl)
  if (descriptor.artifactSha256 !== undefined && !isSha256Hex(descriptor.artifactSha256)) {
    throw new ExtensionInstallationError("Invalid archive SHA-256")
  }
  try {
    const bytes = download
      ? await download(url)
      : await (async () => {
          const response = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) })
          if (response.url && new URL(response.url).protocol !== "https:") throw new Error()
          if (!response.ok) throw new Error()
          return boundedBytes(response, MAX_ARCHIVE_BYTES, "Archive exceeds the 100 MiB download limit")
        })()
    if (bytes.byteLength > MAX_ARCHIVE_BYTES)
      throw new ExtensionInstallationError("Archive exceeds the 100 MiB download limit")
    const digest = await sha256Hex(bytes)
    if (descriptor.artifactSha256 !== undefined && digest !== descriptor.artifactSha256.toLowerCase()) {
      throw new ExtensionInstallationError("Archive digest does not match the release descriptor")
    }
    return { bytes, digest }
  } catch (error) {
    if (error instanceof ExtensionInstallationError) throw error
    throw new ExtensionInstallationError("Archive download failed; check the network/proxy or use a local .tgz file")
  }
}

export async function fetchArtifactVerified(descriptor: ReleaseDescriptor, doFetch: typeof fetch = fetch) {
  if (!isSha256Hex(descriptor.artifactSha256)) throw new ExtensionInstallationError("Invalid archive SHA-256")
  return fetchArtifact(descriptor, doFetch)
}
