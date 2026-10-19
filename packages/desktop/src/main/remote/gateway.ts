import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { RemoteAuth, type RemoteAuthSnapshot, type RemoteDevice } from "./auth"
import { RemoteConnections } from "./connections"
import { routePolicy } from "./policy"
import { proxy } from "./proxy"
import {
  canonicalPath,
  COOKIE_NAME,
  cookies,
  digest,
  noStore,
  readJson,
  replyJson,
  requestPath,
  remoteRouteLabel,
  securityHeaders,
} from "./security"
import { isPublicAsset, serveWeb } from "./web"

export type { RemoteAuthSnapshot, RemoteDevice }
export type RemoteUpstream = { url: string; username: string; password: string }

export async function createRemoteGateway(options: {
  upstream: () => RemoteUpstream | undefined
  webRoot: string
  initialAuth?: RemoteAuthSnapshot
  saveAuth: (snapshot: RemoteAuthSnapshot) => Promise<void>
  log: (line: string) => void
  allowHttpForTests?: boolean
}): Promise<{
  url: string
  setPublicOrigin(origin: string | undefined): void
  createPairing(origin: string): Promise<{ url: string; expiresAt: number }>
  devices(): RemoteDevice[]
  revoke(id: string): Promise<void>
  reset(): Promise<void>
  close(): Promise<void>
}> {
  const auth = new RemoteAuth(options.saveAuth, options.initialAuth)
  const connections = new RemoteConnections()
  let publicOrigin: string | undefined
  let pairAttempts = 0
  let pairWindow = Date.now()
  const sockets = new Set<Socket>()
  let closePromise: Promise<void> | undefined
  const server = createServer((request, response) => {
    securityHeaders(response)
    void handle(request, response).catch(() => {
      options.log("remote-gateway request-failed")
      if (!response.headersSent) replyJson(response, 500, { error: "Request failed" })
      else response.destroy()
    })
  })
  server.requestTimeout = 120_000
  server.headersTimeout = 15_000
  server.maxHeadersCount = 100
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Remote gateway did not bind to a TCP port")
  const url = `http://127.0.0.1:${address.port}`
  options.log("remote-gateway listening loopback=true")

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url && !request.url.startsWith("/")) return replyJson(response, 400, { error: "Invalid request" })
    const path = requestPath(request)
    if (!path) return replyJson(response, 400, { error: "Invalid path" })
    const query = request.url?.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""
    const rawPath = request.url?.split("?", 1)[0] ?? ""
    if (canonicalPath(rawPath) !== path) return replyJson(response, 400, { error: "Invalid path" })

    if (path === "/remote/api/pair/redeem") return redeem(request, response)
    if (path === "/remote/api/session" && request.method === "GET") {
      noStore(response)
      const token = cookies(request).get(COOKIE_NAME)
      const device = auth.authenticate(token)
      if (!device) return replyJson(response, 401, { authenticated: false })
      return replyJson(response, 200, {
        authenticated: true,
        device,
        csrfToken: digest(`csrf:${token}`),
        capabilities: { remote: true, sse: true },
      })
    }
    if (path === "/remote/api/logout" && request.method === "POST") {
      noStore(response)
      if (!trustedWrite(request)) return replyJson(response, 403, { error: "Forbidden" })
      const token = cookies(request).get(COOKIE_NAME)
      const device = auth.authenticate(token)
      if (!device) return replyJson(response, 401, { error: "Unauthenticated" })
      if (!csrfValid(request, token)) return replyJson(response, 403, { error: "Forbidden" })
      connections.closeDevice(device.id)
      try {
        await auth.revoke(device.id)
      } catch {
        options.log("remote-gateway logout-persistence-failed device-invalidated-in-memory=true")
        response.setHeader("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`)
        return replyJson(response, 503, { error: "Logout could not be saved" })
      }
      response.setHeader("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`)
      return replyJson(response, 200, { authenticated: false })
    }

    if (path === "/remote/connect")
      return (await serveWeb(request, response, options.webRoot, path))
        ? undefined
        : replyJson(response, 404, { error: "Not found" })
    if (path.startsWith("/remote/api/")) return replyJson(response, 404, { error: "Not found" })
    if (isPublicAsset(path) && (await serveWeb(request, response, options.webRoot, path))) return

    if (request.method === "GET" && request.headers.accept?.includes("text/html") && isAppNavigation(path)) {
      noStore(response)
      const device = auth.authenticate(cookies(request).get(COOKIE_NAME))
      if (!device) return replyJson(response, 401, { error: "Unauthenticated" })
      const served = await serveWeb(request, response, options.webRoot, path, {
        allowAppShell: path === "/",
        allowNavigation: true,
      })
      if (served) return
      return replyJson(response, 404, { error: "Not found" })
    }

    const policy = routePolicy(request.method, path)
    const logRoute = `method=${(request.method ?? "UNKNOWN").replace(/[^A-Z]/g, "_").slice(0, 16)} route=${remoteRouteLabel(path)}`
    if (policy === "deny") {
      options.log(`remote-gateway request-rejected ${logRoute} reason=route-policy`)
      return replyJson(response, 403, { error: "Route not available remotely" })
    }
    const token = cookies(request).get(COOKIE_NAME)
    const device = auth.authenticate(token)
    if (!device) {
      options.log(`remote-gateway request-rejected ${logRoute} reason=authentication`)
      return replyJson(response, 401, { error: "Unauthenticated" })
    }
    if (policy === "write" && (!trustedWrite(request) || !csrfValid(request, token))) {
      options.log(`remote-gateway request-rejected ${logRoute} reason=origin-or-csrf`)
      return replyJson(response, 403, { error: "Forbidden" })
    }
    noStore(response)
    const upstream = options.upstream()
    if (!upstream) return replyJson(response, 503, { error: "Service unavailable" })
    await proxy(request, response, {
      ...upstream,
      path: path + query,
      deviceId: device.id,
      connections,
      log: options.log,
    })
  }

  async function redeem(request: IncomingMessage, response: ServerResponse): Promise<void> {
    noStore(response)
    if (request.method !== "POST") return replyJson(response, 405, { error: "Method not allowed" })
    const now = Date.now()
    if (now - pairWindow >= 60_000) {
      pairWindow = now
      pairAttempts = 0
    }
    pairAttempts += 1
    if (pairAttempts > 20) return replyJson(response, 429, { error: "Too many attempts" })
    if (!trustedWrite(request)) return replyJson(response, 403, { error: "Forbidden" })
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
      return replyJson(response, 415, { error: "JSON required" })
    let body: unknown
    try {
      body = await readJson(request)
    } catch {
      return replyJson(response, 400, { error: "Invalid request" })
    }
    if (!body || typeof body !== "object") return replyJson(response, 400, { error: "Invalid request" })
    const { code, name } = body as { code?: unknown; name?: unknown }
    if (typeof code !== "string") return replyJson(response, 400, { error: "Pairing code is invalid or expired" })
    const result = await auth.redeem(code, name)
    if (!result) return replyJson(response, 401, { error: "Pairing code is invalid or expired" })
    response.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${result.token}; Max-Age=${30 * 24 * 60 * 60}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    )
    return replyJson(response, 200, { authenticated: true, device: result.device })
  }

  function trustedWrite(request: IncomingMessage): boolean {
    return Boolean(publicOrigin && request.headers.origin === publicOrigin)
  }

  function csrfValid(request: IncomingMessage, token: string | undefined): boolean {
    const supplied = request.headers["x-opencode-csrf"]
    return Boolean(
      token && typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) && supplied === digest(`csrf:${token}`),
    )
  }

  return {
    url,
    setPublicOrigin(origin) {
      if (!origin) {
        publicOrigin = undefined
        return
      }
      try {
        const parsed = new URL(origin)
        const allowed = parsed.protocol === "https:" || (options.allowHttpForTests && parsed.protocol === "http:")
        publicOrigin =
          allowed && parsed.origin === origin && parsed.username === "" && parsed.password === ""
            ? parsed.origin
            : undefined
      } catch {
        publicOrigin = undefined
      }
    },
    async createPairing(origin) {
      const parsed = new URL(origin)
      if (
        (parsed.protocol !== "https:" && !(options.allowHttpForTests && parsed.protocol === "http:")) ||
        parsed.origin !== origin ||
        parsed.username ||
        parsed.password
      )
        throw new Error("Invalid public origin")
      const pairing = auth.createPairing()
      options.log("remote-gateway pairing-created expiresInMs=300000")
      return { url: `${origin}/remote/connect#${pairing.code}`, expiresAt: pairing.expiresAt }
    },
    devices: () => auth.devices(),
    async revoke(id) {
      connections.closeDevice(id)
      await auth.revoke(id)
      options.log("remote-gateway device-revoked")
    },
    async reset() {
      connections.closeAll()
      await auth.reset()
      options.log("remote-gateway auth-reset")
    },
    async close() {
      if (closePromise) return closePromise
      connections.closeAll()
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
        for (const socket of sockets) socket.destroy()
      }).then(() => options.log("remote-gateway closed"))
      return closePromise
    },
  }
}

