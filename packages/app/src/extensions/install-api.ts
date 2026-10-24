import type { useGlobalSDK } from "@/context/global-sdk"
import type {
  InstallationCommitInput,
  InstallationRequest,
  PreparedInstallation,
  InstallationResult,
  InstallationStatus,
} from "../pages/install-actions-state"

export type {
  InstallationCommitInput,
  InstallationRequest,
  PreparedInstallation,
  InstallationResult,
  InstallationStatus,
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
    if (!response.data || response.error) throw new Error()
    return response.data
  } catch {
    // SDK errors may contain the confirmation header; never forward them to a toast or logger.
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
