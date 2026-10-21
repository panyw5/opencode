// Build with Bun (target=node, external=electron), then run in the development
// Electron binary. Only the worker and web assets under test come from the app.
import { app, utilityProcess } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import * as http from "node:http"
import * as tls from "node:tls"

async function main() {
  console.error("[packaged-remote] host-entry")
  const [inputFile, resources] = process.argv.slice(2)
  if (!inputFile || !resources) throw new Error("Expected private fixture metadata and packaged Resources directory")
  const fixture = JSON.parse(await readFile(inputFile, "utf8")) as {
    upstream: { url: string; username: string; password: string }
    project: string
    permission: boolean
    config?: Record<string, unknown>
  }
  const artifacts = dirname(inputFile)
  app.setPath("userData", join(artifacts, "package-worker-electron"))
  app.commandLine.appendSwitch("disable-gpu")
  console.error("[packaged-remote] waiting-for-electron")
  await app.whenReady()
  console.error("[packaged-remote] electron-ready")
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])])
  Reflect.get(http, "setGlobalProxyFromEnv")?.call(http)

  let stopNodeSidecar: (() => Promise<void>) | undefined
  let upstream = fixture.upstream
  if (process.argv.includes("--node-sidecar")) {
    const configResponse = await fetch(
      `${fixture.upstream.url}/config?directory=${encodeURIComponent(fixture.project)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${fixture.upstream.username}:${fixture.upstream.password}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!configResponse.ok) throw new Error("Cannot load isolated provider fixture config")
    const config = {
      ...(fixture.config ?? (await configResponse.json())),
      // Config response encoders can reorder object keys. Permission rules are
      // last-match-wins, so construct this isolated policy in its original order.
      permission: fixture.permission ? { "*": "deny", bash: "ask" } : { "*": "deny" },
    }
    console.error(`[packaged-remote] isolated-policy denyAll=true bash=${fixture.permission ? "ask" : "deny"}`)
    const root = join(artifacts, "packaged-node-sidecar")
    await mkdir(root, { recursive: true })
    const reserve = createServer()
    await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve))
    const address = reserve.address()
    if (!address || typeof address === "string") throw new Error("Node sidecar has no reserved port")
    const port = address.port
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    const output = createWriteStream(join(root, "sidecar.log"), { mode: 0o600 })
    const node = utilityProcess.fork(join(resources, "app.asar", "out/main/sidecar.js"), [], {
      cwd: fixture.project,
      stdio: "pipe",
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_DB: join(root, "sidecar.db"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: join(root, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_PURE: "true",
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
    })
    for (const stream of [node.stdout, node.stderr]) stream?.on("data", (chunk) => output.write(chunk))
    stopNodeSidecar = async () => {
      const exited = new Promise<void>((resolve) => node.once("exit", () => resolve()))
      node.postMessage({ type: "stop" })
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      node.kill()
      output.end()
      console.error("[packaged-remote] packaged Node sidecar stopped")
    }
    console.error("[packaged-remote] starting packaged Node sidecar with isolated provider and database")
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Packaged Node sidecar startup timed out")), 90_000)
        node.on("message", (message) => {
          if (message.type === "ready") {
            clearTimeout(timer)
            resolve()
          }
          if (message.type === "error") {
            clearTimeout(timer)
            reject(new Error(`Packaged Node sidecar failed: ${message.error?.message ?? "unknown"}`))
          }
        })
        node.once("exit", (code) => {
          clearTimeout(timer)
          reject(new Error(`Packaged Node sidecar exited: ${code}`))
        })
        node.postMessage({
          type: "start",
          hostname: "127.0.0.1",
          port,
          password: fixture.upstream.password,
          needsMigration: true,
        })
      })
    } catch (error) {
      node.kill()
      output.end()
      throw error
    }
    upstream = { ...fixture.upstream, url: `http://127.0.0.1:${port}` }
    console.error("[packaged-remote] packaged Node sidecar ready")
  }

  const worker = utilityProcess.fork(join(resources, "app.asar", "out/main/remote-worker.js"), [], { stdio: "pipe" })
  const pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  let closing = false
  worker.stdout?.on("data", (chunk) => console.error(`[packaged-remote] worker-stdout bytes=${chunk.length}`))
  worker.stderr?.on("data", (chunk) => console.error(`[packaged-remote] worker-stderr bytes=${chunk.length}`))
  worker.on("message", (message) => {
    if (message.type === "store-write") {
      worker.postMessage({ type: "store-result", id: message.id, ok: true })
      console.error(`[packaged-remote] isolated-store-write store=${message.store}`)
    } else if (message.type === "log") {
      console.error(`[packaged-remote] ${message.line}`)
    } else if (message.type === "status") {
      console.error(`[packaged-remote] phase=${message.phase} stage=${message.stage ?? "none"}`)
    } else if (message.type === "response") {
      const operation = pending.get(message.id)
      if (!operation) return
      pending.delete(message.id)
      clearTimeout(operation.timer)
      if (message.ok) operation.resolve(message.value)
      else operation.reject(new Error("Packaged remote worker operation failed"))
    }
  })
  worker.on("exit", (code) => {
    console.error(`[packaged-remote] worker-exit code=${code}`)
    for (const operation of pending.values()) {
      clearTimeout(operation.timer)
      operation.reject(new Error(`Packaged worker exited: ${code}`))
    }
    pending.clear()
    if (!closing) app.exit(1)
  })

  function request<T = any>(method: string, input?: unknown): Promise<T> {
    const id = String(++sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker timed out: ${method}`)), 330_000)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ type: "request", id, method, input })
    })
  }

  function assert(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message)
  }

  let cleanup: Promise<void> | undefined
  function close() {
    return (cleanup ??= (async () => {
      closing = true
      try {
        await request("reset")
        console.error("[packaged-remote] QA identity revoked")
        await request("stop")
      } finally {
        worker.kill()
        await stopNodeSidecar?.()
        app.quit()
      }
    })())
  }

  try {
    console.error("[packaged-remote] starting packaged worker with isolated sidecar")
    const { url: origin } = await request<{ url: string }>("start", {
      generation: 1,
      upstream,
      webRoot: join(resources, "remote-web"),
      auth: { version: 1, devices: [] },
      tunnelStore: { version: 1, identities: {}, pending: {} },
    })
    const invite = await request<{ url: string }>("pair")
    const paired = await fetch(`${origin}/remote/api/pair/redeem`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: new URL(invite.url).hash.slice(1), name: "Packaged worker QA" }),
      signal: AbortSignal.timeout(90_000),
    })
    assert(paired.ok, `Packaged pairing failed: ${paired.status}`)
    const cookie = paired.headers.get("set-cookie")?.split(";")[0]
    assert(cookie, "Packaged pairing cookie missing")
    const state = await fetch(`${origin}/remote/api/session`, { headers: { Cookie: cookie } }).then((r) => r.json())
    const headers = {
      Cookie: cookie,
      Origin: origin,
      "x-opencode-csrf": state.csrfToken,
      "Content-Type": "application/json",
    }
    const remoteFetch = (path: string, init?: RequestInit) =>
      fetch(`${origin}${path}?directory=${encodeURIComponent(fixture.project)}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(90_000),
      })
    const shell = await fetch(`${origin}/`, {
      headers: { Cookie: cookie, Accept: "text/html" },
      signal: AbortSignal.timeout(90_000),
    })
    assert(shell.ok && (await shell.text()).includes("<html"), "Packaged remote shell unavailable")
    assert((await remoteFetch("/global/health")).ok, "Packaged gateway cannot reach sidecar")
    const created = await remoteFetch("/session", {
      method: "POST",
      body: JSON.stringify({ title: "Packaged remote size regression QA" }),
    })
    assert(created.ok, `Packaged session create failed: ${created.status}`)
    const session = await created.json()
    const sent = await remoteFetch(`/session/${session.id}/${fixture.permission ? "prompt_async" : "message"}`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID: "remote-qa", modelID: "echo" },
        parts: [
          {
            type: "text",
            text: fixture.permission
              ? "Run only the harmless printf test, then reply REMOTE_ACCESS_SIDECAR_OK."
              : "Reply REMOTE_ACCESS_SIDECAR_OK. Do not use tools.",
          },
        ],
      }),
    })
    assert(sent.ok, `Packaged message send failed: ${sent.status}`)
    if (fixture.permission) {
      let permission: { id: string } | undefined
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline && !permission) {
        permission = (await remoteFetch("/permission").then((r) => r.json())).find(
          (p: any) => p.sessionID === session.id && p.permission === "bash",
        )
        if (!permission) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert(permission, "Packaged sidecar did not request isolated permission")
      const reply = await remoteFetch(`/session/${session.id}/permissions/${permission.id}`, {
        method: "POST",
        body: JSON.stringify({ response: "once" }),
      })
      assert(reply.ok, "Packaged permission reply failed")
    }
    let received = false
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !received) {
      const history = await remoteFetch(`/session/${session.id}/message`).then((r) => r.json())
      received =
        history.some(
          (m: any) =>
            m.info?.role === "assistant" && m.parts?.some((p: any) => p.text?.includes("REMOTE_ACCESS_SIDECAR_OK")),
        ) &&
        (!fixture.permission ||
          history.some((m: any) =>
            m.parts?.some(
              (p: any) =>
                p.type === "tool" &&
                p.state?.status === "completed" &&
                p.state.output?.includes("REMOTE_PERMISSION_TOOL_OK"),
            ),
          ))
      if (!received) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert(received, "Packaged sidecar reply/tool result not persisted")
    console.error("[packaged-remote] public HTTPS pairing, shell, sidecar message/reply and permission verified")
    const devices = await request<Array<{ id: string }>>("devices")
    for (const device of devices) await request("revoke", { id: device.id })
    assert((await remoteFetch(`/session/${session.id}`)).status === 401, "Revocation failed")
    const refresh = async () => {
      const invite = await request("pair")
      await writeFile(
        join(artifacts, "packaged-browser-invite.json"),
        JSON.stringify({
          ...invite,
          directory: fixture.project,
          sessionId: session.id,
          permission: fixture.permission,
        }),
        { mode: 0o600 },
      )
    }
    await refresh()
    const timer = setInterval(() => {
      void refresh().catch(() => {})
    }, 30_000)
    console.error(`[packaged-remote] PASS browser fixture=${join(artifacts, "packaged-browser-invite.json")}`)
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
    clearInterval(timer)
  } catch (error) {
    console.error(`[packaged-remote] FAIL ${error instanceof Error ? error.message : "unknown"}`)
    process.exitCode = 1
  } finally {
    await close()
  }
}

void main().catch((error) => {
  console.error(`[packaged-remote] host-failed ${error instanceof Error ? error.message : "unknown"}`)
  app.exit(1)
})
