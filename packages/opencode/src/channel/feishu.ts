import * as Lark from "@larksuiteoapi/node-sdk"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import * as ServerAuth from "@/server/auth"
import {
  FeishuTaskCard,
  finalTextFromMessages,
  stepsFromMessages,
  type MessageRowLike,
} from "./feishu-card"
import { loadMap, mappedEntry, resolveMappedSession, saveMap, sessionKey, titlePrefix } from "./mapping"

export type FeishuChannelConfig = {
  type: "feishu"
  appId: string
  appSecret: string
  allowedUsers?: string[]
  enabled?: boolean
  domain?: "feishu" | "lark"
  model?: string
  /** Working directory for this channel's sessions (decoupled from projects). */
  directory?: string
}

const log = Log.create({ service: "channel.feishu" })

/** Max remembered Feishu message_ids (at-least-once redelivery guard). */
const SEEN_MESSAGE_LIMIT = 2000

export type FeishuRuntimeOptions = {
  name: string
  config: FeishuChannelConfig
  baseUrl: string
  directory: string
}

type StopHandle = {
  stop: () => void
}

function resolveDomain(domain: FeishuChannelConfig["domain"]): Lark.Domain | string {
  if (domain === "lark") return Lark.Domain.Lark
  return Lark.Domain.Feishu
}

function extractText(content: string, messageType: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (messageType === "text" && typeof parsed.text === "string") return parsed.text
    if (messageType === "post") {
      // Flatten post content blocks to plain text (best-effort)
      const parts: string[] = []
      const walk = (node: unknown) => {
        if (!node) return
        if (typeof node === "string") {
          parts.push(node)
          return
        }
        if (Array.isArray(node)) {
          for (const item of node) walk(item)
          return
        }
        if (typeof node === "object") {
          const obj = node as Record<string, unknown>
          if (typeof obj.text === "string") parts.push(obj.text)
          if (obj.content) walk(obj.content)
          for (const value of Object.values(obj)) {
            if (value && typeof value === "object") walk(value)
          }
        }
      }
      walk(parsed)
      const text = parts.join("").trim()
      return text || undefined
    }
  } catch {
    // ignore
  }
  return undefined
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model?.trim()) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function allowed(openId: string | undefined, allowedUsers: string[] | undefined): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return true
  if (allowedUsers.includes("*")) return true
  if (!openId) return false
  return allowedUsers.includes(openId)
}

/**
 * In-process dedupe for Feishu message_id (at-least-once delivery).
 * claim() returns false if this id was already claimed/processed.
 */
function createMessageDedupe(limit = SEEN_MESSAGE_LIMIT) {
  const order: string[] = []
  const seen = new Set<string>()

  return {
    claim(id: string): boolean {
      if (seen.has(id)) return false
      seen.add(id)
      order.push(id)
      while (order.length > limit) {
        const old = order.shift()
        if (old) seen.delete(old)
      }
      return true
    },
    has(id: string): boolean {
      return seen.has(id)
    },
  }
}

/**
 * Serialize async work per chat so concurrent event redeliveries cannot
 * run multiple prompts/replies for the same conversation at once.
 */
function createChatQueue() {
  const tails = new Map<string, Promise<void>>()

  return {
    enqueue(key: string, task: () => Promise<void>): Promise<void> {
      const prev = tails.get(key) ?? Promise.resolve()
      const next = prev.then(task, task).finally(() => {
        if (tails.get(key) === next) tails.delete(key)
      })
      tails.set(key, next)
      return next
    },
  }
}

export function startFeishuChannel(opts: FeishuRuntimeOptions): StopHandle {
  const { name, config, baseUrl, directory } = opts
  const domain = resolveDomain(config.domain)
  let stopped = false
  const dedupe = createMessageDedupe()
  const chatQueue = createChatQueue()

  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  })

  // Desktop server requires Basic auth (OPENCODE_SERVER_PASSWORD). Without this,
  // session.create/prompt return empty 401 bodies and Feishu never gets a reply.
  // Prefer process.env at call time (Flag is snapshotted at import and may be empty).
  const authHeaders =
    ServerAuth.headers({
      username: process.env["OPENCODE_SERVER_USERNAME"] || "opencode",
      password: process.env["OPENCODE_SERVER_PASSWORD"] || undefined,
    }) ?? ServerAuth.headers()
  const sdk: OpencodeClient = createOpencodeClient({
    baseUrl,
    directory,
    ...(authHeaders ? { headers: authHeaders } : {}),
  })

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      if (stopped) return
      const event = data as FeishuMessageEvent
      const messageId = event.message?.message_id
      const chatId = event.message?.chat_id

      // Drop exact redeliveries immediately (before any async work).
      if (messageId) {
        if (!dedupe.claim(messageId)) {
          log.info("feishu duplicate message ignored", { channel: name, messageId })
          return
        }
      }

      const queueKey = chatId ? `${name}::${chatId}` : `${name}::unknown`
      try {
        await chatQueue.enqueue(queueKey, async () => {
          if (stopped) return
          await handleMessage({
            name,
            config,
            client,
            sdk,
            directory,
            data: event,
          })
        })
      } catch (err) {
        log.error("feishu message handler failed", {
          channel: name,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  })

  const ws = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  })

  void ws.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
    log.error("feishu websocket failed to start", { channel: name, error: err })
  })

  log.info("feishu channel started", {
    channel: name,
    domain: config.domain ?? "feishu",
    directory,
    baseUrl,
    hasAuth: !!authHeaders,
  })

  return {
    stop: () => {
      stopped = true
      try {
        // WSClient has no stable public stop in all SDK versions — best-effort.
        const anyWs = ws as unknown as { close?: () => void; stop?: () => void }
        anyWs.close?.()
        anyWs.stop?.()
      } catch (err) {
        log.warn("feishu websocket stop error", { channel: name, error: err })
      }
      log.info("feishu channel stopped", { channel: name })
    },
  }
}

