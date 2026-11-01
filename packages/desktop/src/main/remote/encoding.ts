import type { IncomingMessage, ServerResponse } from "node:http"
import { gzipSync } from "node:zlib"

export function acceptsGzip(header: string | undefined) {
  const values = new Map(
    (header ?? "").split(",").map((part) => {
      const [name, ...parameters] = part.trim().toLowerCase().split(";")
      const quality = parameters
        .find((value) => value.trim().startsWith("q="))
        ?.trim()
        .slice(2)
      const value = quality === undefined ? 1 : Number(quality)
      return [name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0] as const
    }),
  )
  return (values.get("gzip") ?? values.get("*") ?? 0) > 0
}

/** Only use for public assets or already-redacted JSON, never auth responses or SSE. */
export function endEncodedBody(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer | string,
  log?: (line: string) => void,
) {
  const source = typeof body === "string" ? Buffer.from(body) : body
  const vary = String(response.getHeader("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (!vary.some((value) => value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding")
  response.setHeader("Vary", vary.join(", "))
  const compressed =
    source.length >= 1024 && acceptsGzip(request.headers["accept-encoding"]) ? gzipSync(source) : undefined
  const gzip = compressed && compressed.length < source.length ? compressed : undefined
  const output = gzip ?? source
  if (gzip) response.setHeader("Content-Encoding", "gzip")
  response.setHeader("Content-Length", output.length)
  log?.(
    `[remote-encoding] response encoding=${gzip ? "gzip" : "identity"} inputBytes=${source.length} outputBytes=${output.length}`,
  )
  response.end(request.method === "HEAD" ? undefined : output)
}
