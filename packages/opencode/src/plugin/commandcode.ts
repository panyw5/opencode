import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Config, Hooks, Plugin } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import {
  COMMANDCODE_API_BASE,
  COMMANDCODE_MAX_OUTPUT_TOKENS,
  COMMANDCODE_PACKAGE,
  COMMANDCODE_PROVIDER_ID,
  type CommandCodeModelEntry,
} from "../provider/commandcode"

const log = Log.create({ service: "plugin.commandcode" })

const FALLBACK_MODELS: Array<[string, string, number]> = [
  ["claude-sonnet-5", "Claude Sonnet 5", 1_000_000],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000],
  ["claude-fable-5", "Claude Fable 5", 1_000_000],
  ["claude-opus-5", "Claude Opus 5", 1_000_000],
  ["claude-opus-4-8", "Claude Opus 4.8", 1_000_000],
  ["claude-opus-4-7", "Claude Opus 4.7", 1_000_000],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1_050_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1_050_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1_050_000],
  ["gpt-5.5", "GPT-5.5", 200_000],
  ["gpt-5.4", "GPT-5.4", 400_000],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 400_000],
  ["gpt-5.4-mini", "GPT-5.4 Mini", 400_000],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000],
  ["moonshotai/Kimi-K3", "Kimi K3", 1_000_000],
  ["moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256_000],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262_000],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6", 256_000],
  ["moonshotai/Kimi-K2.5", "Kimi K2.5", 256_000],
  ["zai-org/GLM-5.3", "GLM-5.3", 1_000_000],
  ["zai-org/GLM-5.2", "GLM-5.2", 1_000_000],
  ["zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1_000_000],
  ["zai-org/GLM-5.1", "GLM-5.1", 200_000],
  ["zai-org/GLM-5", "GLM-5", 200_000],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3", 1_000_000],
  ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200_000],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200_000],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000],
  ["xiaomi/mimo-v2.5", "MiMo V2.5", 1_000_000],
  ["Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1_000_000],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1_000_000],
  ["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1_000_000],
  ["Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1_000_000],
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200_000],
  ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200_000],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256_000],
  ["stepfun/Step-3.5-Flash", "Step 3.5 Flash", 1_000_000],
  ["tencent/hy3-paid", "Tencent Hy3", 262_144],
  ["google/gemini-3.7-flash", "Gemini 3.7 Flash", 1_048_576],
  ["google/gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1_000_000],
  ["sakana/fugu-ultra", "Fugu Ultra", 1_000_000],
  ["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1_000_000],
  ["thinkingmachines/inkling", "Inkling", 256_000],
  ["thinkingmachines/inkling-small", "Inkling Small", 1_000_000],
  ["poolside/laguna-s-2.1-free", "Laguna S 2.1", 256_000],
  ["meta/muse-spark-1.1", "Muse Spark 1.1", 1_048_576],
  ["meta/muse-spark-1.2", "Muse Spark 1.2", 1_048_576],
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1_048_576],
  ["xai/grok-4.5", "Grok 4.5", 500_000],
  ["xai/grok-4.6", "Grok 4.6", 500_000],
]

const REASONING_MODELS = new Set([
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "Qwen/Qwen3.8-Max",
  "google/gemini-3.7-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "xai/grok-4.5",
  "xai/grok-4.6",
])

function fallbackCatalog(): CommandCodeModelEntry[] {
  return FALLBACK_MODELS.map(([id, name, contextLength]) => ({ id, name, contextLength }))
}

export function commandCodeFallbackModelsDevProvider() {
  return {
    id: COMMANDCODE_PROVIDER_ID,
    name: "Command Code",
    env: ["COMMANDCODE_API_KEY"],
    npm: COMMANDCODE_PACKAGE,
    api: COMMANDCODE_API_BASE,
    models: Object.fromEntries(
      FALLBACK_MODELS.map(([id, name, contextLength]) => [
        id,
        {
          id,
          name,
          release_date: "",
          attachment: false,
          reasoning: REASONING_MODELS.has(id),
          temperature: true,
          tool_call: true,
          limit: {
            context: contextLength,
            output: Math.min(contextLength, COMMANDCODE_MAX_OUTPUT_TOKENS),
          },
          modalities: { input: ["text"] as const, output: ["text"] as const },
        },
      ]),
    ),
  }
}

