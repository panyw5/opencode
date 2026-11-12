import type { useGlobalSDK } from "@/context/global-sdk"
import { ExtensionInstallationError, installationDiagnostic, installationDiagnosticCategory } from "./install-error"
import type {
  InstallationCommitInput,
  InstallationRequest,
  PreparedInstallation,
  InstallationResult,
  InstallationStatus,
  InstallationUnlockResult,
} from "../pages/install-actions-state"

export type {
  InstallationCommitInput,
  InstallationRequest,
  PreparedInstallation,
  InstallationResult,
  InstallationStatus,
  InstallationUnlockResult,
}

/** A durable status is not a substitute for refreshing the host's manifest view. */
export async function synchronizeInstallation<T extends InstallationStatus>(
  value: T,
  refresh: () => Promise<void>,
): Promise<T> {
  if (value.state !== "prepared" && value.committed) {
    try {
      await refresh()
    } catch {
      value.synced = false
    }
  }
  return value
}

async function result<T>(request: () => Promise<{ data?: T; error?: unknown }>) {
  try {
    const response = await request()
    if (response.error) {
      const message = installationDiagnostic(response.error)
      if (message) throw new ExtensionInstallationError(message)
    }
    if (!response.data || response.error) throw new Error()
    return response.data
  } catch (error) {
    if (error instanceof ExtensionInstallationError) throw error
    // With `{ throwOnError: true }` the SDK re-throws the decoded error body as
    // an Error (raw body under `cause`). Curated backend diagnostics inside that
    // body are whitelisted and rethrown; everything else — transport noise,
    // HTML error pages, anything echoing the confirmation header or capabilities
    // — collapses to a generic message. Only the fixed ASCII category may reach
    // the log line; the raw error object is never stringified or logged.
    const message = installationDiagnostic(error)
    if (message) throw new ExtensionInstallationError(message)
    console.warn(`[extension-install] operation failed category=${installationDiagnosticCategory(error)}`)
    throw new Error("Extension operation could not be completed")
  }
}

const noRedirect = { redirect: "error" as const }

export function createInstallationApi(globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">) {
  return {
    async prepare(request: InstallationRequest) {
      // Local sources are desktop-only (IPC channel); HTTP stays CLI-only for
      // local paths, so a local request here is a caller bug.
      if ("source" in request && request.source.type === "local") {
        throw new Error("Local archive sources are installed through the desktop channel")
      }
      type PrepareArgs = Parameters<typeof globalSDK.client.extensionInstallation.prepare>
      const wire = request as NonNullable<PrepareArgs[0]>["extensionPrepareInput"]
      return result<PreparedInstallation>(() =>
        globalSDK.client.extensionInstallation.prepare({ extensionPrepareInput: wire }, noRedirect),
      )
    },
    async commit(prepared: PreparedInstallation, input: InstallationCommitInput = {}) {
      const client = globalSDK.client.extensionInstallation
      const fields = { operationId: prepared.operationId, "x-opencode-extension-token": prepared.token }
      const upgrade =
        input.acceptRegistryUpgrade === undefined ? {} : { acceptRegistryUpgrade: input.acceptRegistryUpgrade }
      if (prepared.kind === "install")
        return result(() => client.install({ ...fields, ...upgrade, enable: input.enable ?? false }, noRedirect))
      if (prepared.kind === "update")
        return result(() => client.update({ ...fields, ...upgrade, id: prepared.id }, noRedirect))
      return result(() => client.uninstall({ ...fields, id: prepared.id }, noRedirect))
    },
    async status(prepared: PreparedInstallation) {
      return result<InstallationStatus>(() =>
        globalSDK.client.extensionInstallation.status(
          {
            operationId: prepared.operationId,
            "x-opencode-extension-token": prepared.token,
          },
          noRedirect,
        ),
      )
    },
    async unlock() {
      return result<InstallationUnlockResult>(() => globalSDK.client.extensionInstallation.unlock(noRedirect))
    },
    async cancel(prepared: PreparedInstallation) {
      return result(() =>
        globalSDK.client.extensionInstallation.cancel(
          {
            operationId: prepared.operationId,
            "x-opencode-extension-token": prepared.token,
          },
          noRedirect,
        ),
      )
    },
  }
}
