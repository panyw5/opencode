import { ExtensionInstallationError } from "./install-error"

export type ReleaseDescriptor = {
  id: string
  version: string
  artifactUrl: string
  artifactSha256: string
}

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_DESCRIPTOR_BYTES = 64 * 1024
const DESCRIPTOR_INVALID = "Release descriptor does not match schema version 1"

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function httpsURL(value: string, descriptor = false) {
  if (
    !/^https:\/\//i.test(value) ||
    /[\s\\\u0000-\u001f\u007f]/.test(value) ||
    value.length > 16_384 ||
    value.includes("#") ||
    (descriptor && value.includes("?"))
  ) {
    throw new ExtensionInstallationError("Release URL must be a credential-free https URL")
  }
  const target = new URL(value)
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new ExtensionInstallationError("Release URL must be a credential-free https URL")
  }
  return target.href
}

/** Data-only validation; the installer repeats schema, identity and digest checks. */
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  if (
    !exact(value, ["schemaVersion", "id", "version", "artifact"]) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    value.id.length > 64 ||
    !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(value.id) ||
    typeof value.version !== "string" ||
    !value.version ||
    !exact(value.artifact, ["url", "sha256"]) ||
    typeof value.artifact.url !== "string" ||
    typeof value.artifact.sha256 !== "string"
  ) {
    throw new ExtensionInstallationError(DESCRIPTOR_INVALID)
  }
  const artifact = value.artifact
  const url = httpsURL(artifact.url as string)
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 as string)) {
    throw new ExtensionInstallationError("Artifact digest must be 64 hexadecimal digits")
  }
  return {
    id: value.id,
    version: value.version,
    artifactUrl: url,
    artifactSha256: (artifact.sha256 as string).toLowerCase(),
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
  return { url, document, descriptor: parseReleaseDescriptor(value) }
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
  if (descriptor.artifactSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(descriptor.artifactSha256)) {
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
  if (!/^[a-f0-9]{64}$/i.test(descriptor.artifactSha256))
    throw new ExtensionInstallationError("Invalid archive SHA-256")
  return fetchArtifact(descriptor, doFetch)
}
