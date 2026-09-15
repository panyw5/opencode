import { randomBytes } from "node:crypto"
import * as Log from "@opencode-ai/core/util/log"
import { ProviderRejectedError as IMProviderRejectedError } from "../im/transport"

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
const log = Log.create({ service: "wechat-api" })

function losslessIDs(raw: string): string {
  let result = ""
  let cursor = 0
  while (cursor < raw.length) {
    if (raw[cursor] !== '"') {
      result += raw[cursor++]
      continue
    }
    const start = cursor++
    while (cursor < raw.length) {
      if (raw[cursor] === "\\") {
        cursor += 2
        continue
      }
      if (raw[cursor++] === '"') break
    }
    const token = raw.slice(start, cursor)
    result += token
    if (!["message_id", "msg_id", "svr_id"].includes(JSON.parse(token))) continue
    const match = raw.slice(cursor).match(/^(\s*:\s*)(\d+)(?=\s*[,}])/)
    if (!match) continue
    result += `${match[1]}"${match[2]}"`
    cursor += match[0].length
  }
  return result
}

export function validateBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Invalid WeChat API host")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))
  ) {
    throw new Error("Invalid WeChat API host")
  }
  return url.origin
}

export class ProviderRejectedError extends IMProviderRejectedError {
  constructor(
    code: number,
    public readonly operation: string,
    http = false,
  ) {
    super("wechat", http ? code : undefined, http ? undefined : code)
    this.name = "ProviderRejectedError"
  }
}
export class TransportError extends Error {
  constructor(
    public readonly kind: "timeout" | "cancelled" | "network" | "invalid_response",
    public readonly operation: string,
  ) {
    super(`WeChat ${operation} failed (${kind}; delivery may be unknown)`)
    this.name = "TransportError"
  }
}

