import { createHash, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { request } from "node:https"
import { isIP } from "node:net"

const MAX_BYTES = 100 * 1024 * 1024
const TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 3

export type DownloadLimits = {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

export type DownloadAddress = { address: string; family: 4 | 6 }
export type DownloadResponse = {
  status: number
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
  /** Raw HTTP entity bytes: transports must not transparently decompress the body. */
  body: AsyncIterable<Uint8Array>
  cancel?: () => void
}

/** Trusted dependency injection for tests, never derived from an extension manifest or request payload. */
export type DownloadTransport = {
  lookup: (hostname: string, signal: AbortSignal) => Promise<readonly DownloadAddress[]>
  request: (input: { url: URL; address: string; family: 4 | 6; signal: AbortSignal }) => Promise<DownloadResponse>
}

export type DownloadOptions = {
  url: string
  /** Reserved for callers' staging context; downloading itself never writes to disk. */
  directory?: string
  signal?: AbortSignal
  limits?: DownloadLimits
  transport?: DownloadTransport
}

type FailureCode =
  | "url"
  | "address"
  | "network"
  | "redirect"
  | "status"
  | "size"
  | "integrity"
  | "aborted"
  | "timeout"
  | "file"
  | "limits"

export class ArchiveDownloadError extends Error {
  override readonly name: string = "ArchiveDownloadError"
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message)
    if (code === "aborted") this.name = "AbortError"
    if (code === "timeout") this.name = "TimeoutError"
  }
}

function fail(code: FailureCode, message: string): never {
  throw new ArchiveDownloadError(code, message)
}

function limit(value: number | undefined, fallback: number, minimum: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > fallback)
    fail("limits", "Invalid extension archive download limit")
  return value
}

function operation(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(new ArchiveDownloadError("aborted", "Extension archive operation aborted"))
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new ArchiveDownloadError("timeout", "Extension archive operation timed out")),
    timeoutMs,
  )
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

function check(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    // Observe even an already-aborted operation's promise to prevent a late unhandled rejection.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function ipv6Words(address: string) {
  if (address.includes(".") || address.includes("%")) return
  const parts = address.split("::")
  if (parts.length > 2) return
  const left = parts[0] ? parts[0].split(":") : []
  const right = parts[1] ? parts[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (parts.length === 1 && missing !== 0) return
  if (parts.length === 2 && missing < 1) return
  return [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16))
}

/** Permit globally routable unicast only, including when DNS returns several answers. */
function publicAddress(address: string, family: number): address is string {
  if ((family !== 4 && family !== 6) || isIP(address) !== family) return false
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      // Azure's virtual platform/metadata endpoint is not in an RFC1918 range.
      address === "168.63.129.16"
    )
  }
  const words = ipv6Words(address)
  if (!words || words[0] < 0x2000 || words[0] > 0x3fff) return false
  // Exclude transition/tunnel, protocol-assignment and documentation ranges.
  return !(
    (words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) ||
    words[0] === 0x2002 ||
    (words[0] === 0x3fff && words[1] <= 0x0fff)
  )
}

function parseURL(input: string, base?: URL) {
  // WHATWG URL canonicalizes backslashes, encoded hosts and unusual numeric IPv4 forms.
  // Reject those spellings before parsing, rather than accidentally accepting a rewritten host.
  if (typeof input !== "string" || input.length > 16_384 || /[\s\\\u0000-\u001f\u007f]/.test(input))
    fail("url", "Invalid extension archive HTTPS URL")
  if ((!base || /^[a-z][a-z\d+.-]*:/i.test(input)) && !/^https:\/\//i.test(input))
    fail("url", "Extension archive URL must use an explicit HTTPS authority")
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    return fail("url", "Invalid extension archive HTTPS URL")
  }
  if (url.protocol !== "https:" || url.username || url.password)
    fail("url", "Extension archive URL must use HTTPS without credentials")
  const authority = input.match(/^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/i)?.[1]
  if (authority !== undefined) {
    if (authority.includes("@") || authority.includes("%")) fail("url", "Invalid extension archive URL authority")
    const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]
    if (!rawHost) fail("url", "Invalid extension archive URL authority")
    if (isIP(url.hostname) === 4 && rawHost.toLowerCase() !== url.hostname)
      fail("url", "Encoded extension archive IP addresses are not allowed")
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (!hostname || hostname.includes("%")) fail("url", "Invalid extension archive hostname")
  const family = isIP(hostname)
  if (family && !publicAddress(hostname, family)) fail("address", "Extension archive address is not publicly routable")
  const name = hostname.toLowerCase().replace(/\.$/, "")
  if (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "localhost.localdomain" ||
    name.endsWith(".local")
  )
    fail("address", "Extension archive hostname is not publicly routable")
  url.hash = ""
  return url
}

