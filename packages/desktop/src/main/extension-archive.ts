import { ipcMain } from "electron"
import { extensionArchiveDigest } from "./archive-digest"
import type { LocalSidecarServer } from "./server"

export type ExtensionArchiveServer = Pick<LocalSidecarServer, "extensionArchive"> | null

export type ExtensionArchiveDeps = {
  /** Resolved per call so a sidecar reload is always picked up. */
  server: () => ExtensionArchiveServer
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
