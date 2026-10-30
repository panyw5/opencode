import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

const log = (message: string) => console.log(`[pi-consult-e2e] ${message}`)
const root = await mkdtemp("/tmp/opencode-pi-e2e-")
const workspace = path.join(root, "workspace")
const home = path.join(root, "pi-home")
await mkdir(workspace)
await mkdir(home)
await writeFile(path.join(workspace, "README.md"), "PI_TOOL_READ_OK")
const binary = process.env.PI_E2E_BINARY ?? path.resolve(import.meta.dir, "../../opencode/test/fixture/pi-rpc.mjs")
const real = !!process.env.PI_E2E_BINARY
let release = () => {}
const gate = new Promise<void>((resolve) => {
  release = resolve
})
let piCalls = 0
let contextPreserved = false
let toolObserved = false
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { model: string; messages: Array<{ role: string; content?: unknown }> }
    const pi = body.model === "pi-rpc-fixture"
    const messages = JSON.stringify(body.messages)
    if (pi && messages.includes("PI_STOP_REQUEST")) {
      log("local model streaming partial response for cancellation test")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "chatcmpl-stop", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "PI_STOP_PARTIAL" }, finish_reason: null }] })}\n\n`,
              ),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    let text = "PARENT_SUMMARY_OK"
    let tool = false
    if (pi) {
      piCalls++
      log(`local model Pi request=${piCalls} messages=${body.messages.length}`)
      if (piCalls === 1) {
        await gate
        tool = true
      }
      toolObserved ||= messages.includes("PI_TOOL_READ_OK")
      contextPreserved ||= messages.includes("PI_INITIAL_REPLY")
      text = piCalls <= 2 ? "PI_INITIAL_REPLY" : contextPreserved ? "PI_FOLLOWUP_CONTEXT_OK" : "PI_CONTEXT_MISSING"
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-pi-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [
        chunk({ role: "assistant" }),
        tool
          ? chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "pi-read-test",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
                },
              ],
            })
          : chunk({ content: text }),
        chunk({}, tool ? "tool_calls" : "stop"),
      ]
        .map((item) => `data: ${JSON.stringify(item)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
await writeFile(
  path.join(home, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `${provider.url}v1`,
        api: "openai-completions",
        apiKey: "local-fixture-only",
        models: [
          {
            id: "pi-rpc-fixture",
            name: "Pi RPC fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 2000,
          },
        ],
      },
    },
  }),
)
await writeFile(
  path.join(home, "settings.json"),
  JSON.stringify({ defaultProvider: "fixture", defaultModel: "pi-rpc-fixture", defaultThinkingLevel: "off" }),
)
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port
    server.close(() => resolve(port))
  })
})
const password = crypto.randomUUID()
const bundle = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../out/main/sidecar.js"))
const runner =
  "process.parentPort={postMessage:message=>process.send(message),on:(_,listener)=>process.on('message',data=>listener({data}))};await import(process.argv[1]);process.send({type:'booted'});"
