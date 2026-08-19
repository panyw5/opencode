import type { AssistantMessage, Message, Session, UserMessage } from "@opencode-ai/sdk/v2/client"
import { findLimitReference } from "@opencode-ai/core/limit-reference"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
  limitSource?: string
}

type Context = {
  message?: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  limitSource?: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
}

type Metrics = {
  totalCost: number
  context: Context | undefined
}

type SessionLike = Pick<Session, "model"> | { model?: { id?: string; providerID?: string } } | undefined

const emptyTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
}

const tokenComponents = (msg: AssistantMessage) => {
  const tokens = msg.tokens
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
  }
}

const tokenTotal = (msg: AssistantMessage) => {
  const reported = msg.tokens?.total
  if (typeof reported === "number" && reported > 0) return reported
  const parts = tokenComponents(msg)
  return parts.input + parts.output + parts.reasoning + parts.cacheRead + parts.cacheWrite
}

const lastAssistant = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant") return msg
  }
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && tokenTotal(msg) > 0) return msg
  }
}

const lastUser = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") return msg as UserMessage
  }
}

const resolveIdentity = (messages: Message[], session?: SessionLike) => {
  const assistant = lastAssistantWithTokens(messages) ?? lastAssistant(messages)
  if (assistant) {
    return {
      message: assistant,
      providerID: assistant.providerID,
      modelID: assistant.modelID,
    }
  }
  const user = lastUser(messages)
  if (user?.model) {
    return {
      providerID: user.model.providerID,
      modelID: user.model.modelID,
    }
  }
  if (session?.model?.providerID && session.model.id) {
    return {
      providerID: session.model.providerID,
      modelID: session.model.id,
    }
  }
}

const resolveLimit = (model: Model | undefined, modelID: string | undefined, providers: Provider[]) => {
  const declared = model?.limit.context
  if (declared) {
    return {
      limit: declared,
      limitSource: model?.limitSource,
    }
  }
  if (!modelID) return { limit: declared }
  const referenced = findLimitReference(modelID, providers)
  if (!referenced) return { limit: declared }
  return {
    limit: referenced.context,
    limitSource: referenced.source,
  }
}

const build = (messages: Message[] = [], providers: Provider[] = [], session?: SessionLike): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const identity = resolveIdentity(messages, session)
  if (!identity) return { totalCost, context: undefined }

  const provider = providers.find((item) => item.id === identity.providerID)
  const model = identity.modelID ? provider?.models[identity.modelID] : undefined
  const resolved = resolveLimit(model, identity.modelID, providers)
  const tokens = identity.message
    ? {
        ...tokenComponents(identity.message),
        total: tokenTotal(identity.message),
      }
    : emptyTokens

  return {
    totalCost,
    context: {
      message: identity.message,
      provider,
      model,
      providerLabel: provider?.name ?? identity.providerID,
      modelLabel: model?.name ?? identity.modelID,
      limit: resolved.limit,
      limitSource: resolved.limitSource,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      total: tokens.total,
      usage: resolved.limit ? Math.round((tokens.total / resolved.limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(
  messages: Message[] = [],
  providers: Provider[] = [],
  session?: SessionLike,
) {
  return build(messages, providers, session)
}
