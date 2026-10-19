import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { Transform, type TransformCallback } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"
import type { RemoteConnections } from "./connections"
import { MAX_UPLOAD_BYTES, remoteRouteLabel } from "./security"
import { redactSensitive } from "./policy"

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "authorization",
  "origin",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-opencode-csrf",
])
const GATEWAY_SECURITY = new Set([
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
])
const CORS_HEADERS = new Set([
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
])
const MAX_REDACTED_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024

export class RemoteUploadLimit {
  private total = 0

  constructor(private readonly limit = MAX_UPLOAD_BYTES) {}

  consume(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false
    this.total += bytes
    return this.total <= this.limit
  }
}

function configEvent(frame: string): string {
  const lines = frame.split(/\r\n|\n|\r/)
  const dataIndexes = lines.flatMap((line, index) => (line.startsWith("data:") ? [index] : []))
  if (dataIndexes.length === 0) return frame
  const data = dataIndexes.map((index) => lines[index].slice(5).replace(/^ /, "")).join("\n")
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return /global\.config\.updated/.test(data) ? "" : frame
  }
  if (!event || typeof event !== "object") return frame
  const root = event as Record<string, unknown>
  const payload = root.payload && typeof root.payload === "object" ? (root.payload as Record<string, unknown>) : root
  if (payload.type !== "global.config.updated") return frame
  if (!payload.properties || typeof payload.properties !== "object") return ""
  payload.properties = redactSensitive(payload.properties, "config")
  const firstData = dataIndexes[0]
  const output = lines.filter((_, index) => !dataIndexes.includes(index))
  output.splice(Math.min(firstData, output.length), 0, `data: ${JSON.stringify(root)}`)
  return output.join("\n")
}

export class RemoteEventRedactor extends Transform {
  private readonly decoder = new StringDecoder("utf8")
  private pending = ""
  private readonly separator = /\r\n\r\n|\n\n|\r\r/

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk)
    if (Buffer.byteLength(this.pending, "utf8") > MAX_SSE_FRAME_BYTES && !this.separator.test(this.pending)) {
      callback(new Error("SSE frame exceeds gateway limit"))
      return
    }
    let match: RegExpExecArray | null
    while ((match = this.separator.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index)
      const delimiter = match[0]
      this.pending = this.pending.slice(match.index + delimiter.length)
      if (Buffer.byteLength(frame, "utf8") > MAX_SSE_FRAME_BYTES) {
        callback(new Error("SSE frame exceeds gateway limit"))
        return
      }
      const filtered = configEvent(frame)
      if (filtered) this.push(filtered + delimiter)
      this.separator.lastIndex = 0
    }
    if (Buffer.byteLength(this.pending, "utf8") > MAX_SSE_FRAME_BYTES)
      callback(new Error("SSE frame exceeds gateway limit"))
    else callback()
  }

  _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end()
    const filtered = configEvent(this.pending)
    if (filtered) this.push(filtered)
    this.pending = ""
    callback()
  }
}

function loopback(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1")
  )
}