function isAppNavigation(path: string): boolean {
  if (["/", "/config", "/scheduled"].includes(path)) return true
  const parts = path.split("/")
  if (parts.length < 2 || !validDirectorySegment(parts[1])) return false
  const route = parts.slice(2)
  if (route.length === 0) return true
  if (route.length === 1) return ["session", "config", "scheduled"].includes(route[0])
  if (route.length === 2 && route[0] === "session") return /^[A-Za-z0-9._~-]+$/.test(route[1])
  return route.length === 3 && route[0] === "session" && route[1] === "new" && /^[A-Za-z0-9._~-]+$/.test(route[2])
}

function validDirectorySegment(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]{2,8192}$/.test(segment)) return false
  let bytes: Buffer
  try {
    bytes = Buffer.from(segment, "base64url")
  } catch {
    return false
  }
  if (bytes.toString("base64url") !== segment) return false
  const directory = bytes.toString("utf8")
  if (!Buffer.from(directory, "utf8").equals(bytes) || /[\u0000-\u001f\u007f]/.test(directory)) return false
  const absolute =
    (directory.startsWith("/") && !directory.startsWith("//")) ||
    /^[A-Za-z]:[\\/]/.test(directory) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)
  if (!absolute) return false
  return !directory.split(/[\\/]+/).some((part) => part === "." || part === "..")
}
