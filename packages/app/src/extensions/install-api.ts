import type {
  ExtensionPreparedOperation,
  ExtensionInstallResult,
  ExtensionOperationStatus,
  ExtensionPrepareInput,
} from "@opencode-ai/sdk/v2/client"
import type { useGlobalSDK } from "@/context/global-sdk"

export type InstallationRequest = ExtensionPrepareInput
export type PreparedInstallation = ExtensionPreparedOperation
export type InstallationResult = ExtensionInstallResult
export type InstallationStatus = ExtensionOperationStatus

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
      return result(() =>
        globalSDK.client.extensionInstallation.prepare({ extensionPrepareInput: request }, noRedirect),
      )
    },
    async commit(prepared: PreparedInstallation, input: { enable?: boolean } = {}) {
      const client = globalSDK.client.extensionInstallation
      const fields = { operationId: prepared.operationId, "x-opencode-extension-token": prepared.token }
      if (prepared.kind === "install")
        return result(() => client.install({ ...fields, enable: input.enable ?? false }, noRedirect))
      if (prepared.kind === "update") return result(() => client.update({ ...fields, id: prepared.id }, noRedirect))
      return result(() => client.uninstall({ ...fields, id: prepared.id }, noRedirect))
    },
    async status(prepared: PreparedInstallation) {
      return result(() =>
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
