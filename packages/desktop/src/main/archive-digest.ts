import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export function archiveSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

/**
 * Digest of a local extension archive. Reads the whole file; archives are
 * bounded by the installer's own limits, this is a UI affordance so the user
 * can compare against the published digest before installing.
 */
export async function extensionArchiveDigest(path: string): Promise<{ path: string; size: number; sha256: string }> {
  if (typeof path !== "string" || !/\.tgz$/i.test(path.trim())) {
    throw new Error("Only .tgz extension archives are supported")
  }
  const trimmed = path.trim()
  const info = await stat(trimmed)
  if (!info.isFile()) throw new Error("Not a regular file")
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error("Archive is too large")
  const { readFile } = await import("node:fs/promises")
  const bytes = await readFile(trimmed)
  return { path: trimmed, size: info.size, sha256: archiveSha256(bytes) }
}
