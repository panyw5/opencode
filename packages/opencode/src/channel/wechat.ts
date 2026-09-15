import { createHash, randomUUID } from "node:crypto"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import * as Log from "@opencode-ai/core/util/log"
import type { ConfigChannels } from "@/config/channels"
import * as ServerAuth from "@/server/auth"
import { runtime as imRuntime, type MessageInfo } from "@/im/service"
import { IMOwner } from "@/im/owner"
import { dispatchMessage } from "@/im/dispatcher"
import { messageRecordID, NormalizedMessage, Target, type IMTransport } from "@/im/model"
import type { Attachment } from "@/im/model"
import { SendValidationError, transportCapabilities } from "@/im/transport"
import { and, asc, sql } from "@/storage/db"
import { Database, eq } from "@/storage/db"
import { IMAttachmentTable, IMMessageTable } from "@/im/inbox.sql"
import { IMMessageTombstoneTable } from "@/im/retention.sql"
import { WechatApi, ProviderRejectedError as WechatRejectedError, TransportError, type Message } from "./wechat-api"
import { WechatStorage } from "./wechat-storage"
import { loadMap, mappedEntry, resolveMappedSession, saveMap, sessionKey, titlePrefix } from "./mapping"
import { downloadMedia } from "./wechat-media"

const log = Log.create({ service: "channel.wechat" })
export type WechatRuntimeState = {
  channelName: string
  status: "awaiting_login" | "connected" | "reconnecting" | "auth_expired" | "stopped" | "account_busy"
  botId?: string
  lastReceivedAt?: number
  lastSentAt?: number
  error?: string
}
const states = new Map<string, WechatRuntimeState>()
export function channelStatus(channelName: string): WechatRuntimeState {
  return { ...(states.get(channelName) ?? { channelName, status: "stopped" }) }
}

export function permitted(config: ConfigChannels.Wechat, userId: string): boolean {
  if (!config.allowedUsers?.length) return userId === config.scannerUserId
  return config.allowedUsers.includes("*") || config.allowedUsers.includes(userId)
}

export function normalizeMessage(
  name: string,
  config: ConfigChannels.Wechat,
  message: Message,
): NormalizedMessage | undefined {
  const userId = message.from_user_id
  if (message.message_type !== 1 || message.group_id || !userId || !permitted(config, userId)) return
  const items = message.item_list ?? []
  const text = items
    .flatMap((item) => {
      if (item.type === 1 && item.text_item?.text) return [item.text_item.text]
      if (item.type === 3 && item.voice_item?.text) return [item.voice_item.text]
      return []
    })
    .join("\n")
    .trim()
  const hasMedia = items.some((item) => [2, 3, 4, 5].includes(item.type ?? 0))
  // Hash only public stable event fields; private reply context must not become an event ID.
  const eventID = String(
    message.message_id ??
      items.find((item) => item.msg_id)?.msg_id ??
      message.client_id ??
      createHash("sha256")
        .update(
          JSON.stringify([
            config.botId,
            userId,
            message.create_time_ms,
            message.seq,
            text,
            items.map((item) => item.type),
          ]),
        )
        .digest("hex"),
  )
  return new NormalizedMessage({
    id: messageRecordID("wechat", name, eventID),
    platform: "wechat",
    channelName: name,
    eventID,
    senderID: userId,
    target: new Target({
      platform: "wechat",
      channelName: name,
      scope: "c2c",
      conversationID: userId,
      senderID: userId,
      replyTo: eventID,
    }),
    text: text || "[WeChat media attachment]",
    ...(typeof message.create_time_ms === "number" ? { timeEvent: message.create_time_ms } : {}),
    metadata: { appIdentity: IMOwner.appIdentity(config), hasMedia, textAvailable: !!text },
  })
}