type FeishuMessageEvent = {
  message?: {
    chat_id?: string
    message_id?: string
    message_type?: string
    content?: string
    chat_type?: string
    thread_id?: string
    root_id?: string
  }
  sender?: {
    sender_id?: {
      open_id?: string
      user_id?: string
    }
    sender_type?: string
  }
}

function formatClientError(error: unknown): string {
  if (error == null) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    const text = JSON.stringify(error)
    return text === "{}" ? "empty error body (often HTTP 401 — check server auth)" : text
  } catch {
    return String(error)
  }
}

async function handleMessage(input: {
  name: string
  config: FeishuChannelConfig
  client: Lark.Client
  sdk: OpencodeClient
  directory: string
  data: FeishuMessageEvent
}) {
  const msg = input.data.message
  const sender = input.data.sender
  if (!msg?.chat_id || !msg.content || !msg.message_type) return
  // Bot / app messages must never re-enter the handler (reply loop).
  if (sender?.sender_type === "app") return

  const openId = sender?.sender_id?.open_id
  if (!allowed(openId, input.config.allowedUsers)) {
    log.info("feishu message ignored by ACL", { channel: input.name, openId })
    return
  }

  const text = extractText(msg.content, msg.message_type)
  if (!text?.trim()) {
    log.info("feishu non-text message ignored", { channel: input.name, type: msg.message_type })
    return
  }

  const messageId = msg.message_id
  log.info("feishu message received", {
    channel: input.name,
    messageId,
    chatId: msg.chat_id,
    type: msg.message_type,
    textLen: text.length,
    directory: input.directory,
  })

  const chatId = msg.chat_id
  const threadId = msg.thread_id || msg.root_id
  const key = sessionKey({ channelName: input.name, chatId, threadId })

  const map = await loadMap()
  let sessionId = resolveMappedSession(map.sessions[key], input.directory)

  if (!sessionId) {
    const title = `${titlePrefix(input.name)} ${chatId.slice(0, 12)}`
    const created = await input.sdk.session.create({ title })
    if (created.error || !created.data?.id) {
      const detail = formatClientError(created.error)
      log.error("failed to create session for feishu message", {
        channel: input.name,
        messageId,
        error: detail,
      })
      await replyText(input.client, chatId, `抱歉，创建会话失败：${detail}`, messageId)
      return
    }
    sessionId = created.data.id
    map.sessions[key] = mappedEntry(sessionId, input.directory)
    await saveMap(map)
    log.info("created session for feishu chat", {
      channel: input.name,
      sessionId,
      chatId,
      messageId,
      directory: input.directory,
    })
  }

  // Progressive Feishu task card (GenericAgent-style): collapsible turns + final answer.
  const card = new FeishuTaskCard({
    client: input.client,
    chatId,
    replyTo: messageId,
  })
  await card.start()

  const poll = startStepPoller({
    sdk: input.sdk,
    sessionId,
    card,
  })

  const model = parseModel(input.config.model)
  // IM has no desktop UI for interactive tools. `question` otherwise hangs the
  // prompt forever and Feishu never receives a reply (observed in production).
  // Do NOT abort here: abort-on-every-message + event redelivery caused multi-replies.
  let result: Awaited<ReturnType<OpencodeClient["session"]["prompt"]>>
  try {
    result = await input.sdk.session.prompt({
      sessionID: sessionId,
      parts: [{ type: "text", text }],
      tools: {
        question: false,
      },
      ...(model ? { model } : {}),
    })
  } catch (err) {
    poll.stop()
    const detail = err instanceof Error ? err.message : String(err)
    log.error("feishu prompt threw", { channel: input.name, sessionId, messageId, error: detail })
    await card.fail(`处理消息时出错了：${detail}`)
    return
  }

  poll.stop()
  // Final snapshot after prompt returns (ensure last step is visible).
  await poll.flush()

  if (result.error) {
    const detail = formatClientError(result.error)
    log.error("feishu prompt failed", {
      channel: input.name,
      sessionId,
      messageId,
      error: detail,
    })
    await card.fail(`处理消息时出错了：${detail}`)
    return
  }

  // session.prompt returns only the *final* assistant message. Aggregate all
  // assistant text parts in this turn for the card's final section.
  const reply =
    (await collectTurnAssistantText(input.sdk, sessionId)) || extractAssistantText(result.data)
  if (reply.trim()) {
    await card.done(reply)
    log.info("feishu reply card done", {
      channel: input.name,
      sessionId,
      messageId,
      replyLen: reply.length,
      cardMessageId: card.messageId,
    })
  } else {
    log.warn("feishu prompt returned empty reply", {
      channel: input.name,
      sessionId,
      messageId,
    })
    await card.done("（模型没有返回文本内容）")
  }
}

