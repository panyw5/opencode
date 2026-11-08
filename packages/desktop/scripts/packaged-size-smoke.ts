#!/usr/bin/env bun
// Loopback-only smoke check for the packaged desktop Node sidecar and remote
// worker. It exercises the real ASAR entry points inside the development
// Electron binary with a deterministic local provider, a temporary project and
// a throwaway database. No tunnel, no public network, no user credentials.
//
// Build with Bun (target=node, external=electron), then run in the
// development Electron binary:
//   bun build --target=node --format=esm --external=electron \
//     packages/desktop/scripts/packaged-size-smoke.ts \
//     --outfile <artifacts>/packaged-size-smoke.mjs
//   packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     <artifacts>/packaged-size-smoke.mjs \
//     '/path/to/packaged.app/Contents/Resources' <new empty artifacts dir>
//
// Verifies, in order: sidecar startup and health, a temporary project session
// message whose deterministic provider echoes a fixed marker, a harmless bash
// permission request answered with "once" and its completed tool output, and a
// remote-worker import/stop handshake (a bare stop request only, never a
// gateway or tunnel start). Logs are plain strings; every artifact stays under
// the given artifacts directory and only children this script forked are killed.
import { createServer, type Server } from "node:http"
import { existsSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

export const REPLY_MARKER = "PACKAGED_SIZE_SIDECAR_OK"
export const PERMISSION_MARKER = "PACKAGED_SIZE_PERMISSION_TOOL_OK"

export type SmokeArgs = { resources: string; artifacts: string }

/** Positional arguments only: the packaged Resources dir, then an empty artifacts dir. */
export function parseArgs(argv: readonly string[]): SmokeArgs {
  const positional = argv.filter((arg) => !arg.startsWith("-"))
  if (positional.length !== 2)
    throw new Error("Expected exactly two arguments: packaged Resources directory and a new empty artifacts directory")
  const [resources, artifacts] = positional
  if (!resources || !artifacts) throw new Error("Resources and artifacts directories are required")
  return { resources, artifacts }
}

/**
 * Deterministic provider configuration for the isolated sidecar. Permission
 * rules are last-match-wins, so construct this policy in its original order.
 */
export function buildFixtureConfig(modelUrl: string): Record<string, unknown> {
  return {
    model: "remote-qa/echo",
    small_model: "remote-qa/echo",
    snapshot: false,
    autoupdate: false,
    permission: { "*": "deny", bash: "ask" },
    provider: {
      "remote-qa": {
        npm: "@ai-sdk/openai-compatible",
        name: "Isolated packaged size smoke provider",
        options: { baseURL: `${modelUrl}/v1`, apiKey: "isolated-smoke-key" },
        models: {
          echo: {
            name: "Deterministic smoke echo",
            tool_call: true,
            limit: { context: 32_768, output: 2_048 },
          },
        },
      },
    },
  }
}

/**
 * Inherited environment is scrubbed so the isolated sidecar never sees host
 * provider credentials (any *_API_KEY/_TOKEN/_SECRET/... suffix), a host
 * OPENCODE_CONFIG file override, or a stale OPENCODE_SERVER_PASSWORD.
 * OPENCODE_PURE additionally disables extensions, plugins and external
 * agent-backend adapters, and the isolated HOME/XDG_* roots keep global auth
 * out of reach.
 */
const SECRET_ENV_SUFFIX = /(API_KEY|APIKEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)$/
const BLOCKED_ENV_KEYS = new Set([
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
])

/** Mirrors the packaged remote host's isolated sidecar environment. */
export function sidecarEnv(
  root: string,
  config: Record<string, unknown>,
  password: string,
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue
    if (SECRET_ENV_SUFFIX.test(key) || BLOCKED_ENV_KEYS.has(key)) continue
    inherited[key] = value
  }
  return {
    ...inherited,
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
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  } as Record<string, string>
}

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text
}

/** The sidecar start command; port must stay a number or parseCommand drops it. */
export function smokeStartCommand(hostname: string, port: number, password: string) {
  return { type: "start" as const, hostname, port, password, needsMigration: true }
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function listenLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address !== "string", "Listener has no TCP address")
  return `http://127.0.0.1:${address.port}`
}

/**
 * The same deterministic OpenAI-compatible provider fixture the remote access
 * E2E uses: the first completion asks for one harmless bash command, and the
 * follow-up (after the tool result) echoes the fixed reply marker.
 */