export function createWechatTransport(input: {
  name: string
  config: ConfigChannels.Wechat
  accountKey: string
  api: Pick<WechatApi, "sendMessage">
  storage: Pick<WechatStorage, "loadContext">
  signal?: AbortSignal
  onSent?: () => void
}): IMTransport {
  return {
    platform: "wechat",
    channelName: input.name,
    capabilities: transportCapabilities("wechat"),
    async sendText(message) {
      if (input.signal?.aborted) {
        log.warn("private send blocked", { channel: input.name, reason: "transport_stopped" })
        throw new SendValidationError("WeChat channel is stopped")
      }
      const target = message.target
      if (target.platform !== "wechat" || target.channelName !== input.name || target.scope !== "c2c") {
        log.warn("private send blocked", { channel: input.name, reason: "invalid_target" })
        throw new SendValidationError("WeChat supports private messages only")
      }
      const userId = target.conversationID
      if (!permitted(input.config, userId) || (target.senderID && target.senderID !== userId)) {
        log.warn("private send blocked", { channel: input.name, reason: "recipient_not_allowed" })
        throw new SendValidationError("WeChat recipient is not allowed")
      }
      if (message.format === "markdown") {
        log.warn("private send blocked", { channel: input.name, reason: "markdown_unsupported" })
        throw new SendValidationError("WeChat Markdown messages are not supported")
      }
      if (!message.text.trim() || message.text.length > 4000) {
        log.warn("private send blocked", { channel: input.name, reason: "invalid_text_length" })
        throw new SendValidationError("WeChat text must contain 1-4000 characters")
      }
      const context = await input.storage.loadContext(
        input.accountKey,
        userId,
        message.mode === "reply" ? target.replyTo : undefined,
      )
      if (!context?.token) {
        log.warn("private send blocked", { channel: input.name, reason: "reply_context_missing", mode: message.mode })
        throw new SendValidationError("WeChat needs a received private message with reply context before sending")
      }
      if (input.signal?.aborted) {
        log.warn("private send blocked", { channel: input.name, reason: "transport_stopped_after_context" })
        throw new SendValidationError("WeChat channel is stopped")
      }
      const clientId = message.providerClientID ?? randomUUID()
      log.info("private send started", { channel: input.name, mode: message.mode, textLength: message.text.length })
      try {
        await input.api.sendMessage(
          {
            from_user_id: "",
            to_user_id: userId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            context_token: context.token,
            item_list: [{ type: 1, text_item: { text: message.text } }],
          },
          input.signal,
        )
      } catch (error) {
        log.warn("private send transport failed", {
          channel: input.name,
          errorType: error instanceof Error ? error.name : typeof error,
          ...(error instanceof TransportError ? { reason: error.kind } : {}),
          ...(error instanceof WechatRejectedError ? { status: error.status, code: error.code } : {}),
        })
        throw error
      }
      input.onSent?.()
      log.info("private send accepted", { channel: input.name, mode: message.mode })
      // iLink confirms acceptance but does not guarantee a server message ID.
      return { timeSent: Date.now() }
    },
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

export async function startWechatChannel(opts: {
  name: string
  config: ConfigChannels.Wechat
  baseUrl: string
  directory: string
  storage?: WechatStorage
  api?: WechatApi
}) {
  const state: WechatRuntimeState = { channelName: opts.name, status: "awaiting_login", botId: opts.config.botId }
  states.set(opts.name, state)
  const storage = opts.storage ?? new WechatStorage()
  const credentials = await storage.loadCredentials(opts.name)
  if (
    !credentials ||
    !opts.config.botId ||
    credentials.botId !== opts.config.botId ||
    (opts.config.baseUrl && new URL(opts.config.baseUrl).origin !== credentials.baseUrl) ||
    credentials.scannerUserId !== opts.config.scannerUserId
  ) {
    log.info("channel awaits matching QR authorization", { channel: opts.name })
    return undefined
  }
  const accountKey = JSON.stringify([credentials.baseUrl, credentials.botId])
  let release: () => Promise<void>
  try {
    release = await storage.acquireLock(accountKey)
  } catch {
    state.status = "account_busy"
    state.error = "Account monitor is locked; another instance may be using this account"
    log.warn("account monitor lock unavailable", { channel: opts.name })
    return undefined
  }
  const controller = new AbortController()
  const signal = controller.signal
  const api = opts.api ?? new WechatApi({ token: credentials.token, baseUrl: credentials.baseUrl })
  const transport = createWechatTransport({
    name: opts.name,
    config: opts.config,
    accountKey,
    api,
    storage,
    signal,
    onSent: () => {
      state.lastSentAt = Date.now()
    },
  })
  const sdk = createOpencodeClient({ baseUrl: opts.baseUrl, directory: opts.directory, headers: ServerAuth.headers() })
  const queues = new Map<string, Promise<void>>()
  const processMessage = async (message: MessageInfo) => {
    if (signal.aborted) return
    log.info("durable message dispatch started", { channel: opts.name, eventID: message.eventID })
    const routed = await dispatchMessage(message)
    if (routed.matched) return
    if (
      opts.config.autoReply === false ||
      (message.metadata?.textAvailable === false && !message.attachments?.some((item) => item.status === "ready"))
    ) {
      if (await imRuntime.runPromise((service) => service.claimLegacyProcessing(message.id)))
        await imRuntime.runPromise((service) => service.markLegacyCompleted(message.id))
      log.info("automatic reply intentionally suppressed", { channel: opts.name, eventID: message.eventID })
      return
    }
    if (await imRuntime.runPromise((service) => service.hasSubscriptionDelivery(message.id))) return
    if (!(await storage.loadContext(accountKey, message.target.conversationID, message.target.replyTo))) {
      log.info("automatic reply waits for provider reply context", { channel: opts.name, eventID: message.eventID })
      return
    }
    if (!(await imRuntime.runPromise((service) => service.claimLegacyProcessing(message.id)))) return
    try {
      if (signal.aborted) throw new Error("Channel stopped")
      const key = sessionKey({
        channelName: opts.name,
        chatId: `${credentials.botId}:${message.target.conversationID}`,
      })
      const map = await loadMap()
      let sessionId = resolveMappedSession(map.sessions[key], opts.directory)
      if (!sessionId) {
        const created = await sdk.session.create({ title: `${titlePrefix(opts.name)} WeChat` })
        if (created.error || !created.data?.id) throw new Error("Session creation failed")
        sessionId = created.data.id
        map.sessions[key] = mappedEntry(sessionId, opts.directory)
        await saveMap(map)
        log.info("automatic reply session created", { channel: opts.name, sessionId })
      }
      if (signal.aborted) throw new Error("Channel stopped")
      const model = opts.config.model?.split("/")
      const result = await sdk.session.prompt(
        {
          sessionID: sessionId,
          parts: [
            { type: "text", text: message.text },
            ...(message.attachments?.flatMap((item) =>
              item.status === "ready" && item.data
                ? [
                    {
                      type: "file" as const,
                      mime: item.mime,
                      filename: item.filename,
                      url: `data:${item.mime};base64,${Buffer.from(item.data).toString("base64")}`,
                    },
                  ]
                : [],
            ) ?? []),
          ],
          tools: { question: false },
          ...(model && model.length > 1 ? { model: { providerID: model[0]!, modelID: model.slice(1).join("/") } } : {}),
        },
        { signal },
      )
      if (result.error) throw new Error("Model response failed")
      const answer = result.data?.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (!answer) throw new Error("Model returned no text")
      if (signal.aborted) throw new Error("Channel stopped")
      await transport.sendText({ target: message.target, text: answer, mode: "reply", providerClientID: message.id })
      await imRuntime.runPromise((service) => service.markLegacyCompleted(message.id))
      log.info("automatic reply completed", { channel: opts.name, eventID: message.eventID })
    } catch {
      await imRuntime.runPromise((service) => service.markLegacyStatus(message.id, "unknown"))
      log.error("automatic reply failed; not automatically retried", { channel: opts.name, eventID: message.eventID })
    }
  }
  const enqueue = (message: MessageInfo) => {
    const key = message.target.conversationID
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => processMessage(message))
      .catch(() => {
        log.error("durable dispatch failed; retained for recovery", { channel: opts.name, eventID: message.eventID })
      })
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key)
      })
    queues.set(key, next)
  }
  const loop = async () => {
    let cursor = (await storage.loadCursor(accountKey)) ?? ""
    let failures = 0
    await api.notifyStart(signal).catch(() => log.warn("provider start notification failed", { channel: opts.name }))
    // Recover unscheduled legacy messages after a crash between inbox commit and dispatch.
    const recovered = Database.use((db) =>
      db
        .select()
        .from(IMMessageTable)
        .where(
          and(
            eq(IMMessageTable.channel_name, opts.name),
            eq(IMMessageTable.platform, "wechat"),
            eq(IMMessageTable.direction, "inbound"),
            eq(IMMessageTable.legacy_status, "received"),
          ),
        )
        .orderBy(asc(IMMessageTable.ingest_seq))
        .all(),
    )
    for (const row of recovered) {
      if (row.metadata?.appIdentity !== IMOwner.appIdentity(opts.config)) continue
      if (opts.config.retentionDays && row.time_created < Date.now() - opts.config.retentionDays * 86_400_000) continue
      if (row.scope !== "c2c" || !row.sender_id || !permitted(opts.config, row.sender_id)) continue
      enqueue({
        id: row.id,
        platform: "wechat",
        channelName: row.channel_name,
        eventID: row.event_id,
        ingestSeq: row.ingest_seq,
        direction: row.direction,
        legacyStatus: row.legacy_status,
        target: new Target({
          platform: "wechat",
          channelName: row.channel_name,
          scope: "c2c",
          conversationID: row.conversation_id,
          senderID: row.sender_id,
          ...(row.reply_to ? { replyTo: row.reply_to } : {}),
        }),
        senderID: row.sender_id,
        senderName: row.sender_name ?? undefined,
        text: row.text,
        timeEvent: row.time_event ?? undefined,
        timeCreated: row.time_created,
        metadata: row.metadata ?? undefined,
        attachments: Database.use((db) =>
          db
            .select()
            .from(IMAttachmentTable)
            .where(eq(IMAttachmentTable.message_id, row.id))
            .orderBy(asc(IMAttachmentTable.ordinal))
            .all(),
        ).map((item) => ({
          id: item.id,
          kind: item.kind,
          mime: item.mime,
          ...(item.filename ? { filename: item.filename } : {}),
          size: item.size,
          ...(item.sha256 ? { sha256: item.sha256 } : {}),
          status: item.status,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.data ? { data: new Uint8Array(item.data) } : {}),
        })),
      })
    }
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(cursor, signal)
        if (signal.aborted) break
        const pending: MessageInfo[] = []
        for (const raw of updates.msgs ?? []) {
          if (signal.aborted) break
          const message = normalizeMessage(opts.name, opts.config, raw)
          if (!message) {
            log.debug("message filtered by type or ACL", { channel: opts.name })
            continue
          }
          const exists =
            Database.use((db) =>
              db.select({ id: IMMessageTable.id }).from(IMMessageTable).where(eq(IMMessageTable.id, message.id)).get(),
            ) ??
            Database.use((db) =>
              db
                .select({ id: IMMessageTombstoneTable.id })
                .from(IMMessageTombstoneTable)
                .where(eq(IMMessageTombstoneTable.id, message.id))
                .get(),
            )
          let enriched = message
          if (!exists) {
            const mediaItems = (raw.item_list ?? []).filter((item) => [2, 3, 4, 5].includes(item.type ?? 0))
            const attachments: Attachment[] = []
            let total = 0
            let channelTotal = Database.use(
              (db) =>
                db
                  .select({ value: sql<number>`coalesce(sum(${IMAttachmentTable.size}), 0)` })
                  .from(IMAttachmentTable)
                  .innerJoin(IMMessageTable, eq(IMMessageTable.id, IMAttachmentTable.message_id))
                  .where(eq(IMMessageTable.channel_name, opts.name))
                  .get()?.value ?? 0,
            )
            for (const [ordinal, item] of mediaItems.slice(0, 10).entries()) {
              if (total >= 40 * 1024 * 1024 || channelTotal >= 512 * 1024 * 1024) {
                attachments.push({
                  id: `imatt_${createHash("sha256").update(`${message.id}\0${ordinal}`).digest("hex").slice(0, 24)}`,
                  kind: item.type === 2 ? "image" : item.type === 3 ? "voice" : item.type === 5 ? "video" : "file",
                  mime: "application/octet-stream",
                  size: 0,
                  status: "rejected",
                  reason: channelTotal >= 512 * 1024 * 1024 ? "channel_quota" : "message_size",
                })
                continue
              }
              const downloaded = await downloadMedia({ item, signal })
              const data = downloaded.data
              total += data?.byteLength ?? 0
              const accepted =
                downloaded.status === "available" &&
                data &&
                total <= 40 * 1024 * 1024 &&
                channelTotal + data.byteLength <= 512 * 1024 * 1024
              if (accepted) channelTotal += data.byteLength
              attachments.push({
                id: `imatt_${createHash("sha256").update(`${message.id}\0${ordinal}`).digest("hex").slice(0, 24)}`,
                kind: downloaded.kind,
                mime: downloaded.contentType,
                ...(downloaded.filename ? { filename: downloaded.filename } : {}),
                size: accepted ? data.byteLength : 0,
                ...(accepted ? { sha256: createHash("sha256").update(data).digest("hex") } : {}),
                status: accepted
                  ? "ready"
                  : downloaded.reason === "network" || downloaded.reason === "timeout"
                    ? "unavailable"
                    : "rejected",
                ...(!accepted
                  ? {
                      reason:
                        channelTotal + (data?.byteLength ?? 0) > 512 * 1024 * 1024
                          ? "channel_quota"
                          : total > 40 * 1024 * 1024
                            ? "message_size"
                            : (downloaded.reason ?? "unavailable"),
                    }
                  : {}),
                ...(accepted ? { data } : {}),
              })
            }
            if (mediaItems.length > 10)
              attachments.push({
                id: `imatt_${createHash("sha256").update(`${message.id}\0overflow`).digest("hex").slice(0, 24)}`,
                kind: "file",
                mime: "application/octet-stream",
                size: 0,
                status: "rejected",
                reason: "too_many_attachments",
              })
            if (attachments.length) enriched = new NormalizedMessage({ ...message, attachments })
          }
          const stored = await imRuntime.runPromise((service) => service.ingest({ message: enriched }))
          if (raw.context_token && !stored.expired)
            await storage.saveContext(accountKey, message.senderID!, {
              token: raw.context_token,
              timestamp: message.timeEvent ?? Date.now(),
              messageId: message.eventID,
            })
          await IMOwner.runtime.runPromise((service) => service.observe(message, opts.config))
          if (!stored.expired) pending.push(stored.message)
          state.lastReceivedAt = Date.now()
          log.info("private message persisted", {
            channel: opts.name,
            eventID: message.eventID,
            inserted: stored.inserted,
          })
        }
        if (signal.aborted) break
        if (updates.get_updates_buf) {
          await storage.saveCursor(accountKey, updates.get_updates_buf)
          cursor = updates.get_updates_buf
          log.debug("receive cursor committed", { channel: opts.name })
        }
        for (const message of pending) enqueue(message)
        failures = 0
        state.status = "connected"
        delete state.error
        // Some backends immediately return an empty poll; avoid a hot request loop.
        if (!updates.msgs?.length) await sleep(250, signal)
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof WechatRejectedError && error.code === -14) {
          state.status = "auth_expired"
          state.error = "WeChat authorization expired; scan again"
          controller.abort()
          log.warn("account authorization expired", { channel: opts.name })
          break
        }
        if (error instanceof TransportError && error.kind === "timeout") continue
        state.status = "reconnecting"
        state.error = "Receive failed; retrying without advancing the saved cursor"
        failures++
        log.warn("receive retry scheduled", { channel: opts.name, failures })
        await sleep(failures % 3 === 0 ? 30_000 : 2000, signal)
      }
    }
  }
  const running = loop().catch(() => {
    controller.abort()
    state.status = "reconnecting"
    state.error = "Channel monitor stopped unexpectedly; restart the channel"
    log.error("monitor stopped unexpectedly", { channel: opts.name })
  })
  let stopping: Promise<void> | undefined
  return {
    transport,
    stop() {
      return (stopping ??= (async () => {
        controller.abort()
        await running
        // Do not wait for a potentially slow model; stopped transports cannot send.
        await api.notifyStop().catch(() => log.warn("provider stop notification failed", { channel: opts.name }))
        await release()
        state.status = "stopped"
        log.info("channel monitor stopped", { channel: opts.name })
      })())
    },
  }
}

export * as WechatChannel from "./wechat"