export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}
export interface MessageItem {
  type?: number
  msg_id?: string
  ref_msg?: { svr_id?: string }
  text_item?: { text?: string }
  image_item?: { media?: CDNMedia; thumb_media?: CDNMedia; aeskey?: string; mid_size?: number; hd_size?: number }
  voice_item?: {
    media?: CDNMedia
    encode_type?: number
    bits_per_sample?: number
    sample_rate?: number
    playtime?: number
    text?: string
  }
  file_item?: { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
  video_item?: {
    media?: CDNMedia
    video_size?: number
    play_length?: number
    video_md5?: string
    thumb_media?: CDNMedia
  }
}
export interface Message {
  message_id?: number | string
  seq?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  group_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  item_list?: MessageItem[]
}
export interface QrResponse {
  qrcode: string
  qrcode_img_content: string
}
export interface QrStatus {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "need_verifycode"
    | "verify_code_blocked"
    | "scaned_but_redirect"
    | "binded_redirect"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}
export interface Updates {
  msgs?: Message[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}
export interface UploadUrlRequest {
  filekey: string
  media_type: 1 | 2 | 3 | 4
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb: true
  aeskey: string
}
export interface UploadUrlResponse {
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}
export interface ApiOptions {
  baseUrl?: string
  token?: string
  fetch?: typeof fetch
  version?: string
  timeoutMs?: number
}

export class WechatApi {
  readonly baseUrl: string
  private readonly options: ApiOptions
  constructor(options: ApiOptions = {}) {
    this.options = options
    this.baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  }
  private async request<T>(
    operation: string,
    body?: object,
    signal?: AbortSignal,
    query?: URLSearchParams,
  ): Promise<T> {
    const version = "2.4.8"
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 8),
    }
    if (body) {
      headers["Content-Type"] = "application/json"
      headers.AuthorizationType = "ilink_bot_token"
      headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64")
      if (this.options.token && operation !== "get_bot_qrcode") headers.Authorization = `Bearer ${this.options.token}`
    }
    if (body && operation !== "get_bot_qrcode") {
      if (!this.options.token) throw new Error("WeChat account is not authenticated")
      body = {
        ...body,
        base_info: {
          channel_version: version,
          bot_agent: `OpenCode/${(this.options.version ?? "dev").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "dev"}`,
        },
      }
    }
    const timeout = AbortSignal.timeout(
      this.options.timeoutMs ?? (["getupdates", "get_qrcode_status"].includes(operation) ? 45_000 : 20_000),
    )
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    log.debug("request started", { operation })
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.baseUrl}/ilink/bot/${operation}${query ? `?${query}` : ""}`,
        {
          method: body ? "POST" : "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: combined,
          redirect: "error",
        },
      )
      if (response.status >= 500) throw new TransportError("network", operation)
      if (!response.ok) throw new ProviderRejectedError(response.status, operation, true)
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let raw = ""
      let bytes = 0
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 4_000_000) {
              await reader.cancel()
              throw new TransportError("invalid_response", operation)
            }
            raw += decoder.decode(chunk.value, { stream: true })
          }
          raw += decoder.decode()
        } finally {
          reader.releaseLock()
        }
      }
      // Provider IDs are uint64; quote numeric ID tokens before JSON loses precision.
      let data: Record<string, unknown>
      try {
        data = JSON.parse(losslessIDs(raw))
      } catch {
        throw new TransportError("invalid_response", operation)
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new TransportError("invalid_response", operation)
      for (const field of ["ret", "errcode"]) {
        if (data[field] !== undefined && (typeof data[field] !== "number" || !Number.isSafeInteger(data[field])))
          throw new TransportError("invalid_response", operation)
      }
      const code = [data.ret, data.errcode].find((value) => typeof value === "number" && value !== 0)
      if (typeof code === "number") throw new ProviderRejectedError(code, operation)
      log.debug("request completed", { operation })
      return data as T
    } catch (error) {
      const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined
      const code =
        typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined
      const safe =
        error instanceof ProviderRejectedError || error instanceof TransportError
          ? error
          : new TransportError(signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network", operation)
      log.warn("request failed", {
        operation,
        error: safe.message,
        errorType: error instanceof Error ? error.name : typeof error,
        code,
      })
      throw safe
    }
  }
  getQr(signal?: AbortSignal) {
    return this.request<QrResponse>(
      "get_bot_qrcode",
      { local_token_list: [] },
      signal,
      new URLSearchParams({ bot_type: "3" }),
    )
  }
  pollQr(qrcode: string, verifyCode?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ qrcode })
    if (verifyCode) query.set("verify_code", verifyCode)
    return this.request<QrStatus>("get_qrcode_status", undefined, signal, query)
  }
  async getUpdates(cursor = "", signal?: AbortSignal) {
    const updates = await this.request<Updates>("getupdates", { get_updates_buf: cursor }, signal)
    const invalid = () => {
      throw new TransportError("invalid_response", "getupdates")
    }
    if (updates.get_updates_buf !== undefined && typeof updates.get_updates_buf !== "string") invalid()
    if (updates.msgs !== undefined && !Array.isArray(updates.msgs)) invalid()
    for (const message of updates.msgs ?? []) {
      if (!message || typeof message !== "object" || Array.isArray(message)) invalid()
      for (const value of [
        message.from_user_id,
        message.to_user_id,
        message.context_token,
        message.group_id,
        message.client_id,
      ])
        if (value !== undefined && typeof value !== "string") invalid()
      if (
        message.message_id !== undefined &&
        typeof message.message_id !== "string" &&
        !Number.isSafeInteger(message.message_id)
      )
        invalid()
      if (message.item_list !== undefined && !Array.isArray(message.item_list)) invalid()
      for (const item of message.item_list ?? []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) invalid()
        if (item.type !== undefined && !Number.isSafeInteger(item.type)) invalid()
        for (const value of [item.text_item?.text, item.voice_item?.text])
          if (value !== undefined && typeof value !== "string") invalid()
      }
    }
    return updates
  }
  async sendMessage(message: Message, signal?: AbortSignal) {
    const result = await this.request<{ ret?: number; message_id?: string }>("sendmessage", { msg: message }, signal)
    return result
  }
  async getUploadUrl(input: UploadUrlRequest, signal?: AbortSignal) {
    const result = await this.request<UploadUrlResponse>("getuploadurl", input, signal)
    for (const value of [result.upload_param, result.thumb_upload_param, result.upload_full_url])
      if (value !== undefined && typeof value !== "string") throw new TransportError("invalid_response", "getuploadurl")
    return result
  }
  notifyStart(signal?: AbortSignal) {
    return this.request<{ ret?: number }>("msg/notifystart", {}, signal)
  }
  notifyStop(signal?: AbortSignal) {
    return this.request<{ ret?: number }>("msg/notifystop", {}, signal)
  }
}

export * as WechatAPI from "./wechat-api"
