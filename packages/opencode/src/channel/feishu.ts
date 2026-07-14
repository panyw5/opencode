import * as Lark from "@larksuiteoapi/node-sdk"
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { loadMap, saveMap, sessionKey, titlePrefix } from "./mapping"

export type FeishuChannelConfig = {
  type: "feishu"
  appId: string
  appSecret: string
  allowedUsers?: string[]
  enabled?: boolean
  domain?: "feishu" | "lark"
  model?: string
}

const log = Log.create({ service: "channel.feishu" })

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

export function startFeishuChannel(opts: FeishuRuntimeOptions): StopHandle {
  const { name, config, baseUrl, directory } = opts
  const domain = resolveDomain(config.domain)
  let stopped = false

  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  })

  const sdk: OpencodeClient = createOpencodeClient({
    baseUrl,
    directory,
  })

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      if (stopped) return
      try {
        await handleMessage({
          name,
          config,
          client,
          sdk,
          data: data as FeishuMessageEvent,
        })
      } catch (err) {
        log.error("feishu message handler failed", { channel: name, error: err })
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

  log.info("feishu channel started", { channel: name, domain: config.domain ?? "feishu" })

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

async function handleMessage(input: {
  name: string
  config: FeishuChannelConfig
  client: Lark.Client
  sdk: OpencodeClient
  data: FeishuMessageEvent
}) {
  const msg = input.data.message
  const sender = input.data.sender
  if (!msg?.chat_id || !msg.content || !msg.message_type) return
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

  const chatId = msg.chat_id
  const threadId = msg.thread_id || msg.root_id
  const key = sessionKey({ channelName: input.name, chatId, threadId })

  const map = await loadMap()
  let sessionId = map.sessions[key]

  if (!sessionId) {
    const title = `${titlePrefix(input.name)} ${chatId.slice(0, 12)}`
    const created = await input.sdk.session.create({ title })
    if (created.error || !created.data?.id) {
      log.error("failed to create session for feishu message", {
        channel: input.name,
        error: created.error,
      })
      return
    }
    sessionId = created.data.id
    map.sessions[key] = sessionId
    await saveMap(map)
    log.info("created session for feishu chat", { channel: input.name, sessionId, chatId })
  }

  const model = parseModel(input.config.model)
  const result = await input.sdk.session.prompt({
    sessionID: sessionId,
    parts: [{ type: "text", text }],
    ...(model ? { model } : {}),
  })

  if (result.error) {
    log.error("feishu prompt failed", { channel: input.name, sessionId, error: result.error })
    await replyText(input.client, chatId, "抱歉，处理消息时出错了。", msg.message_id)
    return
  }

  const data = result.data as {
    parts?: Array<{ type?: string; text?: string }>
    info?: { content?: string }
  }
  const reply =
    data?.info?.content ||
    data?.parts
      ?.filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n") ||
    ""

  if (reply.trim()) {
    await replyText(input.client, chatId, reply, msg.message_id)
  }
}

async function replyText(client: Lark.Client, chatId: string, text: string, replyTo?: string) {
  const content = JSON.stringify({ text })
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
    log.error("feishu reply failed", { chatId, error: err })
  }
}
