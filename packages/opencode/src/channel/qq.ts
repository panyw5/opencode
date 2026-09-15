import WebSocket from "ws"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import * as ServerAuth from "@/server/auth"
import { runtime as imRuntime } from "@/im/service"
import { messageRecordID, NormalizedMessage, Target, type IMTransport, type TransportSendInput } from "@/im/model"
import { ProviderRejectedError, SendValidationError, transportCapabilities } from "@/im/transport"
import { AppRuntime } from "@/effect/app-runtime"
import { dispatchMessage } from "@/im/dispatcher"
import { IMOwner } from "@/im/owner"
import { loadMap, mappedEntry, resolveMappedSession, saveMap, sessionKey, titlePrefix } from "./mapping"

export type QQChannelConfig = {
  type: "qq"
  appId: string
  clientSecret: string
  apiBaseUrl?: string
  allowedUsers?: string[]
  enabled?: boolean
  autoReply?: boolean
  model?: string
  directory?: string
}

export type QQRuntimeOptions = { name: string; config: QQChannelConfig; baseUrl: string; directory: string }
export type QQChannelHandle = { stop: () => void; transport: IMTransport }
type GatewayFrame = { op?: number; d?: any; s?: number | null; t?: string }
type QQMessageEvent = {
  id?: string
  content?: string
  timestamp?: string
  author?: { user_openid?: string; member_openid?: string; id?: string }
  group_openid?: string
  guild_id?: string
  channel_id?: string
}

const log = Log.create({ service: "channel.qq" })
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
const DEFAULT_API_BASE = "https://api.bot.qq.com"
const INTENT_C2C = 1 << 25
const INTENT_GROUP_AT = 1 << 26
const INTENT_GUILD_AT = 1 << 30

function allowed(openid: string | undefined, users: string[] | undefined) {
  return !users?.length || users.includes("*") || (!!openid && users.includes(openid))
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model?.trim()) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function createDedupe(limit = 2000) {
  const seen = new Set<string>()
  const order: string[] = []
  return {
    claim(id: string) {
      if (seen.has(id)) return false
      seen.add(id)
      order.push(id)
      while (order.length > limit) seen.delete(order.shift()!)
      return true
    },
  }
}

function createQueue() {
  const tails = new Map<string, Promise<void>>()
  return {
    enqueue(key: string, task: () => Promise<void>) {
      const next = (tails.get(key) ?? Promise.resolve()).then(task, task).finally(() => {
        if (tails.get(key) === next) tails.delete(key)
      })
      tails.set(key, next)
      return next
    },
  }
}

function messageInfo(type: string | undefined, event: QQMessageEvent) {
  if (type === "C2C_MESSAGE_CREATE" && event.author?.user_openid) {
    const openid = event.author.user_openid
    return { openid, chatId: `private:${openid}`, path: `/v2/users/${openid}/messages` }
  }
  if (type === "GROUP_AT_MESSAGE_CREATE" && event.group_openid) {
    return {
      openid: event.author?.member_openid,
      chatId: `group:${event.group_openid}`,
      path: `/v2/groups/${event.group_openid}/messages`,
    }
  }
  if (type === "AT_MESSAGE_CREATE" && event.guild_id && event.channel_id) {
    return {
      openid: event.author?.id,
      chatId: `channel:${event.guild_id}:${event.channel_id}`,
      path: `/channels/${event.channel_id}/messages`,
    }
  }
  return undefined
}

function textFromMessage(content: string | undefined) {
  return content?.replace(/<@!?(\d+)>/g, "").trim() ?? ""
}

function formatError(value: unknown) {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

type QQRequestJson = (url: string, init?: RequestInit) => Promise<any>

export async function requestQQJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined)
  if ((response.status >= 400 && response.status < 500) || (body?.code && body.code !== 0 && response.ok))
    throw new ProviderRejectedError("qq", response.status, body?.code)
  if (!response.ok) throw new Error(`QQ API HTTP ${response.status}`)
  return body
}

