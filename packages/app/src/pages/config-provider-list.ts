import type { Config, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { providerDisplaySdk } from "./config-provider-display"

const builtinProviders = [
  "opencode",
  "opencode-go",
  "commandcode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
] as const

const builtinProviderNames: Record<(typeof builtinProviders)[number], string> = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  commandcode: "Command Code",
  anthropic: "Anthropic",
  "github-copilot": "GitHub Copilot",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  vercel: "Vercel",
}

export type ProviderSource = "env" | "api" | "config" | "custom"

export type ConfigProviderItem = {
  id: string
  name: string
  connected: boolean
  allowed: boolean
  custom: boolean
  source?: ProviderSource
  sdk?: string
  key?: string
  env?: string[]
  models: string[]
}

type ProviderCfg = NonNullable<Config["provider"]>[string]
type ListedProvider = ProviderListResponse["all"][number]

const builtinProviderSet = new Set<string>(builtinProviders)

export function isBuiltinProvider(id: string) {
  return builtinProviderSet.has(id)
}

export function providerEnabled(item?: Pick<ConfigProviderItem, "custom" | "connected" | "allowed">) {
  if (!item) return false
  return item.custom ? item.allowed : item.connected
}

export function canSignOutProvider(item?: Pick<ConfigProviderItem, "custom" | "source" | "connected" | "allowed">) {
  if (!item || item.custom) return false
  if (item.source === "env") return false
  return item.connected || !item.allowed
}

export function nextDisabledProviders(prev: readonly string[], id: string, enabled: boolean) {
  return enabled ? prev.filter((item) => item !== id) : Array.from(new Set([...prev, id]))
}

export function collectConfigProviders(input: {
  all: readonly ListedProvider[]
  connected: readonly string[]
  disabled: readonly string[]
  configProviders: Config["provider"]
}): ConfigProviderItem[] {
  const off = new Set(input.disabled)
  const on = new Set(input.connected)
  const entries = input.configProviders ?? {}
  const list = input.all.map((item) => {
    const source: ConfigProviderItem["source"] =
      "source" in item &&
      (item.source === "env" || item.source === "api" || item.source === "config" || item.source === "custom")
        ? item.source
        : undefined
    const cfgItem = entries[item.id] as ProviderCfg | undefined
    const display = providerDisplaySdk({ config: cfgItem, models: item.models })
    const models = Object.keys(item.models ?? {})
    return {
      id: item.id,
      name: item.name,
      connected: on.has(item.id),
      allowed: !off.has(item.id),
      custom: display.custom && !isBuiltinProvider(item.id),
      source,
      sdk: display.sdk,
      key: "key" in item && typeof item.key === "string" ? item.key : undefined,
      env: Array.isArray(item.env) ? item.env : cfgItem?.env,
      models: (models.length > 0 ? models : Object.keys(cfgItem?.models ?? {})).sort(),
    }
  })
  const known = new Set(list.map((item) => item.id))
  const extra = Object.entries(entries)
    .filter(([, item]) => typeof item?.npm === "string")
    .filter(([id]) => !known.has(id))
    .map(([id, item]) => ({
      id,
      name: item?.name ?? id,
      connected: false,
      allowed: !off.has(id),
      custom: !isBuiltinProvider(id) && !!item?.npm?.startsWith("@ai-sdk/"),
      source: "config" as const,
      sdk: item?.npm,
      key: undefined,
      env: item?.env,
      models: Object.keys(item?.models ?? {}).sort(),
    }))
  const merged = [...list, ...extra]
  const present = new Set(merged.map((item) => item.id))
  for (const id of builtinProviders) {
    if (present.has(id)) continue
    merged.push({
      id,
      name: builtinProviderNames[id],
      connected: on.has(id),
      allowed: !off.has(id),
      custom: false,
      source: "config",
      models: Object.keys(entries[id]?.models ?? {}).sort(),
    })
  }
  return merged.sort((a, b) => a.id.localeCompare(b.id))
}
