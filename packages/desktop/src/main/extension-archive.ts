import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ipcMain } from "electron"
import { extensionArchiveDigest } from "./archive-digest"
import type { LocalSidecarServer } from "./server"

export type ExtensionArchiveServer = Pick<LocalSidecarServer, "extensionArchive"> | null

export type ExtensionArchiveDeps = {
  /** Resolved per call so a sidecar reload is always picked up. */
  server: () => ExtensionArchiveServer
}

const STAGED_MAX_BYTES = 200 * 1024 * 1024
const stagedFiles = new Set<string>()

/**
 * Persists renderer-downloaded archive bytes to a staging file for the
 * local-archive install channel. The digest is re-verified downstream by the
 * main prepare handler and the installation service; staging only persists
 * the bytes the renderer already checked against the release descriptor.
 */
export async function stageArchiveBytes(bytes: Uint8Array): Promise<{ path: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("Archive bytes are required")
  }
  if (bytes.byteLength > STAGED_MAX_BYTES) {
    throw new Error("Archive is too large")
  }
  const path = join(tmpdir(), `opencode-ext-${randomUUID()}.tgz`)
  const { writeFile } = await import("node:fs/promises")
  await writeFile(path, bytes)
  stagedFiles.add(path)
  return { path }
}

export async function cleanupStagedArchive(path: string): Promise<void> {
  if (typeof path !== "string" || !path.startsWith(tmpdir()) || !path.endsWith(".tgz")) return
  stagedFiles.delete(path)
  await rm(path, { force: true }).catch(() => undefined)
}

type ArchiveOpPayload = {
  request?: unknown
  operationId?: unknown
  token?: unknown
  input?: unknown
}

export function registerExtensionArchiveIpcHandlers(deps: ExtensionArchiveDeps) {
  ipcMain.handle("extension-archive-digest", async (_event, path: unknown) => {
    try {
      return { ok: true, value: await extensionArchiveDigest(path as string) }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  })
  ipcMain.handle("extension-archive-stage", async (_event, bytes: unknown) => {
    try {
      return { ok: true, value: await stageArchiveBytes(bytes as Uint8Array) }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  })
  ipcMain.handle("extension-archive-cleanup", async (_event, path: unknown) => {
    try {
      await cleanupStagedArchive(path as string)
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
    }
  })
  ipcMain.handle("extension-archive-op", async (_event, op: unknown, rawPayload: unknown) => {
    const sidecar = deps.server()
    if (!sidecar) {
      return { ok: false, error: { message: "Server is not running" } }
    }
    const payload = (rawPayload ?? {}) as ArchiveOpPayload
    // Re-verify the digest against the actual file bytes: the renderer's
    // comparison is UX only; this is the trusted check.
    if (op === "prepare") {
      const envelope = payload.request as { source?: { type?: string; path?: unknown; sha256?: unknown } } | undefined
      const local = envelope?.source
      if (local?.type !== "local" || typeof local.path !== "string" || typeof local.sha256 !== "string") {
        return { ok: false, error: { message: "Local archive request requires a path and sha256" } }
      }
      try {
        const digest = await extensionArchiveDigest(local.path)
        if (digest.sha256 !== local.sha256.toLowerCase()) {
          return {
            ok: false,
            error: { code: "integrity", message: "Archive digest does not match the requested sha256" },
          }
        }
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    }
    try {
      const value = await sidecar.extensionArchive(
        op as "prepare" | "commit" | "status" | "cancel",
        payload as Record<string, unknown>,
      )
      if (op === "commit" || op === "cancel") {
        const source = payload.request as { source?: { path?: unknown } } | undefined
        const staged = source?.source?.path
        if (typeof staged === "string" && stagedFiles.has(staged)) {
          void cleanupStagedArchive(staged)
        }
      }
      return { ok: true, value }
    } catch (error) {
      const withCode = error as { code?: string }
      return {
        ok: false,
        error: {
          code: withCode?.code,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  })
}