/** Poll session messages while prompt runs; push new turns to the Feishu card. */
function startStepPoller(input: {
  sdk: OpencodeClient
  sessionId: string
  card: FeishuTaskCard
  intervalMs?: number
}) {
  let stopped = false
  let inflight: Promise<void> | undefined
  const intervalMs = input.intervalMs ?? 1200

  const tick = async () => {
    if (stopped) return
    try {
      const rows = await loadSessionMessages(input.sdk, input.sessionId)
      if (stopped || !rows.length) return
      const steps = stepsFromMessages(rows)
      if (steps.length) await input.card.syncSteps(steps)
    } catch (err) {
      log.warn("feishu step poll failed", {
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    if (inflight) return
    inflight = tick().finally(() => {
      inflight = undefined
    })
  }, intervalMs)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    async flush() {
      await (inflight ?? Promise.resolve())
      await tick()
    },
  }
}

async function loadSessionMessages(sdk: OpencodeClient, sessionId: string): Promise<MessageRowLike[]> {
  const listed = await sdk.session.messages({ sessionID: sessionId, limit: 50 })
  if (listed.error || !listed.data) return []
  return normalizeMessageList(listed.data) as MessageRowLike[]
}

/** Pull plain text from a session.prompt response (assistant message + parts). */
function extractAssistantText(data: unknown): string {
  if (!data || typeof data !== "object") return ""
  const obj = data as {
    info?: { content?: string; role?: string; role_?: string }
    parts?: Array<{ type?: string; text?: string; content?: string }>
    role?: string
    content?: string
  }
  if (typeof obj.info?.content === "string" && obj.info.content.trim()) return obj.info.content
  if (typeof obj.content === "string" && obj.content.trim()) return obj.content
  const parts = obj.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && (typeof p.text === "string" || typeof p.content === "string"))
    .map((p) => (typeof p.text === "string" ? p.text : p.content) || "")
    .join("\n")
    .trim()
}

type MessageRow = {
  info?: { role?: string; id?: string }
  role?: string
  parts?: Array<{ type?: string; text?: string; content?: string }>
}

/**
 * Aggregate every assistant text part after the most recent user message.
 * This captures intermediate step output that session.prompt does not return.
 */
async function collectTurnAssistantText(sdk: OpencodeClient, sessionId: string): Promise<string> {
  try {
    const rows = await loadSessionMessages(sdk, sessionId)
    if (!rows.length) return ""
    return finalTextFromMessages(rows)
  } catch (err) {
    log.warn("feishu collectTurnAssistantText failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return ""
  }
}

function normalizeMessageList(data: unknown): MessageRow[] {
  if (Array.isArray(data)) return data as MessageRow[]
  if (data && typeof data === "object") {
    const obj = data as { data?: unknown; items?: unknown; messages?: unknown }
    if (Array.isArray(obj.data)) return obj.data as MessageRow[]
    if (Array.isArray(obj.items)) return obj.items as MessageRow[]
    if (Array.isArray(obj.messages)) return obj.messages as MessageRow[]
  }
  return []
}

async function replyText(client: Lark.Client, chatId: string, text: string, replyTo?: string) {
  // Feishu text messages are capped; keep a safe margin.
  const maxLen = 4000
  const body = text.length > maxLen ? `${text.slice(0, maxLen - 20)}\n…(已截断)` : text
  const content = JSON.stringify({ text: body })
  try {
    if (replyTo) {
      await client.im.message.reply({
        path: { message_id: replyTo },
        data: {
          content,
          msg_type: "text",
        },
      })
      return
    }
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content,
        msg_type: "text",
      },
    })
  } catch (err) {
    log.error("feishu reply failed", {
      chatId,
      replyTo,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Exported for unit tests. */
export const __test = {
  createMessageDedupe,
  createChatQueue,
  extractAssistantText,
  extractText,
  parseModel,
  normalizeMessageList,
  /** Aggregate assistant text parts after the last user message (same logic as collectTurn). */
  aggregateTurnText(rows: MessageRow[]): string {
    return finalTextFromMessages(rows as MessageRowLike[])
  },
}