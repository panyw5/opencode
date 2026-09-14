import * as Lark from "@larksuiteoapi/node-sdk"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import * as ServerAuth from "@/server/auth"
import { runtime as imRuntime } from "@/im/service"
import { messageRecordID, NormalizedMessage, Target, type IMTransport } from "@/im/model"
import { ProviderRejectedError, transportCapabilities } from "@/im/transport"
import { AppRuntime } from "@/effect/app-runtime"
import { dispatchMessage } from "@/im/dispatcher"
import { IMOwner } from "@/im/owner"
import { FeishuTaskCard, finalTextFromMessages, stepsFromMessages, type MessageRowLike } from "./feishu-card"
import { loadMap, mappedEntry, resolveMappedSession, saveMap, sessionKey, titlePrefix } from "./mapping"

export type FeishuChannelConfig = {
  type: "feishu"
  appId: string
  appSecret: string
  allowedUsers?: string[]
  enabled?: boolean
  autoReply?: boolean
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

export type FeishuChannelHandle = {
  stop: () => void
  transport: IMTransport
}

export function createFeishuTransport(input: { name: string; client: Lark.Client }): IMTransport {
  return {
    platform: "feishu",
    channelName: input.name,
    capabilities: transportCapabilities("feishu"),
    sendText: async (message) => {
      const maxLen = 4000
      if (message.mode === "reply" && !message.target.replyTo)
        throw new Error("Feishu replies require an inbound message ID")
      if (message.text.length > maxLen) throw new Error(`Feishu text exceeds ${maxLen} characters`)
      const content = JSON.stringify({ text: message.text })
      const response = await Promise.resolve()
        .then(() =>
          message.mode === "reply"
            ? input.client.im.message.reply({
                path: { message_id: message.target.replyTo! },
                data: { content, msg_type: "text" },
              })
            : input.client.im.message.create({
                params: { receive_id_type: "chat_id" },
                data: { receive_id: message.target.conversationID, content, msg_type: "text" },
              }),
        )
        .catch((error: unknown) => {
          const status =
            error && typeof error === "object"
              ? (error as { response?: { status?: number } }).response?.status
              : undefined
          if (status && status >= 400 && status < 500) throw new ProviderRejectedError("feishu", status)
          throw error
        })
      assertSuccess(response)
      return { providerMessageID: extractMessageID(response), timeSent: Date.now() }
    },
  }
}

function resolveDomain(domain: FeishuChannelConfig["domain"]): Lark.Domain | string {
  if (domain === "lark") return Lark.Domain.Lark
  return Lark.Domain.Feishu
}

function extractMessageID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as { message_id?: unknown; data?: { message_id?: unknown; data?: { message_id?: unknown } } }
  if (typeof item.message_id === "string") return item.message_id
  if (typeof item.data?.message_id === "string") return item.data.message_id
  if (typeof item.data?.data?.message_id === "string") return item.data.data.message_id
  return undefined
}

