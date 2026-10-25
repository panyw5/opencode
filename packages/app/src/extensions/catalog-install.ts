import type { CatalogEntry } from "../extensions/catalog"

export type ReleaseDescriptor = {
  id: string
  version: string
  artifactUrl: string
  artifactSha256: string
}

export type CatalogFlowStage = "descriptor" | "artifact" | "ready" | "preparing" | "committing" | "done" | "error"

export type CatalogFlowState = {
  stage: CatalogFlowStage
  message?: string
  descriptor?: ReleaseDescriptor
  size?: number
  digest?: string
  result?: string
}

/**
 * Parses and validates a release descriptor document. Credential-free https,
 * a known schema and a 64-hex digest are required — the same rules the
 * server-side release resolver applies.
 */
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release descriptor is not an object")
  }
  const raw = value as {
    id?: unknown
    version?: unknown
    artifact?: { url?: unknown; sha256?: unknown }
  }
  if (typeof raw.id !== "string" || !raw.id || typeof raw.version !== "string" || !raw.version) {
    throw new Error("Release descriptor is missing id or version")
  }
  const url = raw.artifact?.url
  const sha256 = raw.artifact?.sha256
  if (typeof url !== "string" || typeof sha256 !== "string") {
    throw new Error("Release descriptor is missing artifact url or sha256")
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Artifact URL is invalid")
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Artifact URL must be a credential-free https URL")
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("Artifact digest must be 64 hexadecimal digits")
  }
  return { id: raw.id, version: raw.version, artifactUrl: parsed.href, artifactSha256: sha256.toLowerCase() }
}

/** Fetches the release descriptor through the renderer (system proxy applies). */
export async function fetchReleaseDescriptor(
  releaseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<ReleaseDescriptor> {
  let target: URL
  try {
    target = new URL(releaseUrl)
  } catch {
    throw new Error("Release URL is invalid")
  }
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("Release URL must be a credential-free https URL")
  }
  const response = await doFetch(target.href, { redirect: "error" })
  if (!response.ok) throw new Error(`Release descriptor request failed (${response.status})`)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Release descriptor is not valid JSON")
  }
  return parseReleaseDescriptor(parsed)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Fetches the artifact and verifies its digest against the descriptor. */
export async function fetchArtifactVerified(
  descriptor: ReleaseDescriptor,
  doFetch: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; digest: string }> {
  // Release assets redirect to the CDN; the descriptor pins the digest, so
  // following the redirect is safe and the digest check below is the gate.
  const response = await doFetch(descriptor.artifactUrl)
  if (!response.ok) throw new Error(`Archive request failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = await sha256Hex(bytes)
  if (digest !== descriptor.artifactSha256) {
    throw new Error("Archive digest does not match the release descriptor")
  }
  return { bytes, digest }
}

/**
 * Drives the full assisted flow for one catalog entry: descriptor → verified
 * artifact download (both through the renderer, so system proxy settings
 * apply) → staging → managed local install. Resolves with the commit result.
 */
export async function runCatalogInstall(
  entry: CatalogEntry,
  io: {
    stage: (
      bytes: Uint8Array,
    ) => Promise<{ ok: true; value: { path: string } } | { ok: false; error: { message: string } }>
    op: (
      op: "prepare" | "commit" | "status" | "cancel" | "cleanup-retained",
      payload: Record<string, unknown>,
    ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } }>
    cleanup: (path: string) => Promise<unknown>
  },
  onStage: (stage: CatalogFlowStage, message?: string) => void,
  doFetch: typeof fetch = fetch,
): Promise<unknown> {
  onStage("descriptor")
  const descriptor = await fetchReleaseDescriptor(entry.releaseUrl, doFetch)
  if (descriptor.id !== entry.id) {
    throw new Error(`Descriptor id ${descriptor.id} does not match catalog entry ${entry.id}`)
  }
  onStage("artifact")
  const { bytes } = await fetchArtifactVerified(descriptor, doFetch)

  // A deferred uninstall may have left a retained tombstone whose archive
  // identity (a temporary staging path) would reject this reinstall at the
  // source-identity check. When the tombstone's bytes match what we just
  // verified, consume it first; anything else is left to the normal checks.
  await io.op("cleanup-retained", { extensionID: descriptor.id, sha256: descriptor.artifactSha256 })

  onStage("ready")
  const staged = await io.stage(bytes)
  if (!staged.ok) throw new Error(staged.error.message)
  const path = staged.value.path

  const unwrap = <T>(
    response: { ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } },
  ): T => {
    if (!response.ok) {
      const error = new Error(response.error.message) as Error & { code?: string }
      error.code = response.error.code
      throw error
    }
    return response.value as T
  }

  try {
    onStage("preparing")
    const prepared = unwrap<{
      operationId: string
      token: string
      kind: string
      permissions?: string[]
      version?: string
    }>(
      await io.op("prepare", {
        request: { kind: "install", source: { type: "local", path, sha256: descriptor.artifactSha256 } },
      }),
    )

    onStage("committing")
    const result = unwrap<{ state?: string }>(
      await io.op("commit", {
        operationId: prepared.operationId,
        token: prepared.token,
        input: { enable: true },
      }),
    )
    onStage("done")
    return result
  } finally {
    void io.cleanup(path)
  }
}