function createModelFixture() {
  let modelCalls = 0
  const server = createServer(async (request, response) => {
    let requestBody = ""
    for await (const chunk of request) requestBody += chunk.toString()
    let input: { messages?: Array<{ role: string }>; tools?: Array<{ function?: { name: string } }> }
    try {
      input = JSON.parse(requestBody)
    } catch {
      response.writeHead(400).end()
      return
    }
    const asksPermission =
      input.tools?.some((tool) => tool.function?.name === "bash") && input.messages?.at(-1)?.role !== "tool"
    modelCalls += 1
    const event = (delta: Record<string, unknown>, finishReason: string | null) => ({
      id: `smoke-${modelCalls}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "echo",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason ? { usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } : {}),
    })
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const delta = asksPermission
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_smoke_permission_${modelCalls}`,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: `printf ${PERMISSION_MARKER}`,
                  description: "Harmless isolated smoke permission test",
                  timeout: 10000,
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: REPLY_MARKER }
    response.write(`data: ${JSON.stringify(event(delta, null))}\n\n`)
    response.end(`data: ${JSON.stringify(event({}, asksPermission ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`)
  })
  return { server, calls: () => modelCalls }
}

async function main() {
  const { resources, artifacts } = parseArgs(process.argv.slice(2))
  const sidecarEntry = join(resources, "app.asar", "out", "main", "sidecar.js")
  const workerEntry = join(resources, "app.asar", "out", "main", "remote-worker.js")
  assert(existsSync(sidecarEntry), `Packaged sidecar entry missing: ${sidecarEntry}`)
  assert(existsSync(workerEntry), `Packaged remote worker entry missing: ${workerEntry}`)
  await mkdir(artifacts, { recursive: true })
  assert(readdirSync(artifacts).length === 0, "Artifacts directory must be new and empty")

  const { app, utilityProcess } = await import("electron")
  app.setPath("userData", join(artifacts, "electron-user-data"))
  app.commandLine.appendSwitch("disable-gpu")
  console.error("[packaged-size-smoke] resources=" + resources)
  console.error("[packaged-size-smoke] artifacts=" + artifacts)
  await app.whenReady()
  console.error("[packaged-size-smoke] electron-ready")

  const password = randomBytes(32).toString("hex")
  const fixture = createModelFixture()
  const modelUrl = await listenLoopback(fixture.server)
  console.error("[packaged-size-smoke] local provider listening on loopback")

  const project = await mkdtemp(join(artifacts, "project-"))
  await writeFile(
    join(project, "AGENTS.md"),
    "This is an isolated packaged size smoke test. Only run the harmless printf requested by the test.\n",
  )
  const sidecarRoot = join(artifacts, "node-sidecar")
  for (const sub of ["config", "data", "state", "cache"]) await mkdir(join(sidecarRoot, sub), { recursive: true })

  const config = buildFixtureConfig(modelUrl)
  const env = sidecarEnv(sidecarRoot, config, password)

  const reserve = createServer()
  const backendUrl = await listenLoopback(reserve)
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  // parseCommand in the packaged sidecar rejects a non-numeric port silently.
  const port = Number(new URL(backendUrl).port)

  let sidecarLog = ""
  let sidecar: ReturnType<typeof utilityProcess.fork> | undefined
  let worker: ReturnType<typeof utilityProcess.fork> | undefined
  let exiting = false

  const stopChild = async (child: NonNullable<typeof sidecar>) => {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.postMessage({ type: "stop" })
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    child.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
  }

  const cleanup = async () => {
    if (exiting) return
    exiting = true
    if (sidecar) await stopChild(sidecar)
    if (worker) await stopChild(worker)
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
    await writeFile(join(artifacts, "sidecar.log"), redact(sidecarLog, password))
    console.error("[packaged-size-smoke] cleanup complete; only smoke children were stopped")
  }

  try {
    sidecar = utilityProcess.fork(sidecarEntry, [], {
      cwd: project,
      stdio: "pipe",
      env,
    })
    sidecar.stdout?.on("data", (chunk) => (sidecarLog = (sidecarLog + String(chunk)).slice(-512_000)))
    sidecar.stderr?.on("data", (chunk) => (sidecarLog = (sidecarLog + String(chunk)).slice(-512_000)))

    console.error("[packaged-size-smoke] starting packaged Node sidecar with isolated provider and database")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Packaged Node sidecar startup timed out")), 90_000)
      sidecar!.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(timer)
          resolve()
        }
        if (message.type === "error") {
          clearTimeout(timer)
          reject(new Error(`Packaged Node sidecar failed: ${message.error?.message ?? "unknown"}`))
        }
      })
      sidecar!.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`Packaged Node sidecar exited during startup: ${code}`))
      })
      sidecar!.postMessage(smokeStartCommand("127.0.0.1", port, password))
    })
    console.error("[packaged-size-smoke] packaged Node sidecar ready")

    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
    const sidecarFetch = (path: string, init?: RequestInit) =>
      fetch(`${backendUrl}${path}?directory=${encodeURIComponent(project)}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(90_000),
      })

    let healthy = false
    const healthDeadline = Date.now() + 45_000
    while (Date.now() < healthDeadline && !healthy) {
      healthy = await sidecarFetch("/global/health")
        .then((response) => response.ok)
        .catch(() => false)
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert(healthy, "Packaged Node sidecar did not become healthy on loopback")
    console.error("[packaged-size-smoke] packaged sidecar health verified")

    const created = await sidecarFetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Packaged size smoke QA" }),
    })
    const createdText = await created.text()
    assert(created.ok, `Session create failed (${created.status}): ${createdText.slice(0, 300)}`)
    const session = JSON.parse(createdText) as { id: string }
    assert(session.id, "Created session has no id")
    console.error(`[packaged-size-smoke] created isolated session=${session.id}`)

    const sent = await sidecarFetch(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "remote-qa", modelID: "echo" },
        parts: [
          {
            type: "text",
            text: `Run the harmless printf test, then reply ${REPLY_MARKER}.`,
          },
        ],
      }),
    })
    assert(sent.ok, `Message send failed (${sent.status}): ${(await sent.text()).slice(0, 300)}`)
    console.error("[packaged-size-smoke] message sent; waiting for the isolated bash permission request")

    let permission: { id: string; permission: string } | undefined
    const permissionDeadline = Date.now() + 45_000
    while (Date.now() < permissionDeadline && !permission) {
      const pending = (await sidecarFetch("/permission").then((r) => r.json())) as Array<{
        id: string
        sessionID: string
        permission: string
      }>
      permission = pending.find((p) => p.sessionID === session.id && p.permission === "bash")
      if (!permission) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert(permission, "Packaged sidecar did not request the isolated bash permission")
    console.error("[packaged-size-smoke] bash permission pending; approving once")

    const reply = await sidecarFetch(`/session/${session.id}/permissions/${permission.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: "once" }),
    })
    assert(reply.ok, `Permission reply failed (${reply.status})`)

    let received = false
    const messageDeadline = Date.now() + 60_000
    while (Date.now() < messageDeadline && !received) {
      const history = (await sidecarFetch(`/session/${session.id}/message`).then((r) => r.json())) as Array<{
        info?: { role: string }
        parts?: Array<{ type: string; text?: string; state?: { status: string; output?: string } }>
      }>
      const assistantDone = history.some(
        (message) =>
          message.info?.role === "assistant" &&
          message.parts?.some((part) => part.type === "text" && part.text?.includes(REPLY_MARKER)),
      )
      const toolDone = history.some((message) =>
        message.parts?.some(
          (part) =>
            part.type === "tool" &&
            part.state?.status === "completed" &&
            part.state.output?.includes(PERMISSION_MARKER),
        ),
      )
      received = assistantDone && toolDone
      if (!received) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert(received, "Echo reply or harmless tool result was not persisted")
    assert(fixture.calls() > 0, "Deterministic provider received no requests")
    console.error(`[packaged-size-smoke] echo reply and permission tool output verified modelCalls=${fixture.calls()}`)

    worker = utilityProcess.fork(workerEntry, [], { stdio: "pipe", env })
    worker.stdout?.on("data", (chunk) =>
      console.error(`[packaged-size-smoke] worker-stdout bytes=${String(chunk).length}`),
    )
    worker.stderr?.on("data", (chunk) =>
      console.error(`[packaged-size-smoke] worker-stderr bytes=${String(chunk).length}`),
    )
    const workerStopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000)
      worker!.on("message", (message) => {
        // Only a bare "stop" request is ever sent: it routes to teardown() with
        // nothing running, so no gateway, tunnel transport or secure-storage
        // write can happen. "start"/"reset"/"remove-identity" are deliberately
        // not exercised here.
        if (message.type === "response" && message.id === "smoke-stop") {
          clearTimeout(timer)
          resolve(message.ok === true)
        }
      })
      worker!.once("exit", () => {
        clearTimeout(timer)
        resolve(false)
      })
      worker!.postMessage({ type: "request", id: "smoke-stop", method: "stop" })
    })
    assert(workerStopped, "Packaged remote worker did not answer the stop handshake")
    console.error("[packaged-size-smoke] remote worker import/stop handshake verified without gateway or tunnel")

    console.error("[packaged-size-smoke] PASS artifacts=" + artifacts)
  } catch (error) {
    console.error("[packaged-size-smoke] FAIL " + (error instanceof Error ? error.message : "unknown"))
    process.exitCode = 1
  } finally {
    await cleanup()
    app.quit()
  }
}

// Run only as the entry script (plain .ts via Bun, or the bundled .mjs inside
// Electron) so importing helpers from the test file stays side-effect free.
const entry = process.argv[1] ?? ""
if (entry.endsWith("packaged-size-smoke.ts") || entry.endsWith("packaged-size-smoke.mjs")) {
  void main().catch((error) => {
    console.error("[packaged-size-smoke] host-failed " + (error instanceof Error ? error.message : "unknown"))
    process.exitCode = 1
  })
}
