import WebSocket from "ws"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import * as ServerAuth from "@/server/auth"
import { loadMap, mappedEntry, resolveMappedSession, saveMap, sessionKey, titlePrefix } from "./mapping"

export type QQChannelConfig = {
  type: "qq"
  endpoint: string
  accessToken?: string
  allowedUsers?: string[]
  groupRequireMention?: boolean
  enabled?: boolean
  model?: string
  directory?: string
}

export type QQRuntimeOptions = {
  name: string
  config: QQChannelConfig
  baseUrl: string
  directory: string
}

type StopHandle = { stop: () => void }
type QQEvent = {
  post_type?: string
  message_type?: "private" | "group"
  message_id?: number | string
  user_id?: number | string
  group_id?: number | string
  self_id?: number | string
  raw_message?: string
  message?: string | Array<{ type?: string; data?: { text?: string; qq?: string } }>
}

const log = Log.create({ service: "channel.qq" })

function allowed(userId: string | undefined, users: string[] | undefined) {
  return !users?.length || users.includes("*") || (!!userId && users.includes(userId))
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model?.trim()) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function stripCQ(text: string) {
  return text.replace(/\[CQ:[^\]]+\]/g, "").trim()
}

function messageText(event: QQEvent) {
  if (typeof event.raw_message === "string") return stripCQ(event.raw_message)
  if (typeof event.message === "string") return stripCQ(event.message)
  if (!Array.isArray(event.message)) return ""
  return event.message
    .filter((part) => part.type === "text")
    .map((part) => part.data?.text ?? "")
    .join("")
    .trim()
}

function mentionsBot(event: QQEvent) {
  if (typeof event.raw_message === "string" && event.self_id != null) {
    return event.raw_message.includes(`[CQ:at,qq=${String(event.self_id)}]`)
  }
  return (
    Array.isArray(event.message) &&
    event.message.some((part) => part.type === "at" && part.data?.qq === String(event.self_id))
  )
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

export function startQQChannel(opts: QQRuntimeOptions): StopHandle {
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

  const send = async (action: string, params: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("QQ OneBot websocket is not connected")
    socket.send(JSON.stringify({ action, params, echo: `${Date.now()}-${Math.random()}` }))
  }

  const reply = async (event: QQEvent, text: string) => {
    const maxLen = 4000
    const body = text.length > maxLen ? `${text.slice(0, maxLen - 20)}\n...(已截断)` : text
    const params: Record<string, unknown> = { message: body, auto_escape: false }
    if (event.message_type === "group" && event.group_id != null) params.group_id = event.group_id
    else if (event.user_id != null) params.user_id = event.user_id
    await send("send_msg", params)
    log.info("qq reply sent", { channel: opts.name, messageId: event.message_id, replyLen: body.length })
  }

  const handle = async (event: QQEvent) => {
    if (event.post_type !== "message" || !event.message_type || event.user_id == null) return
    const messageId = event.message_id == null ? undefined : String(event.message_id)
    if (messageId && !dedupe.claim(messageId)) {
      log.info("qq duplicate message ignored", { channel: opts.name, messageId })
      return
    }
    const userId = String(event.user_id)
    if (!allowed(userId, opts.config.allowedUsers)) {
      log.info("qq message ignored by ACL", { channel: opts.name, userId })
      return
    }
    if (event.message_type === "group" && opts.config.groupRequireMention && !mentionsBot(event)) {
      log.info("qq group message ignored without mention", { channel: opts.name, messageId })
      return
    }
    const text = messageText(event)
    if (!text) return
    const chatId = event.group_id == null ? `private:${userId}` : `group:${event.group_id}`
    const key = sessionKey({ channelName: opts.name, chatId })
    log.info("qq message received", { channel: opts.name, messageId, userId, chatId, textLen: text.length })
    const map = await loadMap()
    let sessionId = resolveMappedSession(map.sessions[key], opts.directory)
    if (!sessionId) {
      const created = await sdk.session.create({ title: `${titlePrefix(opts.name)} ${chatId.slice(0, 24)}` })
      if (created.error || !created.data?.id) {
        const error = String(created.error ?? "session creation failed")
        log.error("qq session creation failed", { channel: opts.name, messageId, error })
        await reply(event, `抱歉，创建会话失败：${error}`)
        return
      }
      sessionId = created.data.id
      map.sessions[key] = mappedEntry(sessionId, opts.directory)
      await saveMap(map)
      log.info("qq session created", { channel: opts.name, sessionId, chatId })
    }
    const model = parseModel(opts.config.model)
    log.info("qq prompt starting", {
      channel: opts.name,
      sessionId,
      messageId,
      providerID: model?.providerID,
      modelID: model?.modelID,
    })
    try {
      const result = await sdk.session.prompt({
        sessionID: sessionId,
        parts: [{ type: "text", text }],
        tools: { question: false },
        ...(model ? { model } : {}),
      })
      if ("error" in result && result.error) throw new Error(JSON.stringify(result.error))
      const data = result.data as { parts?: Array<{ type?: string; text?: string }>; content?: string } | undefined
      const answer =
        data?.content ||
        data?.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n") ||
        "（模型没有返回文本内容）"
      await reply(event, answer.trim() || "（模型没有返回文本内容）")
      log.info("qq prompt completed", { channel: opts.name, sessionId, messageId, replyLen: answer.length })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log.error("qq prompt failed", { channel: opts.name, sessionId, messageId, error: detail })
      await reply(event, `处理消息时出错了：${detail}`).catch((replyError) =>
        log.error("qq error reply failed", { channel: opts.name, error: String(replyError) }),
      )
    }
  }

  const connect = () => {
    if (stopped) return
    log.info("qq websocket connecting", { channel: opts.name, endpoint: opts.config.endpoint })
    socket = new WebSocket(
      opts.config.endpoint,
      opts.config.accessToken ? { headers: { Authorization: `Bearer ${opts.config.accessToken}` } } : undefined,
    )
    socket.on("open", () => log.info("qq websocket connected", { channel: opts.name }))
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(String(raw)) as QQEvent
        if (event.post_type === "meta_event") return
        const chatKey = event.group_id == null ? `private:${event.user_id ?? "unknown"}` : `group:${event.group_id}`
        void queue
          .enqueue(`${opts.name}::${chatKey}`, () => handle(event))
          .catch((error) => log.error("qq event handler failed", { channel: opts.name, error: String(error) }))
      } catch (error) {
        log.warn("qq websocket message parse failed", { channel: opts.name, error: String(error) })
      }
    })
    socket.on("error", (error) => log.error("qq websocket error", { channel: opts.name, error: String(error) }))
    socket.on("close", (code, reason) => {
      log.warn("qq websocket closed", { channel: opts.name, code, reason: String(reason) })
      socket = undefined
      if (!stopped) reconnectTimer = setTimeout(connect, 3000)
    })
  }
  connect()
  log.info("qq channel started", { channel: opts.name, directory: opts.directory, baseUrl: opts.baseUrl })
  return {
    stop: () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      socket = undefined
      log.info("qq channel stopped", { channel: opts.name })
    },
  }
}

export const __test = { allowed, parseModel, stripCQ, messageText, mentionsBot, createDedupe, createQueue }

export * as QQChannel from "./qq"
