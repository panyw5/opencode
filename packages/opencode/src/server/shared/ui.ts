import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Effect, Layer, Stream } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"
import { PUBLIC_UI_PATHS } from "./public-ui"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

export class EmbeddedWebUI extends Context.Service<
  EmbeddedWebUI,
  {
    readonly manifest: Effect.Effect<Record<string, string> | null>
  }
>()("@opencode/EmbeddedWebUI") {}

export const embeddedWebUILayer = Layer.effect(
  EmbeddedWebUI,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return EmbeddedWebUI.of({ manifest: Effect.promise(() => embeddedUI(flags.disableEmbeddedWebUi)) })
  }),
)

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const key = requestPath.replace(/^\//, "")
  const exact = Object.hasOwn(embeddedWebUI, key) ? embeddedWebUI[key] : undefined
  // Public manifest/icon requests must never receive an authenticated SPA shell.
  if (PUBLIC_UI_PATHS.has(requestPath) && !exact) return Effect.succeed(notFound())
  const file = exact ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: AppFileSystem.Interface
    client: HttpClient.HttpClient
    disableEmbeddedWebUi: boolean
    embedded?: { readonly manifest: Effect.Effect<Record<string, string> | null> }
  },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = services.disableEmbeddedWebUi
      ? null
      : yield* services.embedded?.manifest ?? Effect.promise(() => embeddedUI(false))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    const upstreamHeaders = ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host })
    // These credentials authorize this server, not the remote UI distributor.
    for (const name of ["authorization", "cookie", "referer"]) upstreamHeaders.delete(name)
    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: upstreamHeaders,
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
