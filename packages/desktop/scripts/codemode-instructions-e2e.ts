import { strict as assert } from "node:assert"
import { fork, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"

const log = (text: string) => console.log(`[codemode-instructions-e2e] ${text}`)
const root = await realpath(await mkdtemp("/tmp/opencode-codemode-state-"))
const directory = path.join(root, "workspace")
await mkdir(directory)
await Bun.$`git init -q ${directory}`.quiet()
const phases = new Map<string, number>()
const failures: string[] = []
let baseline: string | undefined
let description: string | undefined
let direct = false
let compacting = false
let compacted = false
const text = (value: any) => (typeof value === "string" ? value : JSON.stringify(value))
const notices = (body: any) =>
  body.messages.filter(
    (message: any) =>
      message.role === "user" && text(message.content).includes("The Code Mode tool catalog has changed"),
  )
const fixture = Bun.serve({
  port: 0,
  error(error) {
    failures.push(String(error))
    return new Response("fixture assertion failed", { status: 500 })
  },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const rpc = (await request.json()) as any
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "catalog", version: "1" },
            }
          : rpc.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "echo",
                    description: "Echo fixture",
                    inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
                  },
                ],
              }
            : { content: [{ type: "text", text: "fixture" }] }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
    }
    const body = (await request.json()) as any
    const execute = body.tools?.find((tool: any) => tool.function.name === "execute")?.function
    const phase =
      body.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) => text(message.content).match(/CATALOG_QA_[A-Z_]+/)?.[0])
        .filter(Boolean)
        .at(-1) ?? "AUXILIARY"
    let delta: Record<string, unknown> = { content: "Fixture summary." }
    let finish = "stop"
    if (execute) {
      const step = (phases.get(phase) ?? 0) + 1
      phases.set(phase, step)
      const system = body.messages
        .filter((message: any) => message.role === "system")
        .map((message: any) => text(message.content))
        .join("\n")
      assert.ok(system.includes("# Code Mode"), "independent catalog instructions missing")
      assert.ok(!execute.description.includes("tools.catalog.echo"), "catalog leaked back into execute.description")
      assert.ok(!execute.description.includes("Inline catalog"), "legacy inline catalog remains")
      description ??= execute.description
      assert.equal(execute.description, description, "tool description changed with the inventory")
      baseline ??= system
      if (!compacting && !compacted) assert.equal(system, baseline, "stable instruction baseline changed")
      assert.equal(
        body.tools.some((tool: any) => tool.function.name === "catalog_echo"),
        direct,
      )
      if (phase === "CATALOG_QA_REMOVED")
        assert.ok(text(notices(body).at(-1)).includes("tools.catalog.echo"), "removal delta missing")
      if (phase === "CATALOG_QA_RESTORED" || phase === "CATALOG_QA_RESTART" || phase === "CATALOG_QA_FORK") {
        assert.ok(notices(body).length >= 2, "durable catalog updates were not replayed")
        assert.ok(text(notices(body).at(-1)).includes("New tools are available"), "restoration delta missing")
      }
      if (phase === "CATALOG_QA_REVERT" && !compacting)
        assert.equal(notices(body).length, 0, "reverted future was replayed")
      if (phase === "CATALOG_QA_COMPACT") {
        assert.ok(!system.includes("tools.catalog.echo"), "compaction did not rebase to the current catalog")
        assert.equal(notices(body).length, 0, "pre-compaction deltas leaked from retained tail")
      }
      if (step === 1) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: `call_${phase}`,
              type: "function",
              function: { name: "execute", arguments: JSON.stringify({ code: "return 7" }) },
            },
          ],
        }
        finish = "tool_calls"
      } else delta = { content: `${phase}_OK` }
      log(`model received phase=${phase} step=${step} catalogUpdates=${notices(body).length}`)
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-catalog",
      object: "chat.completion.chunk",
      created: 0,
      model: "catalog-model",
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [chunk({ role: "assistant" }), chunk(delta), chunk({}, finish)]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})
const mcp = (codemode: boolean) => ({ type: "remote", url: `${fixture.url}mcp`, oauth: false, codemode })
await Bun.write(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    plugin: [],
    snapshot: false,
    lsp: false,
    formatter: false,
    permission: { "*": "allow" },
    model: "catalogqa/catalog-model",
    mcp: { catalog: mcp(true) },
    provider: {
      catalogqa: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "local-test-only", baseURL: `${fixture.url}v1` },
        models: { "catalog-model": { name: "Catalog QA", limit: { context: 100000, output: 10000 } } },
      },
    },
  }),
)
const password = crypto.randomUUID()
let sidecar: ChildProcess | undefined
let connection: { url: string; username: string; password: string }
const stdout = createWriteStream("/tmp/opencode-codemode-instructions-sidecar.log")
const start = async () => {
  sidecar = fork(path.join(import.meta.dir, "query-codemode-sidecar.mjs"), [], {
    execPath: "node",
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_CACHE_HOME: `${root}/cache`,
      OPENCODE_TEST_HOME: `${root}/home`,
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_CHANNEL_DB: "true",
      OPENCODE_SERVER_PASSWORD: password,
    },
  })
  sidecar.stdout!.pipe(stdout, { end: false })
  sidecar.stderr!.pipe(stdout, { end: false })
  connection = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated sidecar startup timed out")), 30000)
    sidecar!.once("message", (message) => {
      clearTimeout(timer)
      resolve(message as typeof connection)
    })
    sidecar!.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`isolated sidecar exited ${code}`))
    })
  })
  log(`isolated sidecar ready pid=${sidecar.pid}`)
}
const stop = async () => {
  if (!sidecar || sidecar.exitCode !== null) return
  const process = sidecar
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => process.kill("SIGTERM"), 5000)
    process.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    process.send("stop")
  })
}
const request = async (route: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(connection.url.replace(/\/$/, "") + route, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
const snapshots = (sessionID: string) => {
  const db = new SQLite(path.join(root, "data/opencode/opencode.db"), { readonly: true })
  try {
    return db.query("SELECT * FROM code_mode_instruction WHERE session_id = ? ORDER BY rowid").all(sessionID) as Array<{
      message_id: string
      hash: string
      kind: string
      text: string
    }>
  } finally {
    db.close()
  }
}
const send = async (sessionID: string, phase: string) => {
  const result = await request(`/session/${sessionID}/message`, "POST", {
    agent: "build",
    model: { providerID: "catalogqa", modelID: "catalog-model" },
    parts: [{ type: "text", text: phase }],
  })
  assert.ok(
    result.parts.some((part: any) => part.text === `${phase}_OK`),
    `response missing for ${phase}`,
  )
  return result.info.parentID as string
}
try {
  await start()
  const session = await request("/session", "POST", { title: "Code Mode instructions QA" })
  await send(session.id, "CATALOG_QA_INITIAL")
  assert.equal(snapshots(session.id).length, 1)
  const boundary = await send(session.id, "CATALOG_QA_UNCHANGED")
  assert.equal(snapshots(session.id).length, 1)
  log("PASS independent system catalog, fixed description, unchanged catalog deduplication")
  direct = true
  await request("/mcp", "POST", { name: "catalog", config: mcp(false) })
  await send(session.id, "CATALOG_QA_REMOVED")
  direct = false
  await request("/mcp", "POST", { name: "catalog", config: mcp(true) })
  await send(session.id, "CATALOG_QA_RESTORED")
  assert.equal(snapshots(session.id).length, 3)
  const beforeRestart = snapshots(session.id)
  log("PASS live MCP removal/restoration, semantic deltas and stable baseline")
  await stop()
  await start()
  await send(session.id, "CATALOG_QA_RESTART")
  assert.deepEqual(snapshots(session.id), beforeRestart)
  log("PASS process restart replayed the same durable snapshots and chronological updates")
  const forked = await request(`/session/${session.id}/fork`, "POST", {})
  assert.equal(snapshots(forked.id).length, 3)
  await send(forked.id, "CATALOG_QA_FORK")
  assert.equal(snapshots(forked.id).length, 3)
  log("PASS fork remaps snapshot anchors and replays the parent's catalog lineage")
  await request(`/session/${session.id}/revert`, "POST", { messageID: boundary })
  await send(session.id, "CATALOG_QA_REVERT")
  assert.equal(snapshots(session.id).length, 1)
  log("PASS revert cleanup pruned future catalog snapshots")
  direct = true
  await request("/mcp", "POST", { name: "catalog", config: mcp(false) })
  await send(session.id, "CATALOG_QA_BEFORE_COMPACT")
  compacting = true
  await request(`/session/${session.id}/summarize`, "POST", {
    providerID: "catalogqa",
    modelID: "catalog-model",
    auto: false,
  })
  compacting = false
  compacted = true
  await send(session.id, "CATALOG_QA_COMPACT")
  assert.ok(snapshots(session.id).filter((row) => row.kind === "initial").length >= 2)
  log("PASS compaction rebased the catalog without replaying retained-tail deltas")
  assert.deepEqual(failures, [])
  await request(`/session/${session.id}`, "DELETE")
  assert.equal(snapshots(session.id).length, 0)
  await request(`/session/${forked.id}`, "DELETE")
  log("PASS all Code Mode instruction scenarios and cascading cleanup")
} finally {
  await stop()
  const logDir = path.join(root, "data/opencode/log")
  const logs: string[] = []
  for (const name of await readdir(logDir).catch(() => []))
    if (name.endsWith(".log")) logs.push(await readFile(path.join(logDir, name), "utf8"))
  await Bun.write("/tmp/opencode-codemode-instructions-backend.log", logs.join("\n"))
  stdout.end()
  fixture.stop(true)
  await rm(root, { recursive: true, force: true })
}