function assertSuccess(value: unknown) {
  if (!value || typeof value !== "object") return
  const code = (value as { code?: unknown }).code
  if (typeof code === "number" && code !== 0) throw new ProviderRejectedError("feishu", undefined, code)
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

export function startFeishuChannel(opts: FeishuRuntimeOptions): FeishuChannelHandle {
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

  const transport = createFeishuTransport({ name, client })

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
          if (messageId) {
            await imRuntime.runPromise((service) =>
              service.markLegacyCompleted(messageRecordID("feishu", name, messageId)),
            )
          }
        })
      } catch (err) {
        if (messageId)
          await imRuntime.runPromise((service) =>
            service.markLegacyStatus(messageRecordID("feishu", name, messageId), "unknown"),
          )
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
    transport,
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

export function isSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { name?: unknown; _tag?: unknown; data?: unknown }
  if (value.name === "NotFoundError" || value._tag === "SessionNotFoundError") return true
  if (!value.data || typeof value.data !== "object") return false
  const message = (value.data as { message?: unknown }).message
  return typeof message === "string" && message.startsWith("Session not found:")
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

  if (!messageId) {
    log.warn("feishu inbound persistence skipped without event id", { channel: input.name, chatId: msg.chat_id })
  } else {
    try {
      const stored = await imRuntime.runPromise((service) =>
        service.ingest({
          message: new NormalizedMessage({
            id: messageRecordID("feishu", input.name, messageId),
            platform: "feishu",
            channelName: input.name,
            eventID: messageId,
            target: new Target({
              platform: "feishu",
              channelName: input.name,
              scope: "chat",
              conversationID: msg.chat_id!,
              ...(openId ? { senderID: openId } : {}),
              ...(messageId ? { replyTo: messageId } : {}),
            }),
            ...(openId ? { senderID: openId } : {}),
            text,
            metadata: {
              messageType: msg.message_type,
              chatType: msg.chat_type,
              threadID: msg.thread_id,
              rootID: msg.root_id,
              appIdentity: IMOwner.appIdentity(input.config),
            },
          }),
        }),
      )
      await IMOwner.runtime.runPromise((service) =>
        service.observe(new NormalizedMessage({ ...stored.message }), input.config),
      )
      if (stored.expired) {
        log.info("feishu expired message ignored", { channel: input.name, messageId })
        return
      }
      if (stored.inserted)
        await imRuntime.runPromise((service) => service.markLegacyStatus(stored.message.id, "processing"))
      let shouldDispatch = stored.inserted
      if (!stored.inserted) {
        shouldDispatch = false
        log.info("feishu durable duplicate message ignored", { channel: input.name, messageId })
        let matched = 0
        try {
          const routed = await dispatchMessage(stored.message)
          matched = routed.matched
          log.info("feishu duplicate replay dispatched", { channel: input.name, messageId, matched: routed.matched })
        } catch (error) {
          log.error("feishu duplicate replay dispatch failed", {
            channel: input.name,
            messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          await imRuntime.runPromise((service) => service.markLegacyStatus(stored.message.id, "unknown"))
          return
        }
        if (matched > 0 || stored.message.legacyStatus === "completed") return
        if (await imRuntime.runPromise((service) => service.hasSubscriptionDelivery(stored.message.id))) return
        if (!(await imRuntime.runPromise((service) => service.claimLegacyProcessing(stored.message.id)))) return
      }
      if (shouldDispatch)
        try {
          const routed = await dispatchMessage(stored.message)
          if (routed.matched > 0) {
            log.info("feishu message routed to project subscriptions", {
              channel: input.name,
              messageId,
              matched: routed.matched,
              admitted: routed.admitted,
            })
            return
          }
        } catch (error) {
          log.error("feishu subscription dispatch failed; legacy reply suppressed", {
            channel: input.name,
            messageId,
            error: error instanceof Error ? error.message : String(error),
          })
          await imRuntime.runPromise((service) => service.markLegacyStatus(stored.message.id, "unknown"))
          return
        }
      if (input.config.autoReply === false) {
        log.info("feishu legacy auto reply disabled", { channel: input.name, messageId })
        return
      }
    } catch (err) {
      // Persistence must not disable the established channel reply path. The
      // error is explicit so operators can detect a degraded inbox.
      log.error("feishu inbound persistence failed", {
        channel: input.name,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (input.config.autoReply === false) {
    log.info("feishu legacy auto reply disabled after persistence path", { channel: input.name, messageId })
    return
  }

  const chatId = msg.chat_id
  const threadId = msg.thread_id || msg.root_id
  const key = sessionKey({ channelName: input.name, chatId, threadId })

  const map = await loadMap()
  let sessionId = resolveMappedSession(map.sessions[key], input.directory)
  log.info("loaded feishu session mapping", {
    channel: input.name,
    messageId,
    key,
    hasEntry: !!map.sessions[key],
    sessionId,
    directory: input.directory,
  })

  if (sessionId) {
    log.info("validating mapped feishu session", {
      channel: input.name,
      messageId,
      sessionId,
      directory: input.directory,
    })
    try {
      const existing = await input.sdk.session.get({ sessionID: sessionId })
      if (existing.error && isSessionNotFoundError(existing.error)) {
        log.warn("discarding stale feishu session mapping", {
          channel: input.name,
          messageId,
          sessionId,
          directory: input.directory,
          error: formatClientError(existing.error),
        })
        delete map.sessions[key]
        await saveMap(map)
        sessionId = undefined
        log.info("discarded stale feishu session mapping", {
          channel: input.name,
          messageId,
          key,
        })
      } else if (existing.error) {
        log.warn("failed to validate mapped feishu session", {
          channel: input.name,
          messageId,
          sessionId,
          directory: input.directory,
          error: formatClientError(existing.error),
        })
      } else {
        log.info("validated mapped feishu session", {
          channel: input.name,
          messageId,
          sessionId,
          directory: input.directory,
        })
      }
    } catch (err) {
      log.warn("mapped feishu session validation threw", {
        channel: input.name,
        messageId,
        sessionId,
        directory: input.directory,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!sessionId) {
    const title = `${titlePrefix(input.name)} ${chatId.slice(0, 12)}`
    log.info("creating session for feishu chat", {
      channel: input.name,
      messageId,
      chatId,
      directory: input.directory,
    })
    const created = await input.sdk.session.create({ title })
    if (created.error || !created.data?.id) {
      const detail = formatClientError(created.error)
      log.error("failed to create session for feishu message", {
        channel: input.name,
        messageId,
        error: detail,
      })
      if (messageId)
        await imRuntime.runPromise((service) =>
          service.markLegacyStatus(messageRecordID("feishu", input.name, messageId), "unknown"),
        )
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
  log.info("feishu prompt starting", {
    channel: input.name,
    sessionId,
    messageId,
    providerID: model?.providerID,
    modelID: model?.modelID,
  })
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
    log.error("feishu prompt threw", {
      channel: input.name,
      sessionId,
      messageId,
      providerID: model?.providerID,
      modelID: model?.modelID,
      error: detail,
    })
    await card.fail(`处理消息时出错了：${detail}`)
    if (messageId)
      await imRuntime.runPromise((service) =>
        service.markLegacyStatus(messageRecordID("feishu", input.name, messageId), "unknown"),
      )
    return
  }

  poll.stop()
  // Final snapshot after prompt returns (ensure last step is visible).
  await poll.flush()

  if ("error" in result && result.error) {
    const detail = formatClientError(result.error)
    log.error("feishu prompt failed", {
      channel: input.name,
      sessionId,
      messageId,
      providerID: model?.providerID,
      modelID: model?.modelID,
      error: detail,
    })
    await card.fail(`处理消息时出错了：${detail}`)
    if (messageId)
      await imRuntime.runPromise((service) =>
        service.markLegacyStatus(messageRecordID("feishu", input.name, messageId), "unknown"),
      )
    return
  }

  // session.prompt returns only the *final* assistant message. Aggregate all
  // assistant text parts in this turn for the card's final section.
  const reply = (await collectTurnAssistantText(input.sdk, sessionId)) || extractAssistantText(result.data)
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
function startStepPoller(input: { sdk: OpencodeClient; sessionId: string; card: FeishuTaskCard; intervalMs?: number }) {
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
