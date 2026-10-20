import type { Auth } from "@/auth"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { asSchema, jsonSchema, tool as aiTool, type ModelMessage, type Tool, type ToolResultPart } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import * as Log from "@opencode-ai/core/util/log"
import { Token } from "@/util/token"

const log = Log.create({ service: "session.llm.request" })
const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: MessageV2.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: Permission.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly kind?: "primary" | "compaction"
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

const mediaTokens = (mime: string) => {
  if (mime.toLowerCase().startsWith("image/")) return 1_500
  if (mime.toLowerCase() === "application/pdf") return 2_000
  return 0
}

function outputTokens(output: ToolResultPart["output"]): number {
  if (output.type === "execution-denied") return Token.estimate(output.reason ?? "")
  if (output.type !== "content")
    return Token.estimate(typeof output.value === "string" ? output.value : JSON.stringify(output.value))
  return output.value.reduce((sum, part) => {
    if (part.type === "text") return sum + Token.estimate(part.text)
    if (part.type.startsWith("image-")) return sum + 1_500
    return sum + ("mediaType" in part ? mediaTokens(part.mediaType) : 0)
  }, 0)
}

/** Estimate sendable content, excluding local provider metadata and encoded media bytes, as in V2. */
export function estimateInputTokens(input: {
  messages: ModelMessage[]
  tools: { name: string; description?: string; parameters?: unknown }[]
  system?: string[]
}) {
  const messages = input.messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + Token.estimate(message.content)
    return (
      sum +
      message.content.reduce((total, part) => {
        if (part.type === "text" || part.type === "reasoning") return total + Token.estimate(part.text)
        if (part.type === "image") return total + 1_500
        if (part.type === "file") return total + mediaTokens(part.mediaType)
        if (part.type === "tool-call") return total + Token.estimate(part.toolName + JSON.stringify(part.input))
        if (part.type === "tool-result") return total + outputTokens(part.output)
        return total
      }, 0)
    )
  }, 0)
  return (
    messages +
    (input.system ?? []).reduce((sum, text) => sum + Token.estimate(text), 0) +
    input.tools.reduce(
      (sum, item) =>
        sum + Token.estimate(item.name + (item.description ?? "") + (JSON.stringify(item.parameters) ?? "")),
      0,
    )
  )
}

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const tools = resolveTools(input)
  const definitions = yield* Effect.forEach(Object.entries(tools), ([name, item]) =>
    Effect.gen(function* () {
      const schema = item.inputSchema
        ? yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        : undefined
      return { name, description: item.description, parameters: schema }
    }),
  )
  // Estimate this request, not lifetime session usage. OAuth/workflow instructions travel outside messages.
  const estimatedInputTokens = estimateInputTokens({
    messages,
    tools: definitions,
    ...(isOpenaiOauth || input.isWorkflow ? { system } : {}),
  })
  const kind = input.kind ?? (input.agent.name === "compaction" ? "compaction" : "primary")
  const outputBudget = ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax, {
    kind,
    inputTokens: { measured: 0, estimated: estimatedInputTokens },
  })
  log.info("generation budget calculated", {
    sessionID: input.sessionID,
    modelID: input.model.id,
    kind,
    modelOutputLimit: input.model.limit.output,
    contextLimit: input.model.limit.context,
    estimatedInputTokens,
    outputTokenMax: input.flags.outputTokenMax,
    maxOutputTokens: outputBudget,
  })

  const triggeredParams = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: outputBudget,
      options,
    },
  )
  const params = {
    ...triggeredParams,
    // Some protocol adapters must omit this field (e.g. Cloudflare's OpenAI reasoning route).
    maxOutputTokens:
      triggeredParams.maxOutputTokens === undefined
        ? undefined
        : Math.min(outputBudget, triggeredParams.maxOutputTokens),
    options: { ...triggeredParams.options },
  }
  log.info("generation budget finalized", {
    sessionID: input.sessionID,
    kind,
    requestedMaxOutputTokens: triggeredParams.maxOutputTokens,
    maxOutputTokens: params.maxOutputTokens,
  })
  if (input.provider.options?.setCacheKey === false) {
    delete params.options.promptCacheKey
    delete params.options.prompt_cache_key
  }
  const cacheKeyField =
    params.options.promptCacheKey !== undefined
      ? "promptCacheKey"
      : params.options.prompt_cache_key !== undefined
        ? "prompt_cache_key"
        : "none"
  log.info(`prompt cache key prepared field=${cacheKeyField}`)

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
