import type { ExtensionInfo as SdkExtensionInfo } from "@opencode-ai/sdk/v2/client"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { ExtensionInfo } from "./types"

export type ExtensionApi = {
  list(): Promise<ExtensionInfo[]>
}

function normalizeAssetURL(value: string, serverURL: string) {
  const server = new URL(serverURL)
  const url = new URL(value, server)
  if (url.origin !== server.origin) throw new Error(`Extension asset origin does not match server: ${url.origin}`)
  return url.toString()
}

function normalize(input: SdkExtensionInfo, serverURL: string): ExtensionInfo {
  return {
    ...input,
    web: input.web
      ? {
          ...input.web,
          base: normalizeAssetURL(input.web.base, serverURL),
          styles: input.web.styles.map((style) => normalizeAssetURL(style, serverURL)),
        }
      : undefined,
  }
}

export function createExtensionApi(input: { globalSDK: ReturnType<typeof useGlobalSDK> }): ExtensionApi {
  return {
    async list() {
      const serverURL = input.globalSDK.url
      const client = input.globalSDK.client
      const result = await client.extension.list()
      if (!Array.isArray(result.data)) throw new Error("Extension manifest response is unavailable")
      return result.data.map((item) => normalize(item, serverURL))
    },
  }
}