async function fetchCatalog(): Promise<CommandCodeModelEntry[]> {
  try {
    const response = await fetch(`${COMMANDCODE_API_BASE}/provider/v1/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
      throw new Error("unexpected model catalog shape")
    }
    const models = (value as { data: unknown[] }).data.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const data = item as Record<string, unknown>
      if (typeof data.id !== "string" || typeof data.name !== "string" || typeof data.context_length !== "number")
        return []
      return [{ id: data.id, name: data.name, contextLength: data.context_length }]
    })
    if (models.length === 0) throw new Error("empty model catalog")
    log.info("loaded Command Code model catalog", { count: models.length })
    return models
  } catch (error) {
    log.warn("using Command Code fallback model catalog", {
      error: error instanceof Error ? error.message : String(error),
    })
    return fallbackCatalog()
  }
}

export function readCommandCodeAuthFile(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8")) as Record<
      string,
      unknown
    >
    return typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey : undefined
  } catch {
    return undefined
  }
}

export function resolveCommandCodeRuntimeAuth(input: {
  stored?: { type?: string; key?: string }
  envKey?: string
}): { key?: string; source?: "auth" | "env" } {
  if (input.stored?.type === "api" && input.stored.key?.trim()) {
    return { key: input.stored.key, source: "auth" }
  }
  if (input.envKey?.trim()) return { key: input.envKey, source: "env" }
  return {}
}

function modelConfig(model: CommandCodeModelEntry) {
  const reasoning = REASONING_MODELS.has(model.id)
  return {
    id: model.id,
    name: model.name,
    reasoning,
    temperature: true,
    tool_call: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: model.contextLength, output: Math.min(model.contextLength, COMMANDCODE_MAX_OUTPUT_TOKENS) },
    variants: reasoning
      ? Object.fromEntries(
          ["low", "medium", "high", "xhigh", "max"].map((effort) => [effort, { reasoningEffort: effort }]),
        )
      : {},
  }
}

async function configureProvider(config: Config) {
  const target = config as Config & { provider?: Record<string, any> }
  target.provider ??= {}
  const current = target.provider[COMMANDCODE_PROVIDER_ID] ?? {}

  const catalog = await fetchCatalog()
  target.provider[COMMANDCODE_PROVIDER_ID] = {
    ...current,
    name: current.name ?? "Command Code",
    api: current.api ?? COMMANDCODE_API_BASE,
    npm: current.npm ?? COMMANDCODE_PACKAGE,
    env: current.env ?? ["COMMANDCODE_API_KEY"],
    models: Object.fromEntries(catalog.map((model) => [model.id, modelConfig(model)])),
  }
  log.info("configured Command Code provider", { count: catalog.length })
}

export const CommandCodePlugin: Plugin = async () => {
  const hooks: Hooks = {
    auth: {
      provider: COMMANDCODE_PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Command Code API key",
        },
      ],
    },
    config: async (config) => {
      await configureProvider(config)
    },
  }
  return hooks
}

export const commandCodeCustomLoader = (dep: {
  auth: (id: string) => Effect.Effect<{ type?: string; key?: string } | undefined>
  env: () => Effect.Effect<Record<string, string | undefined>>
}) =>
  Effect.fnUntraced(function* () {
    const stored = yield* dep.auth(COMMANDCODE_PROVIDER_ID)
    const env = yield* dep.env()
    const resolved = resolveCommandCodeRuntimeAuth({
      stored,
      envKey: env.COMMANDCODE_API_KEY,
    })
    const fileKey = readCommandCodeAuthFile()
    log.info("resolved Command Code runtime auth", {
      source: resolved.source ?? "none",
      autoload: !!resolved.key,
      hasCliAuthFile: !!fileKey,
    })
    return {
      autoload: !!resolved.key,
      options: resolved.key ? { apiKey: resolved.key } : {},
    }
  })