const logfile = path.join(root, "sidecar.log")
const output = createWriteStream(logfile)
const child = spawn("node", ["--input-type=module", "--eval", runner, pathToFileURL(bundle).href], {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_AUTH_CONTENT: "{}",
    PI_OFFLINE: "1",
    PI_RPC_GATE: real ? "" : path.join(root, "release"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "fixture/parent",
      plugin: [],
      mcp: {},
      permission: { "*": "allow" },
      pi: { enabled: true, binaryPath: binary, configHome: home },
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local fixture",
          options: { apiKey: "fixture", baseURL: `${provider.url}v1` },
          models: { parent: { name: "Parent", limit: { context: 200000, output: 2000 } } },
        },
      },
    }),
  },
})
child.stdout!.pipe(output, { end: false })
child.stderr!.pipe(output, { end: false })
const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logfile}`)), 30000)
  child.on("message", (value: unknown) => {
    const message = value as { type: string; error?: { message: string } }
    if (message.type === "booted")
      child.send({ type: "start", hostname: "127.0.0.1", port, password, needsMigration: true })
    if (message.type === "ready") {
      clearTimeout(timer)
      resolve()
    }
    if (message.type === "error") {
      clearTimeout(timer)
      reject(new Error(message.error?.message))
    }
  })
  child.once("exit", (code) => {
    clearTimeout(timer)
    reject(new Error(`Sidecar exited ${code}`))
  })
})
type Part = {
  type: string
  text?: string
  tool?: string
  state?: { status: string; metadata: Record<string, unknown>; output?: string }
}
type Message = { info: { role: string; modelID?: string; providerID?: string }; parts: Part[] }
type Session = { id: string; external?: { advisor: string } }
const request = async <T>(route: string, body?: unknown): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(workspace),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  })
  assert.ok(response.ok, `${route}: ${response.status} ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>)
}
const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(40)
  }
  throw new Error(`Timeout waiting for ${label}; logs=${root}`)
}
try {
  await ready
  log(`isolated Node sidecar ready; realPi=${real} root=${root}`)
  const parent = await request<Session>("/session", { title: "Pi RPC end-to-end" })
  await request(`/session/${parent.id}/prompt_async`, {
    agent: "build",
    model: { providerID: "fixture", modelID: "parent" },
    parts: [
      { type: "text", text: "PI_INITIAL_REQUEST" },
      { type: "agent", name: "pi" },
    ],
  })
  const session = await until(
    async () => (await request<Session[]>(`/session/${parent.id}/children`))[0],
    "Pi child session",
  )
  assert.equal(session.external?.advisor, "pi")
  await request(`/session/${session.id}/external-control`, { action: "start" })
  release()
  await writeFile(path.join(root, "release"), "ready")
  const waitReply = (expected: string) =>
    until(async () => {
      const messages = await request<Message[]>(`/session/${session.id}/message`)
      const state = await request<{ waitingForInput: boolean }>(`/session/${session.id}/external-control`, {
        action: "status",
      })
      return messages.some((message) => message.parts.some((part) => part.text?.includes(expected))) &&
        state.waitingForInput
        ? messages
        : undefined
    }, expected)
  await waitReply(real ? "PI_INITIAL_REPLY" : "PI_REPLY_1")
  log("received initial Pi response")
  await request(`/session/${session.id}/external-control`, {
    action: "message",
    message: "PI_FOLLOWUP_REQUEST",
    requestID: "pi-followup",
  })
  const messages = await waitReply(real ? "PI_FOLLOWUP_CONTEXT_OK" : "PI_REPLY_2")
  assert.deepEqual(
    messages.map((message) => message.info.role),
    ["user", "assistant", "user", "assistant"],
  )
  assert.equal(messages[1]!.info.providerID, "external-pi")
  assert.equal(messages[1]!.info.modelID, real ? "fixture/pi-rpc-fixture" : "fixture/pi-test")
  assert.ok(
    messages.some((message) => message.parts.some((part) => part.tool === "external_tool_use")),
    "Pi tool events missing",
  )
  log("received follow-up on the same Pi conversation and verified tool records")
  await request(`/session/${session.id}/external-control`, { action: "finish" })
  const part = await until(
    async () =>
      (await request<Message[]>(`/session/${parent.id}/message`))
        .flatMap((message) => message.parts)
        .find((part) => part.tool === "pi_consult" && part.state?.status === "completed"),
    "completed Pi consult",
  )
  assert.equal(part.state!.metadata.interventionTurns, 2)
  assert.equal((part.state!.metadata.externalHandoff as Record<string, unknown>).read_before_summary, true)
  await until(
    async () =>
      (await request<Message[]>(`/session/${parent.id}/message`)).some((message) =>
        message.parts.some((item) => item.text === "PARENT_SUMMARY_OK"),
      )
        ? true
        : undefined,
    "parent summary",
  )
  if (real) {
    assert.ok(contextPreserved)
    assert.ok(toolObserved)
  }
  const stoppedParent = await request<Session>("/session", { title: "Pi cancellation end-to-end" })
  await request(`/session/${stoppedParent.id}/prompt_async`, {
    agent: "build",
    model: { providerID: "fixture", modelID: "parent" },
    parts: [
      { type: "text", text: "PI_STOP_REQUEST" },
      { type: "agent", name: "pi" },
    ],
  })
  const stopped = await until(
    async () => (await request<Session[]>(`/session/${stoppedParent.id}/children`))[0],
    "cancellation child",
  )
  await until(
    async () =>
      (await request<Message[]>(`/session/${stopped.id}/message`)).some((message) =>
        message.parts.some((item) => item.text?.includes("PI_STOP_PARTIAL")),
      )
        ? true
        : undefined,
    "live partial response",
  )
  await request(`/session/${stopped.id}/external-control`, { action: "stop" })
  await until(
    async () =>
      (await request<Message[]>(`/session/${stoppedParent.id}/message`))
        .flatMap((message) => message.parts)
        .find((item) => item.tool === "pi_consult" && item.state?.status === "error"),
    "aborted Pi consult",
  )
  const stoppedState = await request<{ available: boolean }>(`/session/${stopped.id}/external-control`, {
    action: "status",
  })
  assert.equal(stoppedState.available, false)
  assert.ok(
    (await request<Message[]>(`/session/${stopped.id}/message`)).some((message) =>
      message.parts.some((item) => item.text?.includes("PI_STOP_PARTIAL")),
    ),
  )
  await until(
    async () =>
      (await request<Message[]>(`/session/${stoppedParent.id}/message`)).some((message) =>
        message.parts.some((item) => item.text === "PARENT_SUMMARY_OK"),
      )
        ? true
        : undefined,
    "parent continues after stopping Pi",
  )
  log("stop cancelled only Pi, retained partial text, and allowed the parent to continue")
  const logs = path.join(root, "data/opencode/log")
  const backend = (
    await Promise.all(
      (await readdir(logs))
        .filter((file) => file.endsWith(".log"))
        .map((file) => readFile(path.join(logs, file), "utf8")),
    )
  ).join("\n")
  for (const marker of ["service=pi.rpc", "service=tool.pi_consult", "turn completed", "handoff assembled", "turns=2"])
    assert.ok(backend.includes(marker), `Missing backend diagnostic: ${marker}`)
  log(
    `PASS @pi -> real sidecar -> RPC -> tool execution -> follow-up -> persisted history -> parent handoff; logs=${root}`,
  )
} catch (error) {
  log((await readFile(logfile, "utf8").catch(() => "")).slice(-10000))
  throw error
} finally {
  release()
  provider.stop(true)
  if (child.connected) child.send({ type: "stop" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve()
    else child.once("exit", () => resolve())
  })
  clearTimeout(timer)
  output.end()
}
