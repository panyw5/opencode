import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { GptProLoginStatus } from "@opencode-ai/util/gpt-pro"
import { parseSessionCookies, type SessionCookie } from "./gpt-pro-session-cookies"
import { renderLoginPage } from "./gpt-pro-login-page"

const MAX_BYTES = 256 * 1024
const TTL_MS = 10 * 60_000
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/

type Dependencies = {
  importCookies: (cookies: SessionCookie[]) => Promise<void>
  imported: () => Promise<void>
  log: (message: string) => void
  extensionDirectory: string
  ttl?: number
}

type Connection = { server: Server; token: Buffer; port: number; timer: ReturnType<typeof setTimeout> }

export class GptProLoginServer {
  private connection?: Connection
  private state: GptProLoginStatus = { phase: "idle" }
  private starting?: Promise<string>
  private generation = 0

  constructor(private readonly deps: Dependencies) {}

  status(): GptProLoginStatus {
    return { ...this.state, extensionDirectory: this.deps.extensionDirectory }
  }

  start(): Promise<string> {
    if (this.starting) return this.starting
    if (this.connection && ["waiting", "importing"].includes(this.state.phase)) {
      return Promise.resolve(this.url(this.connection))
    }
    this.starting = this.startOnce().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async startOnce(): Promise<string> {
    const generation = ++this.generation
    this.close()
    const token = randomBytes(32)
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.writableEnded)
          this.reply(response, 500, { error: "Local connection failed. Open a new login connection in OpenCode." })
      })
    })
    server.requestTimeout = 15000
    server.headersTimeout = 10000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    const address = server.address()
    if (generation !== this.generation) {
      token.fill(0)
      server.close()
      throw new Error("Login connection was cancelled during startup.")
    }
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("Could not start the local login connection.")
    }
    const expiresAt = Date.now() + (this.deps.ttl ?? TTL_MS)
    const timer = setTimeout(() => {
      if (this.state.phase === "importing") return
      if (this.state.phase === "waiting") this.state = { ...this.state, phase: "expired" }
      this.deps.log(`login-connection expired phase=${this.state.phase}`)
      this.close()
    }, this.deps.ttl ?? TTL_MS)
    timer.unref()
    this.connection = { server, token, port: address.port, timer }
    this.state = { phase: "waiting", expiresAt }
    this.deps.log(
      `login-connection listening loopback=true expiresInMs=${this.deps.ttl ?? TTL_MS}; credentials and connection token are never logged`,
    )
    return this.url(this.connection)
  }

  cancel(): GptProLoginStatus {
    if (this.state.phase === "importing") return this.status()
    this.generation++
    this.close()
    this.state = { phase: "cancelled" }
    this.deps.log("login-connection cancelled; no browser cookies were changed")
    return this.status()
  }

  private url(connection: Connection) {
    return `http://127.0.0.1:${connection.port}/#token=${connection.token.toString("hex")}`
  }

  private close(expected?: Connection) {
    if (expected && this.connection !== expected) return
    const connection = this.connection
    this.connection = undefined
    if (!connection) return
    clearTimeout(connection.timer)
    connection.token.fill(0)
    connection.server.close()
    connection.server.closeIdleConnections()
  }

  private reply(response: ServerResponse, status: number, data: Record<string, unknown>) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    response.end(JSON.stringify(data))
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const connection = this.connection
    if (
      !connection ||
      request.headers.host !== `127.0.0.1:${connection.port}` ||
      request.socket.remoteAddress !== "127.0.0.1"
    ) {
      this.reply(response, 403, { error: "Invalid local connection." })
      return
    }
    const origin = request.headers.origin
    const isExtension = typeof origin === "string" && EXTENSION_ORIGIN.test(origin)
    const localOrigin = `http://127.0.0.1:${connection.port}`
    if (origin && !isExtension && origin !== localOrigin) {
      this.reply(response, 403, { error: "Only the local connection or approved browser extension may connect." })
      return
    }
    if (isExtension) {
      response.setHeader("Access-Control-Allow-Origin", origin)
      response.setHeader("Vary", "Origin")
    }
    if (request.method === "OPTIONS" && request.url === "/import" && isExtension) {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Cache-Control": "no-store",
      })
      response.end()
      return
    }
    if (request.method === "GET" && request.url === "/") {
      const page = renderLoginPage(request.headers["accept-language"], this.deps.extensionDirectory)
      this.deps.log(`login-connection instruction page served language=${page.language}`)
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Language": page.language,
        Vary: "Accept-Language",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      })
      response.end(page.html)
      return
    }
    if (request.method === "GET" && request.url === "/style.css") {
      response.writeHead(200, { "Content-Type": "text/css", "Cache-Control": "no-store" })
      response.end(
        "body{margin:0;background:radial-gradient(ellipse at top right,#dde7d9,transparent 60%),#faf7f0;color:#242b24;font:18px/1.65 Georgia,serif}main{max-width:760px;margin:8vh auto;padding:32px}h1{font-size:44px;line-height:1.2}.eyebrow{font-size:13px;letter-spacing:.12em;color:#526652}li{margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf0e7;padding:16px;font:14px/1.5 monospace}a{color:#254c36}.note{border-top:1px solid #b8c3b5;padding-top:20px;font-size:14px}@media(max-width:600px){main{margin:0;padding:24px}h1{font-size:32px}}",
      )
      return
    }
    if (request.method !== "POST" || request.url !== "/import") {
      this.reply(response, 404, { error: "Not found." })
      return
    }
    const authorization = request.headers.authorization
    const match = typeof authorization === "string" ? /^Bearer ([a-f0-9]{64})$/.exec(authorization) : null
    if (!match || !timingSafeEqual(Buffer.from(match[1], "hex"), connection.token)) {
      this.deps.log("login-connection rejected invalid authorization; no credentials parsed")
      this.reply(response, 403, { error: "Connection authorization failed. Open a new connection from OpenCode." })
      return
    }
    if (this.state.expiresAt === undefined || Date.now() >= this.state.expiresAt) {
      this.reply(response, 410, { error: "Connection expired." })
      return
    }
    if (this.state.phase !== "waiting") {
      this.reply(response, 409, { error: "This connection is already in use. Check the import status in OpenCode." })
      return
    }
    if (
      request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
      Number(request.headers["content-length"] ?? 0) > MAX_BYTES
    ) {
      this.reply(response, 400, { error: "Invalid session payload." })
      return
    }
    this.state = { ...this.state, phase: "importing" }
    const chunks: Buffer[] = []
    let body: Buffer | undefined
    try {
      let size = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_BYTES) {
          buffer.fill(0)
          throw new Error("Payload too large")
        }
        chunks.push(buffer)
      }
      if (Date.now() >= this.state.expiresAt!) throw new Error("Connection expired")
      body = Buffer.concat(chunks)
      let cookies: SessionCookie[]
      try {
        cookies = parseSessionCookies(JSON.parse(body.toString("utf8")))
      } catch {
        this.deps.log("login-connection rejected invalid cookie scope or payload; nothing imported")
        throw new Error("The session payload is invalid or contains unsupported cookies. No cookies were imported.")
      }
      await this.deps.importCookies(cookies)
      this.deps.log(
        `login-connection import finished count=${cookies.length}; authentication must be checked in the embedded page`,
      )
      try {
        await this.deps.imported()
      } catch {
        this.state = {
          ...this.state,
          error: "Session imported, but the dedicated page could not be opened. Open gpt-pro to verify login.",
        }
        this.deps.log("login-connection page reopening failed; no credential details logged")
      }
      this.state = { ...this.state, phase: "imported", importedCookies: cookies.length }
      this.reply(response, 200, this.status())
    } catch {
      this.state = {
        ...this.state,
        phase: "failed",
        error:
          "Session import failed. No success is assumed; check the dedicated browser or start a new login connection.",
      }
      this.deps.log("login-connection import failed; request body, token, and cookie values are omitted")
      this.reply(response, 400, { error: this.state.error })
    } finally {
      body?.fill(0)
      for (const chunk of chunks) chunk.fill(0)
      response.once("finish", () => this.close(connection))
      // finish may already have fired when a mocked response completes synchronously.
      if (response.writableFinished) this.close(connection)
    }
  }
}
