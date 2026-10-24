import type { InstallationOperations, InstallationRequest } from "../pages/install-actions-state"

/**
 * Desktop-only installation operations backed by the desktop IPC channel.
 * The sidecar runs the same managed installation service as the CLI inside
 * the server process; the HTTP API stays CLI-only for local paths, so this
 * channel exists only in the desktop app where the drop originates.
 */
export function createLocalInstallationOperations(
  invoke: (
    op: "prepare" | "commit" | "status" | "cancel",
    payload: Record<string, unknown>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } }>,
): InstallationOperations {
  async function call<T>(op: "prepare" | "commit" | "status" | "cancel", payload: Record<string, unknown>): Promise<T> {
    const response = await invoke(op, payload)
    if (!response.ok) {
      const error = new Error(response.error.message) as Error & { code?: string }
      error.code = response.error.code
      throw error
    }
    return response.value as T
  }
  return {
    prepareInstallation: async (request: InstallationRequest) =>
      call("prepare", { request: request as unknown as Record<string, unknown> }),
    commitInstallation: async (prepared, input) =>
      call("commit", {
        operationId: prepared.operationId,
        token: prepared.token,
        input: {
          enable: input?.enable ?? false,
          ...(input?.acceptRegistryUpgrade === undefined ? {} : { acceptRegistryUpgrade: input.acceptRegistryUpgrade }),
        },
      }),
    installationStatus: async (prepared) =>
      call("status", { operationId: prepared.operationId, token: prepared.token }),
    cancelInstallation: async (prepared) =>
      call("cancel", { operationId: prepared.operationId, token: prepared.token }),
  }
}

/**
 * Digest comparison for the confirm field: normalized (case/whitespace) so
 * pasting a checksum with stray spaces still matches, while any real
 * difference blocks the install. The installer re-verifies the digest against
 * the file bytes server-side; this comparison is UX-only.
 */
export function digestMatches(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase() && /^[a-f0-9]{64}$/i.test(actual.trim())
}

type ArchiveDropHandler = (paths: string[]) => boolean

let archiveDropHandler: ArchiveDropHandler | undefined

/** Registers the single consumer of .tgz drops (the Extensions config section). */
export function registerArchiveDropHandler(handler: ArchiveDropHandler): () => void {
  archiveDropHandler = handler
  return () => {
    if (archiveDropHandler === handler) archiveDropHandler = undefined
  }
}

/**
 * Returns true when a registered consumer took the drop. Layout calls this
 * before routing dropped files to the composer so .tgz archives can open the
 * install dialog instead of becoming chat attachments.
 */
export function takeArchiveDrop(paths: string[]): boolean {
  const handler = archiveDropHandler
  if (!handler) return false
  return handler(paths)
}
