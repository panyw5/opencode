import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import * as Log from "@opencode-ai/core/util/log"
import type { MessageItem, UploadUrlRequest, WechatApi } from "./wechat-api"

const log = Log.create({ service: "wechat-media" })
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

export type MediaKind = "image" | "voice" | "file" | "video"
export type DownloadDescriptor = {
  kind: MediaKind
  status: "available" | "unavailable"
  data?: Uint8Array
  filename?: string
  contentType: string
  reason?: "invalid" | "network" | "timeout" | "size" | "crypto" | "provider"
}
export class MediaError extends Error {
  constructor(readonly reason: NonNullable<DownloadDescriptor["reason"]>) {
    super(`WeChat media operation failed (${reason})`)
    this.name = "MediaError"
  }
}

export function validateCdnUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new MediaError("invalid")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))
  )
    throw new MediaError("invalid")
  return url
}

function fallbackUrl(base: string, operation: "download" | "upload", parameter: string, filekey?: string) {
  const url = validateCdnUrl(base)
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${operation}`
  url.search = ""
  url.searchParams.set("encrypted_query_param", parameter)
  if (filekey) url.searchParams.set("filekey", filekey)
  return validateCdnUrl(url.href)
}

function key(input: string, format: "base64" | "hex" = "base64") {
  if (format === "hex") {
    if (!/^[0-9a-fA-F]{32}$/.test(input)) throw new MediaError("invalid")
    return Buffer.from(input, "hex")
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new MediaError("invalid")
  const decoded = Buffer.from(input, "base64")
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii")))
    return Buffer.from(decoded.toString("ascii"), "hex")
  throw new MediaError("invalid")
}

async function bounded(response: Response, maximum: number) {
  const declared = response.headers.get("content-length")
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new MediaError("size")
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        throw new MediaError("size")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function decrypt(input: Buffer, aes: Buffer) {
  if (!input.length || input.length % 16) throw new MediaError("crypto")
  try {
    const decipher = createDecipheriv("aes-128-ecb", aes, null)
    const output = Buffer.concat([decipher.update(input), decipher.final()])
    if (output.length > MAX_MEDIA_BYTES) throw new MediaError("size")
    return output
  } catch (error) {
    if (error instanceof MediaError) throw error
    throw new MediaError("crypto")
  }
}

export function sanitizeFilename(input?: string) {
  let output = (input ?? "attachment.bin").replaceAll("\\", "/").split("/").pop() ?? ""
  output = output
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .replace(/[. ]+$/, "")
  if (!output) output = "attachment.bin"
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(output)) output = `_${output}`
  let bounded = ""
  let bytes = 0
  for (const character of output) {
    const size = Buffer.byteLength(character)
    if (bytes + size > 255) break
    bounded += character
    bytes += size
  }
  return bounded || "attachment.bin"
}

function describe(item: MessageItem) {
  if (item.type === 2)
    return {
      kind: "image" as const,
      reference: item.image_item?.media,
      aes: item.image_item?.aeskey ?? item.image_item?.media?.aes_key,
      keyFormat: item.image_item?.aeskey ? ("hex" as const) : ("base64" as const),
      declaredCiphertext: item.image_item?.mid_size,
    }
  if (item.type === 3)
    return {
      kind: "voice" as const,
      reference: item.voice_item?.media,
      aes: item.voice_item?.media?.aes_key,
      keyFormat: "base64" as const,
      contentType: "audio/silk",
    }
  if (item.type === 4)
    return {
      kind: "file" as const,
      reference: item.file_item?.media,
      aes: item.file_item?.media?.aes_key,
      keyFormat: "base64" as const,
      contentType: "application/octet-stream",
      filename: sanitizeFilename(item.file_item?.file_name),
      declaredPlaintext: item.file_item?.len,
    }
  if (item.type === 5)
    return {
      kind: "video" as const,
      reference: item.video_item?.media,
      aes: item.video_item?.media?.aes_key,
      keyFormat: "base64" as const,
      declaredCiphertext: item.video_item?.video_size,
    }
  throw new MediaError("invalid")
}

function imageType(data: Uint8Array): string | undefined {
  const hex = Buffer.from(data.subarray(0, 12)).toString("hex")
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png"
  if (hex.startsWith("ffd8ff")) return "image/jpeg"
  if (
    Buffer.from(data.subarray(0, 6)).toString("ascii") === "GIF87a" ||
    Buffer.from(data.subarray(0, 6)).toString("ascii") === "GIF89a"
  )
    return "image/gif"
  if (
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp"
}

function fileType(data: Uint8Array): string {
  if (Buffer.from(data.subarray(0, 5)).toString("ascii") === "%PDF-") return "application/pdf"
  const image = imageType(data)
  if (image) return image
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data)
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return "text/plain"
  } catch {}
  return "application/octet-stream"
}

function mediaType(kind: MediaKind, data: Uint8Array): string {
  if (kind === "image") {
    const result = imageType(data)
    if (!result) throw new MediaError("invalid")
    return result
  }
  if (kind === "video") {
    if (data.length < 12 || Buffer.from(data.subarray(4, 8)).toString("ascii") !== "ftyp")
      throw new MediaError("invalid")
    return "video/mp4"
  }
  if (kind === "voice") return "audio/silk"
  return fileType(data)
}

export async function downloadMedia(input: {
  item: MessageItem
  fetch?: typeof fetch
  cdnBaseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<DownloadDescriptor> {
  let selected: ReturnType<typeof describe>
  try {
    selected = describe(input.item)
  } catch {
    return { kind: "file", status: "unavailable", contentType: "application/octet-stream", reason: "invalid" }
  }
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const reference = selected.reference
    if (!reference || (!reference.full_url && !reference.encrypt_query_param)) throw new MediaError("invalid")
    if (
      (reference.full_url !== undefined && typeof reference.full_url !== "string") ||
      (reference.encrypt_query_param !== undefined && typeof reference.encrypt_query_param !== "string")
    )
      throw new MediaError("invalid")
    if (selected.kind !== "image" && !selected.aes) throw new MediaError("invalid")
    const url = reference.full_url
      ? validateCdnUrl(reference.full_url)
      : fallbackUrl(input.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL, "download", reference.encrypt_query_param!)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    log.debug("download started", { kind: selected.kind })
    let response: Response
    try {
      response = await (input.fetch ?? fetch)(url, { redirect: "error", signal })
    } catch {
      throw new MediaError(timeout.aborted ? "timeout" : "network")
    }
    if (!response.ok) throw new MediaError("provider")
    const encrypted = await bounded(response, selected.aes ? MAX_MEDIA_BYTES + 16 : MAX_MEDIA_BYTES)
    if (selected.declaredCiphertext !== undefined) {
      if (
        !Number.isSafeInteger(selected.declaredCiphertext) ||
        selected.declaredCiphertext <= 0 ||
        selected.declaredCiphertext !== encrypted.length
      )
        throw new MediaError("invalid")
    }
    const data = selected.aes ? decrypt(encrypted, key(selected.aes, selected.keyFormat)) : encrypted
    if (selected.declaredPlaintext !== undefined) {
      if (
        typeof selected.declaredPlaintext !== "string" ||
        !/^\d+$/.test(selected.declaredPlaintext) ||
        Number(selected.declaredPlaintext) !== data.length
      )
        throw new MediaError("invalid")
    }
    const contentType = mediaType(selected.kind, data)
    log.info("download completed", { kind: selected.kind, size: data.length })
    return {
      kind: selected.kind,
      status: "available",
      data,
      contentType,
      ...(selected.filename ? { filename: selected.filename } : {}),
    }
  } catch (error) {
    const safe = error instanceof MediaError ? error : new MediaError(timeout.aborted ? "timeout" : "network")
    log.warn("download unavailable", { kind: selected.kind, reason: safe.reason })
    return {
      kind: selected.kind,
      status: "unavailable",
      contentType:
        "contentType" in selected && typeof selected.contentType === "string"
          ? selected.contentType
          : "application/octet-stream",
      reason: safe.reason,
      ...(selected.filename ? { filename: selected.filename } : {}),
    }
  }
}

function encrypt(input: Buffer, aes: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", aes, null)
  return Buffer.concat([cipher.update(input), cipher.final()])
}

function item(
  kind: MediaKind,
  parameter: string,
  aes: Buffer,
  raw: number,
  encrypted: number,
  filename?: string,
  voice?: { encodeType?: number; sampleRate?: number; playtime?: number },
): MessageItem {
  const media = {
    encrypt_query_param: parameter,
    aes_key: Buffer.from(aes.toString("hex")).toString("base64"),
    encrypt_type: 1,
  }
  if (kind === "image") return { type: 2, image_item: { media, mid_size: encrypted } }
  if (kind === "video") return { type: 5, video_item: { media, video_size: encrypted } }
  if (kind === "file") return { type: 4, file_item: { media, file_name: sanitizeFilename(filename), len: String(raw) } }
  return {
    type: 3,
    voice_item: {
      media,
      ...(voice?.encodeType === undefined ? {} : { encode_type: voice.encodeType }),
      ...(voice?.sampleRate === undefined ? {} : { sample_rate: voice.sampleRate }),
      ...(voice?.playtime === undefined ? {} : { playtime: voice.playtime }),
    },
  }
}

export async function uploadMedia(input: {
  kind: MediaKind
  data: Uint8Array
  toUserId: string
  api: Pick<WechatApi, "getUploadUrl">
  fetch?: typeof fetch
  cdnBaseUrl?: string
  filename?: string
  voice?: { encodeType?: number; sampleRate?: number; playtime?: number }
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<MessageItem> {
  const plaintext = Buffer.from(input.data)
  if (!["image", "video", "file", "voice"].includes(input.kind)) throw new MediaError("invalid")
  if (!plaintext.length || plaintext.length > MAX_MEDIA_BYTES || !input.toUserId) throw new MediaError("size")
  for (const value of [input.voice?.encodeType, input.voice?.sampleRate, input.voice?.playtime])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new MediaError("invalid")
  const aes = randomBytes(16)
  const filekey = randomBytes(16).toString("hex")
  const encrypted = encrypt(plaintext, aes)
  const request: UploadUrlRequest = {
    filekey,
    media_type: { image: 1, video: 2, file: 3, voice: 4 }[input.kind] as 1 | 2 | 3 | 4,
    to_user_id: input.toUserId,
    rawsize: plaintext.length,
    rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: aes.toString("hex"),
  }
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  let allocation: Awaited<ReturnType<typeof input.api.getUploadUrl>>
  try {
    allocation = await input.api.getUploadUrl(request, signal)
  } catch {
    throw new MediaError(timeout.aborted ? "timeout" : "provider")
  }
  if (
    (allocation.upload_full_url !== undefined && typeof allocation.upload_full_url !== "string") ||
    (allocation.upload_param !== undefined && typeof allocation.upload_param !== "string")
  )
    throw new MediaError("provider")
  const full = allocation.upload_full_url?.trim()
  const url = full
    ? validateCdnUrl(full)
    : allocation.upload_param
      ? fallbackUrl(input.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL, "upload", allocation.upload_param, filekey)
      : undefined
  if (!url) throw new MediaError("provider")
  let parameter: string | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await (input.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
        redirect: "error",
        signal,
      })
      if (response.status >= 400 && response.status < 500) throw new MediaError("provider")
      if (response.status !== 200) throw new MediaError("network")
      parameter = response.headers.get("x-encrypted-param") ?? undefined
      if (!parameter) throw new MediaError("network")
      break
    } catch (error) {
      if (error instanceof MediaError && error.reason === "provider") throw error
      if (attempt === 3) throw new MediaError(timeout.aborted ? "timeout" : "network")
    }
  }
  log.info("upload completed", { kind: input.kind, size: plaintext.length })
  return item(input.kind, parameter!, aes, plaintext.length, encrypted.length, input.filename, input.voice)
}

export * as WechatMedia from "./wechat-media"