const network: DownloadTransport = {
  async lookup(hostname) {
    return lookup(hostname, { all: true, verbatim: true }) as Promise<DownloadAddress[]>
  },
  request({ url, address, family, signal }) {
    return new Promise((resolve, reject) => {
      check(signal)
      const req = request(url, {
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        // Keep URL host/SNI/certificate validation, but never resolve the host again at connect time.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family }])
          else callback(null, address, family)
        },
        headers: { "accept-encoding": "identity" },
      })
      const abort = () => req.destroy(new ArchiveDownloadError("aborted", "Extension archive request aborted"))
      signal.addEventListener("abort", abort, { once: true })
      req.once("close", () => signal.removeEventListener("abort", abort))
      req.on("error", reject)
      req.once("response", (res) =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          cancel: () => res.destroy(),
        }),
      )
      req.end()
    })
  },
}

function header(response: DownloadResponse, name: string) {
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1]
  if (entry === undefined) return
  if (typeof entry === "string") return entry
  if (entry.length !== 1) fail("network", "Invalid extension archive response headers")
  return entry[0]
}

function cancel(response: DownloadResponse) {
  try {
    response.cancel?.()
  } catch {
    // Cleanup must not expose transport errors (which may contain credentials or URL tokens).
  }
}

async function readBytes(body: AsyncIterable<Uint8Array>, signal: AbortSignal, maxBytes: number) {
  const iterator = body[Symbol.asyncIterator]()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      check(signal)
      const next = await abortable(Promise.resolve(iterator.next()), signal)
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) fail("network", "Invalid extension archive response bytes")
      size += next.value.byteLength
      if (size > maxBytes) fail("size", "Extension archive exceeds the compressed byte limit")
      chunks.push(Buffer.from(next.value))
    }
    check(signal)
    return Buffer.concat(chunks, size)
  } finally {
    // Do not await an uncooperative iterator: a pending next() must not defeat timeout/abort.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {})
    } catch {}
  }
}

type Digest = { algorithm: "sha256" | "sha384" | "sha512"; values: Buffer[] }

function sha256(value: string): Digest {
  if (typeof value !== "string" || !/^[\da-f]{64}$/i.test(value))
    fail("integrity", "Extension archive requires a 64-character hexadecimal SHA-256")
  return { algorithm: "sha256", values: [Buffer.from(value, "hex")] }
}

function sri(value: string): Digest {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384)
    fail("integrity", "Extension package requires SHA-256, SHA-384 or SHA-512 integrity")
  const digests = value
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const match = /^(sha256|sha384|sha512)-([A-Za-z\d+/]+={0,2})$/.exec(entry)
      if (!match) fail("integrity", "Invalid extension package integrity")
      const algorithm = match[1] as Digest["algorithm"]
      const bytes = Buffer.from(match[2], "base64")
      const length = { sha256: 32, sha384: 48, sha512: 64 }[algorithm]
      if (bytes.length !== length || bytes.toString("base64") !== match[2])
        fail("integrity", "Invalid extension package integrity")
      return { algorithm, bytes }
    })
  const algorithm = digests.some((item) => item.algorithm === "sha512")
    ? "sha512"
    : digests.some((item) => item.algorithm === "sha384")
      ? "sha384"
      : "sha256"
  return { algorithm, values: digests.filter((item) => item.algorithm === algorithm).map((item) => item.bytes) }
}

function verify(bytes: Buffer, digest: Digest) {
  const actual = createHash(digest.algorithm).update(bytes).digest()
  // Evaluate every same-length digest, without a data-dependent byte comparison.
  let matched = 0
  for (const expected of digest.values) matched |= Number(timingSafeEqual(actual, expected))
  if (!matched) fail("integrity", "Extension archive integrity mismatch")
  return bytes
}

