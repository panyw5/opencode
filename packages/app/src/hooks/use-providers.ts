import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import type { Config } from "@opencode-ai/sdk/v2/client"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "commandcode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

function providerOrderFromConfig(config: Config | undefined) {
  return Object.keys(config?.provider ?? {})
}

function providerAccessors(
  providers: () => ReturnType<typeof useGlobalSync>["data"]["provider"],
  config: () => Config | undefined,
) {
  return {
    data: providers,
    all: () => providers().all,
    default: () => providers().default,
    order: () => providerOrderFromConfig(config()),
    popular: () => {
      const disabled = new Set(config()?.disabled_providers ?? [])
      return providers().all.filter((p) => popularProviderSet.has(p.id) && !disabled.has(p.id))
    },
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) => connected.has(p.id) && (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider.all.length > 0) return projectStore.provider
    }
    return globalSync.data.provider
  }
  const config = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (Object.keys(projectStore.config).length > 0) return projectStore.config
    }
    return globalSync.data.config
  }
  return providerAccessors(providers, config)
}