function invalidContentLength(request: IncomingMessage): boolean {
  const values = request.rawHeaders.filter(
    (_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "content-length",
  )
  if (values.length > 1) return true
  const transferEncoding = request.headers["transfer-encoding"]
  const contentLength = request.headers["content-length"]
  if (transferEncoding && contentLength !== undefined) return true
  if (contentLength === undefined) return false
  return (
    !/^\d+$/.test(contentLength) ||
    !Number.isSafeInteger(Number(contentLength)) ||
    Number(contentLength) > MAX_UPLOAD_BYTES
  )
}

function decodeResponse(body: Buffer, encoding: string | undefined, limit: number): Buffer {
  if (!encoding || encoding === "identity") return body
  if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(body, { maxOutputLength: limit })
  if (encoding === "deflate") return inflateSync(body, { maxOutputLength: limit })
  if (encoding === "br") return brotliDecompressSync(body, { maxOutputLength: limit })
  throw new Error("unsupported-content-encoding")
}

export async function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    url: string
    username: string
    password: string
    path: string
    deviceId: string
    connections: RemoteConnections
    log?: (line: string) => void
  },
): Promise<void> {
  let base: URL
  try {
    base = new URL(input.url)
  } catch {
    response.statusCode = 503
    response.end("Service unavailable")
    return
  }
  if (!loopback(base)) {
    response.statusCode = 503
    response.end("Service unavailable")
    return
  }
  if (invalidContentLength(request)) {
    response.statusCode = 413
    response.end("Payload too large")
    return
  }
  let target: URL
  try {
    target = new URL(input.path, base)
  } catch {
    response.statusCode = 400
    response.end("Invalid request")
    return
  }
  if (target.origin !== base.origin || !target.pathname.startsWith("/")) {
    response.statusCode = 400
    response.end("Invalid request")
    return
  }
  target.searchParams.delete("auth_token")
  const redactionPath = target.pathname
  const shouldRedact = ["/config", "/global/config", "/provider", "/config/providers"].includes(redactionPath)
  const catalog = redactionPath === "/provider" || redactionPath === "/config/providers"
  const responseLimit = catalog ? MAX_CATALOG_RESPONSE_BYTES : MAX_REDACTED_RESPONSE_BYTES
  const log = (stage: string, fields = "") =>
    input.log?.(`remote-proxy ${stage} route=${remoteRouteLabel(redactionPath)} ${fields}`.trim())
  log("request-start", `method=${request.method ?? "unknown"}`)
  const headers: Record<string, string | string[]> = {}
  const connectionHeaders = new Set(
    (request.headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase()
    if (
      value === undefined ||
      HOP.has(lower) ||
      connectionHeaders.has(lower) ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("proxy-") ||
      lower.startsWith("sec-websocket-")
    )
      continue
    headers[key] = value
  }
  if (shouldRedact || redactionPath === "/global/event") headers["accept-encoding"] = "identity"
  headers.authorization = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`
  headers.host = base.host

  let failed = false
  const fail = (status: number, message: string, reason = "upstream-unavailable") => {
    if (failed || response.destroyed || response.writableEnded) return
    failed = true
    log("request-failed", `status=${status} reason=${reason}`)
    if (response.headersSent) response.destroy()
    else {
      response.removeHeader("content-length")
      response.removeHeader("content-encoding")
      response.removeHeader("etag")
      response.setHeader("Content-Type", "text/plain; charset=utf-8")
      response.statusCode = status
      response.end(message)
    }
  }
  const cleanup = input.connections.track(input.deviceId, response, () => upstream.destroy())
  const upstream = httpRequest(target, { method: request.method, headers, timeout: 0 }, (upstreamResponse) => {
    if (response.destroyed) return upstreamResponse.destroy()
    upstreamResponse.on("error", () => fail(502, "Upstream unavailable"))
    upstreamResponse.on("aborted", () => fail(502, "Upstream unavailable"))
    response.statusCode = upstreamResponse.statusCode ?? 502
    const responseConnectionHeaders = new Set(
      String(upstreamResponse.headers.connection ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    )
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      const lower = key.toLowerCase()
      if (
        value === undefined ||
        HOP.has(lower) ||
        responseConnectionHeaders.has(lower) ||
        lower.startsWith("x-forwarded-") ||
        lower.startsWith("proxy-") ||
        lower === "set-cookie" ||
        lower === "server" ||
        lower === "via" ||
        lower === "x-powered-by" ||
        GATEWAY_SECURITY.has(lower) ||
        CORS_HEADERS.has(lower)
      )
        continue
      if (lower === "location" && typeof value === "string") {
        try {
          const redirect = new URL(value, base)
          if (redirect.origin !== base.origin) continue
          response.setHeader(key, `${redirect.pathname}${redirect.search}${redirect.hash}`)
        } catch {
          continue
        }
      } else if (
        lower !== "content-location" &&
        lower !== "link" &&
        lower !== "refresh" &&
        lower !== "www-authenticate"
      )
        response.setHeader(key, value)
    }
    const type = String(upstreamResponse.headers["content-type"] ?? "")
    log(
      "response-start",
      `status=${upstreamResponse.statusCode ?? 502} bytes=${upstreamResponse.headers["content-length"] ?? "streamed"}`,
    )
    response.setHeader(
      "Cache-Control",
      type.includes("text/event-stream") ? "no-store, no-cache, no-transform" : "no-store",
    )
    if (redactionPath === "/global/event" && type.toLowerCase().includes("text/event-stream")) {
      if (upstreamResponse.headers["content-encoding"] && upstreamResponse.headers["content-encoding"] !== "identity") {
        upstreamResponse.resume()
        fail(502, "Invalid upstream response")
        return
      }
      const redactor = new RemoteEventRedactor()
      redactor.on("error", () => {
        upstreamResponse.destroy()
        response.destroy()
      })
      upstreamResponse.pipe(redactor).pipe(response)
      return
    }
    if (
      shouldRedact &&
      (upstreamResponse.statusCode ?? 500) >= 200 &&
      (upstreamResponse.statusCode ?? 500) < 300 &&
      !/(?:application\/json|\+json)/i.test(type)
    ) {
      upstreamResponse.resume()
      fail(502, "Invalid upstream response")
      return
    }
    if (!shouldRedact || !/(?:application\/json|\+json)/i.test(type)) {
      upstreamResponse.pipe(response)
      return
    }
    const declaredLength = Number(upstreamResponse.headers["content-length"])
    if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
      log("response-limit", `stage=headers bytes=${declaredLength} limit=${responseLimit}`)
      fail(502, "Upstream response exceeds remote gateway limit", "response-size-limit")
      upstreamResponse.destroy()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    upstreamResponse.on("data", (chunk: Buffer | string) => {
      if (failed) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > responseLimit) {
        log("response-limit", `stage=encoded bytes=${size} limit=${responseLimit}`)
        fail(502, "Upstream response exceeds remote gateway limit", "response-size-limit")
        upstreamResponse.destroy()
        return
      }
      chunks.push(buffer)
    })
    upstreamResponse.on("end", () => {
      if (failed) return
      try {
        const decoded = decodeResponse(
          Buffer.concat(chunks),
          String(upstreamResponse.headers["content-encoding"] ?? "").toLowerCase(),
          responseLimit,
        )
        const mode = catalog ? "catalog" : "config"
        const data = redactSensitive(JSON.parse(decoded.toString("utf8")), mode)
        const body = JSON.stringify(data)
        log("response-redacted", `inputBytes=${decoded.length} outputBytes=${Buffer.byteLength(body)} mode=${mode}`)
        response.removeHeader("content-length")
        response.removeHeader("content-encoding")
        response.removeHeader("etag")
        response.setHeader("Content-Type", "application/json; charset=utf-8")
        response.end(body)
      } catch {
        log("response-invalid", `encodedBytes=${size} limit=${responseLimit}`)
        fail(502, "Invalid upstream response", "invalid-json-or-encoding")
      }
    })
  })
  const upload = new RemoteUploadLimit()
  request.on("data", (chunk: Buffer | string) => {
    if (failed) return
    if (!upload.consume(Buffer.byteLength(chunk))) {
      request.unpipe(upstream)
      upstream.destroy()
      fail(413, "Payload too large")
      request.resume()
    }
  })
  request.on("aborted", () => upstream.destroy())
  request.on("error", () => upstream.destroy())
  response.on("close", () => {
    cleanup()
    upstream.destroy()
  })
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    log("upstream-error", `code=${error.code?.replace(/[^A-Z0-9_]/gi, "") ?? "unknown"}`)
    fail(502, "Upstream unavailable")
  })
  if (request.method === "GET" || request.method === "HEAD") upstream.end()
  else request.pipe(upstream)
}