export function createQQTransport(input: {
  name: string
  apiBase: string
  getToken: () => Promise<string | undefined>
  requestJson: QQRequestJson
}): IMTransport {
  const sequences = new Map<string, number>()
  return {
    platform: "qq",
    channelName: input.name,
    capabilities: transportCapabilities("qq"),
    sendText: async (message) => {
      if (message.format === "markdown") throw new SendValidationError("QQ Markdown messages are not supported")
      const scope = message.target.scope
      if (scope === "guild" && message.mode === "proactive")
        throw new Error("QQ proactive guild messages are unsupported")
      if (message.text.length > 4000) throw new SendValidationError("QQ text exceeds 4000 characters")
      let targetID = message.target.conversationID
      let endpoint: string
      if (scope === "c2c") {
        targetID = targetID.startsWith("private:") ? targetID.slice("private:".length) : targetID
        endpoint = `/v2/users/${encodeURIComponent(targetID)}/messages`
      } else if (scope === "group") {
        targetID = targetID.startsWith("group:") ? targetID.slice("group:".length) : targetID
        endpoint = `/v2/groups/${encodeURIComponent(targetID)}/messages`
      } else {
        targetID = targetID.split(":").at(-1) || targetID
        endpoint = `/channels/${encodeURIComponent(targetID)}/messages`
      }
      if (!targetID) throw new Error("QQ target ID is empty")
      if (message.mode === "reply" && !message.target.replyTo)
        throw new Error("QQ replies require an inbound message ID")
      const key = `${scope}:${targetID}:${message.mode === "reply" ? (message.target.replyTo ?? "") : "proactive"}`
      const msgSeq = message.providerSequence ?? (sequences.get(key) ?? 0) + 1
      if (msgSeq > 65535) throw new Error("QQ message sequence exhausted")
      if (message.providerSequence === undefined) sequences.set(key, msgSeq)
      const body: Record<string, unknown> = {
        content: message.text,
        msg_type: 0,
        msg_seq: message.providerSequence ?? msgSeq,
      }
      if (message.mode === "reply") body.msg_id = message.target.replyTo
      const token = await input.getToken()
      if (!token) throw new SendValidationError("QQ access token unavailable")
      const response = await input.requestJson(`${input.apiBase}${endpoint}`, {
        method: "POST",
        headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      log.info("qq transport text sent", {
        channel: input.name,
        mode: message.mode,
        scope,
        conversationID: message.target.conversationID,
      })
      return { providerMessageID: typeof response?.id === "string" ? response.id : undefined, timeSent: Date.now() }
    },
  }
}

export function startQQChannel(opts: QQRuntimeOptions): QQChannelHandle {
  const apiBase = (opts.config.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, "")
  const authHeaders =
    ServerAuth.headers({
      username: process.env["OPENCODE_SERVER_USERNAME"] || "opencode",
      password: process.env["OPENCODE_SERVER_PASSWORD"] || undefined,
    }) ?? ServerAuth.headers()
  const sdk = createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    ...(authHeaders ? { headers: authHeaders } : {}),
  })
  const dedupe = createDedupe()
  const queue = createQueue()
  let socket: WebSocket | undefined
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let token: string | undefined
  let tokenExpiresAt = 0
  let sequence: number | null = null

  const requestJson = requestQQJson

  const getToken = async () => {
    if (token && Date.now() < tokenExpiresAt) return token
    log.info("qq official token requesting", { channel: opts.name })
    const body = await requestJson(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: opts.config.appId, clientSecret: opts.config.clientSecret }),
    })
    if (!body?.access_token) throw new Error("QQ API did not return access_token")
    token = body.access_token
    tokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in || 7200) - 300) * 1000
    log.info("qq official token received", { channel: opts.name, expiresIn: body.expires_in })
    return token
  }

  const transport = createQQTransport({ name: opts.name, apiBase, getToken, requestJson })

  const sendReply = async (event: QQMessageEvent, type: string, text: string) => {
    const info = messageInfo(type, event)
    if (!info || !event.id) return
    const scope: "c2c" | "group" | "guild" =
      type === "C2C_MESSAGE_CREATE" ? "c2c" : type === "GROUP_AT_MESSAGE_CREATE" ? "group" : "guild"
    const target = new Target({
      platform: "qq",
      channelName: opts.name,
      scope,
      conversationID: info.chatId,
      replyTo: event.id,
    })
    const providerSequence = await imRuntime.runPromise((service) =>
      service.reserveProviderSequence({ platform: "qq", channelName: opts.name, target, mode: "reply" }),
    )
    if (text.length > 4000) throw new Error("QQ legacy reply exceeds 4000 characters")
    await transport.sendText({ target, text, mode: "reply", providerSequence })
    log.info("qq official reply sent", {
      channel: opts.name,
      messageId: event.id,
      chatId: info.chatId,
      replyLen: text.length,
    })
  }

  const handleMessage = async (type: string, event: QQMessageEvent) => {
    const info = messageInfo(type, event)
    if (!info || !event.id) return
    if (!dedupe.claim(event.id)) {
      log.info("qq duplicate message ignored", { channel: opts.name, messageId: event.id })
      return
    }
    if (!allowed(info.openid, opts.config.allowedUsers)) {
      log.info("qq message ignored by ACL", { channel: opts.name, openid: info.openid })
      return
    }
    const text = textFromMessage(event.content)
    if (!text) return
    log.info("qq official message received", {
      channel: opts.name,
      type,
      messageId: event.id,
      chatId: info.chatId,
      textLen: text.length,
    })
    try {
      const scope: "c2c" | "group" | "guild" =
        type === "C2C_MESSAGE_CREATE" ? "c2c" : type === "GROUP_AT_MESSAGE_CREATE" ? "group" : "guild"
      const stored = await imRuntime.runPromise((service) =>
        service.ingest({
          message: new NormalizedMessage({
            id: messageRecordID("qq", opts.name, event.id!),
            platform: "qq",
            channelName: opts.name,
            eventID: event.id!,
            target: new Target({
              platform: "qq",
              channelName: opts.name,
              scope,
              conversationID: info.chatId,
              ...(info.openid ? { senderID: info.openid } : {}),
              replyTo: event.id,
            }),
            ...(info.openid ? { senderID: info.openid } : {}),
            text,
            ...(event.timestamp ? { timeEvent: Date.parse(event.timestamp) || undefined } : {}),
            metadata: { eventType: type, appIdentity: IMOwner.appIdentity(opts.config) },
          }),
        }),
      )
      await IMOwner.runtime.runPromise((service) =>
        service.observe(new NormalizedMessage({ ...stored.message }), opts.config),
      )
      if (stored.expired) {
        log.info("qq expired message ignored", { channel: opts.name, messageId: event.id })
        return
      }
      if (stored.inserted)
        await imRuntime.runPromise((service) => service.markLegacyStatus(stored.message.id, "processing"))
      let shouldDispatch = stored.inserted
      if (!stored.inserted) {
        shouldDispatch = false
        log.info("qq durable duplicate message ignored", { channel: opts.name, messageId: event.id })
        let matched = 0
        try {
          const routed = await dispatchMessage(stored.message)
          matched = routed.matched
          log.info("qq duplicate replay dispatched", {
            channel: opts.name,
            messageId: event.id,
            matched: routed.matched,
          })
        } catch (error) {
          log.error("qq duplicate replay dispatch failed", {
            channel: opts.name,
            messageId: event.id,
            error: formatError(error),
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
            log.info("qq message routed to project subscriptions", {
              channel: opts.name,
              messageId: event.id,
              matched: routed.matched,
              admitted: routed.admitted,
            })
            return
          }
        } catch (error) {
          log.error("qq subscription dispatch failed; legacy reply suppressed", {
            channel: opts.name,
            messageId: event.id,
            error: formatError(error),
          })
          await imRuntime.runPromise((service) => service.markLegacyStatus(stored.message.id, "unknown"))
          return
        }
      if (opts.config.autoReply === false) {
        log.info("qq legacy auto reply disabled", { channel: opts.name, messageId: event.id })
        return
      }
    } catch (error) {
      // Keep the established auto-reply path alive if the optional IM inbox is
      // unavailable, while making the degraded persistence visible in logs.
      log.error("qq inbound persistence failed", {
        channel: opts.name,
        messageId: event.id,
        error: formatError(error),
      })
    }
    if (opts.config.autoReply === false) {
      log.info("qq legacy auto reply disabled after persistence path", { channel: opts.name, messageId: event.id })
      return
    }
    const key = sessionKey({ channelName: opts.name, chatId: info.chatId })
    const map = await loadMap()
    let sessionId = resolveMappedSession(map.sessions[key], opts.directory)
    if (!sessionId) {
      const created = await sdk.session.create({ title: `${titlePrefix(opts.name)} ${info.chatId.slice(0, 24)}` })
      if (created.error || !created.data?.id) {
        const error = formatError(created.error || "session creation failed")
        log.error("qq session creation failed", { channel: opts.name, messageId: event.id, error })
        await imRuntime.runPromise((service) =>
          service.markLegacyStatus(messageRecordID("qq", opts.name, event.id!), "unknown"),
        )
        await sendReply(event, type, `抱歉，创建会话失败：${error}`)
        return
      }
      sessionId = created.data.id
      map.sessions[key] = mappedEntry(sessionId, opts.directory)
      await saveMap(map)
      log.info("qq session created", { channel: opts.name, sessionId, chatId: info.chatId })
    }
    const model = parseModel(opts.config.model)
    try {
      const result = await sdk.session.prompt({
        sessionID: sessionId,
        parts: [{ type: "text", text }],
        tools: { question: false },
        ...(model ? { model } : {}),
      })
      if ("error" in result && result.error) throw new Error(formatError(result.error))
      const data = result.data as { parts?: Array<{ type?: string; text?: string }>; content?: string } | undefined
      const answer =
        data?.content ||
        data?.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n") ||
        "（模型没有返回文本内容）"
      await sendReply(event, type, answer.trim() || "（模型没有返回文本内容）")
      log.info("qq prompt completed", { channel: opts.name, sessionId, messageId: event.id, replyLen: answer.length })
    } catch (error) {
      const detail = formatError(error)
      log.error("qq prompt failed", { channel: opts.name, sessionId, messageId: event.id, error: detail })
      await sendReply(event, type, `处理消息时出错了：${detail}`).catch((replyError) =>
        log.error("qq error reply failed", { channel: opts.name, error: formatError(replyError) }),
      )
      await imRuntime.runPromise((service) =>
        service.markLegacyStatus(messageRecordID("qq", opts.name, event.id!), "unknown"),
      )
    }
  }

  const connect = async () => {
    if (stopped) return
    try {
      const accessToken = await getToken()
      let gateway: any
      try {
        gateway = await requestJson(`${apiBase}/gateway`, { headers: { authorization: `QQBot ${accessToken}` } })
      } catch (error) {
        log.warn("qq official gateway primary endpoint failed, trying legacy path", {
          channel: opts.name,
          error: formatError(error),
        })
        gateway = await requestJson(`${apiBase}/gateway/bot`, { headers: { authorization: `QQBot ${accessToken}` } })
      }
      const gatewayUrl = gateway?.url
      if (!gatewayUrl) throw new Error("QQ API did not return gateway url")
      log.info("qq official gateway connecting", { channel: opts.name, gatewayUrl })
      socket = new WebSocket(gatewayUrl)
      socket.on("open", () => log.info("qq official gateway socket opened", { channel: opts.name }))
      socket.on("message", (raw) => {
        try {
          const frame = JSON.parse(String(raw)) as GatewayFrame
          if (typeof frame.s === "number") sequence = frame.s
          if (frame.op === 10) {
            const interval = Number(frame.d?.heartbeat_interval || 41250)
            heartbeatTimer = setInterval(
              () => socket?.send(JSON.stringify({ op: 1, d: sequence })),
              Math.max(1000, interval),
            )
            socket?.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `QQBot ${accessToken}`,
                  intents: INTENT_C2C | INTENT_GROUP_AT | INTENT_GUILD_AT,
                  shard: [0, 1],
                  properties: { $os: process.platform, $browser: "opencode", $device: "opencode" },
                },
              }),
            )
            log.info("qq official gateway identified", {
              channel: opts.name,
              intents: INTENT_C2C | INTENT_GROUP_AT | INTENT_GUILD_AT,
            })
            return
          }
          if (frame.op === 0 && frame.t) {
            const event = frame.d as QQMessageEvent
            const info = messageInfo(frame.t, event)
            if (info) {
              void queue
                .enqueue(`${opts.name}::${info.chatId}`, async () => {
                  await handleMessage(frame.t!, event)
                  if (event.id)
                    await imRuntime.runPromise((service) =>
                      service.markLegacyCompleted(messageRecordID("qq", opts.name, event.id!)),
                    )
                })
                .catch((error) => {
                  const status = event.id
                    ? imRuntime.runPromise((service) =>
                        service.markLegacyStatus(messageRecordID("qq", opts.name, event.id!), "unknown"),
                      )
                    : Promise.resolve()
                  return status.then(() =>
                    log.error("qq event handler failed", { channel: opts.name, error: formatError(error) }),
                  )
                })
            }
          }
          if (frame.op === 7 || frame.op === 9) socket?.close()
        } catch (error) {
          log.warn("qq gateway message parse failed", { channel: opts.name, error: formatError(error) })
        }
      })
      socket.on("error", (error) =>
        log.error("qq official gateway error", { channel: opts.name, error: formatError(error) }),
      )
      socket.on("close", (code, reason) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
        socket = undefined
        log.warn("qq official gateway closed", { channel: opts.name, code, reason: String(reason) })
        if (!stopped) reconnectTimer = setTimeout(() => void connect(), 3000)
      })
    } catch (error) {
      log.error("qq official gateway connection failed", { channel: opts.name, error: formatError(error) })
      if (!stopped) reconnectTimer = setTimeout(() => void connect(), 5000)
    }
  }

  void connect()
  log.info("qq official channel started", {
    channel: opts.name,
    apiBase,
    appId: opts.config.appId,
    directory: opts.directory,
  })
  return {
    transport,
    stop: () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      socket?.close()
      socket = undefined
      log.info("qq official channel stopped", { channel: opts.name })
    },
  }
}

export const __test = { allowed, parseModel, messageInfo, textFromMessage, createDedupe, createQueue }
export * as QQChannel from "./qq"