async function download(input: DownloadOptions, digest?: Digest): Promise<Uint8Array> {
  const maxBytes = limit(input.limits?.maxBytes, MAX_BYTES, 0)
  const timeoutMs = limit(input.limits?.timeoutMs, TIMEOUT_MS, 1)
  const maxRedirects = limit(input.limits?.maxRedirects, MAX_REDIRECTS, 0)
  let url = parseURL(input.url)
  const op = operation(input.signal, timeoutMs)
  const transport = input.transport ?? network
  try {
    for (let redirects = 0; ; redirects++) {
      check(op.signal)
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      const family = isIP(hostname)
      const addresses = family
        ? [{ address: hostname, family: family as 4 | 6 }]
        : await abortable(transport.lookup(hostname, op.signal), op.signal)
      if (!addresses.length || addresses.some((item) => !publicAddress(item.address, item.family)))
        fail("address", "Extension archive DNS returned a non-public address")
      check(op.signal)
      // Pin exactly one validated answer. Do not pass an unvalidated hostname to another resolver.
      const response = await abortable(
        transport.request({ url, ...addresses[0], signal: op.signal }).then((response) => {
          if (op.signal.aborted) {
            cancel(response)
            check(op.signal)
          }
          return response
        }),
        op.signal,
      )
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects >= maxRedirects) fail("redirect", "Extension archive redirect limit exceeded")
          const location = header(response, "location")
          if (!location) fail("redirect", "Extension archive redirect is missing its location")
          url = parseURL(location, url)
          continue
        }
        if (response.status !== 200) fail("status", "Extension archive server returned an unsuccessful status")
        const length = header(response, "content-length")
        if (length !== undefined) {
          if (!/^\d+$/.test(length)) fail("network", "Invalid extension archive content length")
          if (Number(length) > maxBytes) fail("size", "Extension archive exceeds the compressed byte limit")
        }
        const bytes = await readBytes(response.body, op.signal, maxBytes)
        return digest ? verify(bytes, digest) : bytes
      } finally {
        cancel(response)
      }
    }
  } catch (error) {
    if (op.signal.aborted) throw op.signal.reason
    if (error instanceof ArchiveDownloadError) throw error
    // Never forward transport/DNS/stream error messages or causes, which may embed signed URLs.
    return fail("network", "Extension archive download failed")
  } finally {
    op.dispose()
  }
}

export async function downloadArchive(input: DownloadOptions & { sha256: string }): Promise<Uint8Array> {
  return download(input, sha256(input.sha256))
}

export async function downloadPackage(input: DownloadOptions & { integrity: string }): Promise<Uint8Array> {
  return download(input, sri(input.integrity))
}

export type RequestJsonOptions = {
  signal?: AbortSignal
  maxBytes?: number
  transport?: DownloadTransport
}

async function readJsonDocument(url: string, options: RequestJsonOptions) {
  const maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, 0)
  const bytes = await download({
    url,
    signal: options.signal,
    transport: options.transport,
    limits: { maxBytes: options.maxBytes === undefined ? 4 * 1024 * 1024 : maxBytes },
  })
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return { value, bytes }
  } catch {
    return fail("network", "Invalid extension package metadata JSON")
  }
}

export async function requestJson(url: string, options: RequestJsonOptions = {}): Promise<unknown> {
  return (await readJsonDocument(url, options)).value
}

/** Hash the exact HTTP entity bytes, not the parsed or reserialized JSON document. */
export async function requestJsonDocument(
  url: string,
  options: RequestJsonOptions = {},
): Promise<{ value: unknown; sha256: string }> {
  const { value, bytes } = await readJsonDocument(url, options)
  return { value, sha256: createHash("sha256").update(bytes).digest("hex") }
}

export async function readLocalArchive(input: {
  file: string
  sha256: string
  signal?: AbortSignal
  maxBytes?: number
}): Promise<Uint8Array> {
  const digest = sha256(input.sha256)
  const maxBytes = limit(input.maxBytes, MAX_BYTES, 0)
  const op = operation(input.signal, TIMEOUT_MS)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let stream: ReturnType<NonNullable<typeof file>["createReadStream"]> | undefined
  try {
    check(op.signal)
    const handle = await abortable(
      open(input.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).then(async (file) => {
        if (op.signal.aborted) {
          await file.close()
          check(op.signal)
        }
        return file
      }),
      op.signal,
    )
    file = handle
    const stat = await abortable(handle.stat(), op.signal)
    if (!stat.isFile()) fail("file", "Extension archive must be a regular local file")
    if (stat.size > maxBytes) fail("size", "Extension archive exceeds the compressed byte limit")
    stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })
    return verify(await readBytes(stream, op.signal, maxBytes), digest)
  } catch (error) {
    if (op.signal.aborted) throw op.signal.reason
    if (error instanceof ArchiveDownloadError) throw error
    return fail("file", "Could not read extension archive file")
  } finally {
    stream?.destroy()
    await file?.close().catch(() => {})
    op.dispose()
  }
}

export const copyLocalArchive = readLocalArchive
export * as ExtensionDownload from "./download"
