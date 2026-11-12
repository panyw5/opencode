import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ipcMain, net } from "electron"
import {
  MAX_ARCHIVE_BYTES,
  MAX_DESCRIPTOR_BYTES,
  MAX_SIGNATURE_BYTES,
  isSha256Hex,
} from "@opencode-ai/util/extension-release"
import { downloadExtensionArchive } from "./extension-download"
import { extensionArchiveDigest } from "./archive-digest"
import type { LocalSidecarServer } from "./server"

export type ExtensionArchiveServer = Pick<LocalSidecarServer, "extensionArchive"> | null

export type ExtensionArchiveDeps = {
  /** Resolved per call so a sidecar reload is always picked up. */
  server: () => ExtensionArchiveServer
}

const STAGED_MAX_BYTES = MAX_ARCHIVE_BYTES
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
  const directory = await mkdtemp(join(tmpdir(), "opencode-ext-"))
  const path = join(directory, "package.tgz")
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
    stagedFiles.add(path)
    return { path }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function cleanupStagedArchive(path: string): Promise<void> {
  if (typeof path !== "string" || !stagedFiles.delete(path)) return
  await rm(dirname(path), { recursive: true, force: true }).catch(() => undefined)
}

type ArchiveOpPayload = {
  request?: unknown
  release?: { url?: unknown; descriptor?: unknown; signature?: unknown; path?: unknown }
  archive?: { path?: unknown; sha256?: unknown }
  operationId?: unknown
  token?: unknown
  input?: unknown
}

export function registerExtensionArchiveIpcHandlers(deps: ExtensionArchiveDeps) {
  ipcMain.handle("extension-archive-download", async (_event, url: unknown) => {
    try {
      if (typeof url !== "string" || url.length > 16_384) throw new Error()
      const bytes = await downloadExtensionArchive(
        url,
        (url, init) =>
          new Promise<Response>((resolve, reject) => {
            const request = net.request({ url, redirect: "manual", useSessionCookies: false })
            const abort = () => request.abort()
            init.signal?.addEventListener("abort", abort, { once: true })
            request.on("error", () => {
              init.signal?.removeEventListener("abort", abort)
              reject(new Error("Archive download failed"))
            })
            request.on("redirect", (status, _method, redirectURL) => {
              init.signal?.removeEventListener("abort", abort)
              resolve(new Response(null, { status, headers: { location: redirectURL } }))
              request.abort()
            })
            request.on("response", (response) => {
              response.on("end", () => init.signal?.removeEventListener("abort", abort))
              const headers = new Headers()
              for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
              }
              resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      let ended = false
                      let bytes = 0
                      const fail = () => {
                        if (ended) return
                        ended = true
                        controller.error(new Error("Archive download failed"))
                      }
                      response.on("end", () => {
                        if (!ended) {
                          ended = true
                          controller.close()
                        }
                      })
                      response.on("error", fail)
                      response.on("aborted", fail)
                      response.on("data", (chunk) => {
                        if (ended) return
                        bytes += chunk.byteLength
                        if (bytes > STAGED_MAX_BYTES) {
                          fail()
                          request.abort()
                          return
                        }
                        controller.enqueue(new Uint8Array(chunk))
                      })
                    },
                    cancel() {
                      request.abort()
                    },
                  }),
                  { status: response.statusCode, headers },
                ),
              )
            })
            if (init.signal?.aborted) {
              request.abort()
              reject(new Error("Archive download failed"))
              return
            }
            request.end()
          }),
      )
      console.info(`[extension-install] main HTTPS archive downloaded bytes=${bytes.byteLength}`)
      return { ok: true, value: { bytes } }
    } catch {
      return {
        ok: false,
        error: { message: "Archive download failed; check the network/proxy or use a local .tgz file" },
      }
    }
  })
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
      const release = payload.release
      if (release !== undefined) {
        try {
          if (
            !release ||
            typeof release.url !== "string" ||
            typeof release.descriptor !== "string" ||
            Buffer.byteLength(release.descriptor, "utf8") > MAX_DESCRIPTOR_BYTES ||
            (release.signature !== undefined &&
              (typeof release.signature !== "string" ||
                Buffer.byteLength(release.signature, "utf8") > MAX_SIGNATURE_BYTES)) ||
            typeof release.path !== "string" ||
            !stagedFiles.has(release.path)
          ) {
            throw new Error("Invalid staged release request")
          }
          const descriptor = JSON.parse(release.descriptor) as { artifact?: { sha256?: unknown } }
          const expected = descriptor?.artifact?.sha256
          if (!isSha256Hex(expected)) throw new Error("Invalid release artifact SHA-256")
          const digest = await extensionArchiveDigest(release.path)
          if (digest.sha256 !== expected.toLowerCase())
            throw new Error("Archive digest does not match the release descriptor")
          console.info("[extension-install] main staged release digest verified")
        } catch {
          return { ok: false, error: { code: "invalid", message: "Staged release validation failed" } }
        }
      } else if (payload.archive !== undefined) {
        const archive = payload.archive
        try {
          if (
            !archive ||
            typeof archive.path !== "string" ||
            !stagedFiles.has(archive.path) ||
            !isSha256Hex(archive.sha256)
          )
            throw new Error()
          const digest = await extensionArchiveDigest(archive.path)
          if (digest.sha256 !== archive.sha256.toLowerCase()) throw new Error()
        } catch {
          return {
            ok: false,
            error: { code: "integrity", message: "Archive digest does not match the requested sha256" },
          }
        }
      } else {
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
