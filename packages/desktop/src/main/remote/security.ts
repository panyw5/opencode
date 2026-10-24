import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

export const COOKIE_NAME = "__Host-opencode-remote"
export const MAX_JSON_BYTES = 16 * 1024
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

export function remoteRouteLabel(path: string): string {
  // Keep worker diagnostics within the controller's safe token-only log format.
  return path.slice(0, 180).replace(/[^A-Za-z0-9_.-]/g, "_")
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>()
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index < 1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key && !result.has(key)) result.set(key, value)
  }
  return result
}

export function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("X-Frame-Options", "DENY")
  response.setHeader("Referrer-Policy", "no-referrer")
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  )
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

export function noStore(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("Pragma", "no-cache")
}

export function replyJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.end(JSON.stringify(value))
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers["content-length"]
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES))
    throw new Error("body-too-large")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BYTES) throw new Error("body-too-large")
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new Error("invalid-json")
  }
}

export function canonicalPath(raw: string): string | undefined {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#")) return
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  )
    return
  if (encodeURI(decoded).replace(/%25([0-9a-f]{2})/gi, "%$1") !== raw.split("?")[0]) return
  return decoded
}

export function requestPath(request: IncomingMessage): string | undefined {
  const url = request.url ?? ""
  if (!url.startsWith("/") || url.startsWith("//")) return
  const path = url.split("?", 1)[0]
  return canonicalPath(path)
}
