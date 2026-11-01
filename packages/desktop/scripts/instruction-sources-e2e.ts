import { strict as assert } from "node:assert"
import { fork, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Database as SQLite } from "bun:sqlite"

const log = (value: string) => console.log(`[instruction-sources-e2e] ${value}`)
const root = await realpath(await mkdtemp("/tmp/opencode-instruction-sources-"))
const directory = path.join(root, "workspace")
await mkdir(directory)
await Bun.$`git init -q ${directory}`.quiet()
let remoteStatus = 200
let remoteBody = "SOURCE_REMOTE_A"
let compacting = false
let compacted = false
const failures: string[] = []
const phases = new Map<string, number>()
let baseline: string | undefined
let executeDescription: string | undefined
let skillDescription: string | undefined
const text = (value: any) => (typeof value === "string" ? value : JSON.stringify(value))
const fixture = Bun.serve({
  port: 0,
  error(error) {
    failures.push(String(error))
    return new Response("fixture assertion failed", { status: 500 })
  },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/policy") return new Response(remoteBody, { status: remoteStatus })
    const body = (await request.json()) as any
    const execute = body.tools?.find((tool: any) => tool.function.name === "execute")?.function
    const phase =
      body.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) => text(message.content).match(/SOURCES_QA_[A-Z_]+/)?.[0])
        .filter(Boolean)
        .at(-1) ?? "AUXILIARY"
    let delta: Record<string, unknown> = { content: "Fixture instruction summary." }
    let finish = "stop"
    if (execute) {
      const step = (phases.get(phase) ?? 0) + 1
      phases.set(phase, step)
      const system = body.messages
        .filter((message: any) => message.role === "system")
        .map((message: any) => text(message.content))
        .join("\n")
      const notices = body.messages.filter(
        (message: any) => message.role === "user" && text(message.content).includes("<system-reminder>"),
      )
      const updates = notices.map((message: any) => text(message.content)).join("\n")
      baseline ??= system
      executeDescription ??= execute.description
      assert.equal(execute.description, executeDescription)
      const skill = body.tools?.find((tool: any) => tool.function.name === "skill")?.function
      if (skill) {
        skillDescription ??= skill.description
        assert.equal(skill.description, skillDescription)
        assert.ok(!skill.description.includes("qa-source-skill"), "dynamic skill catalog leaked into tool description")
      }
      if (!compacting && !compacted) assert.equal(system, baseline, "system instruction baseline changed")
      if (phase === "SOURCES_QA_LOCAL") assert.ok(updates.includes("SOURCE_LOCAL_B"), "local AGENTS delta missing")
      if (phase === "SOURCES_QA_CONFIG") assert.ok(updates.includes("SOURCE_CONFIG_B"), "configured file delta missing")
      if (phase === "SOURCES_QA_REMOTE_REMOVED")
        assert.ok(updates.includes("no longer apply"), "remote removal missing")
      if (phase === "SOURCES_QA_REMOTE_RESTORED")
        assert.ok(updates.includes("SOURCE_REMOTE_B"), "remote restoration missing")
      if (phase === "SOURCES_QA_SKILL") assert.ok(updates.includes("SOURCE_SKILL_B"), "skill update missing")
      if (phase === "SOURCES_QA_SKILL_REMOVED")
        assert.ok(
          updates.includes("no longer available and must not be used: qa-source-skill"),
          "skill removal missing",
        )
      if (phase === "SOURCES_QA_DISABLED") assert.ok(!skill, "per-prompt disabled skill is still exposed")
      if (phase === "SOURCES_QA_REVERT")
        assert.ok(!updates.includes("SOURCE_SKILL_B"), "reverted intermediate skill guidance leaked")
      if (phase === "SOURCES_QA_COMPACT") {
        assert.ok(
          system.includes("SOURCE_LOCAL_B") && system.includes("SOURCE_REMOTE_B"),
          "current rules were not rebased",
        )
        assert.ok(!system.includes("SOURCE_LOCAL_A"), "old AGENTS baseline survived compaction")
        assert.ok(!updates.includes("SOURCE_SKILL_B"), "pre-compaction skill delta leaked")
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
      log(`model received phase=${phase} step=${step} updates=${notices.length}`)
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-sources",
      object: "chat.completion.chunk",
      created: 0,
      model: "source-model",
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
const agents = path.join(directory, "AGENTS.md")
const configured = path.join(directory, "rules.md")
const skillFile = path.join(directory, ".opencode/skills/qa-source-skill/SKILL.md")
await Bun.write(agents, "SOURCE_LOCAL_A\n")
await Bun.write(configured, "SOURCE_CONFIG_A\n")
const writeSkill = (description: string) =>
  Bun.write(skillFile, `---\nname: qa-source-skill\ndescription: ${description}\n---\nQA skill body.\n`)
await writeSkill("SOURCE_SKILL_A")
await Bun.write(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    plugin: [],
    snapshot: false,
    lsp: false,
    formatter: false,
    math: { disabled: true },
    permission: { "*": "allow" },
    instructions: ["rules.md", `${fixture.url}policy`],
    model: "sourceqa/source-model",
    provider: {
      sourceqa: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "local-test-only", baseURL: `${fixture.url}v1` },
        models: { "source-model": { name: "Source QA", limit: { context: 100000, output: 10000 } } },
      },
    },
  }),
)
let sidecar: ChildProcess | undefined
let connection: { url: string; username: string; password: string }
const password = crypto.randomUUID()
const stdout = createWriteStream("/tmp/opencode-instruction-sources-sidecar.log")
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
    const timer = setTimeout(() => reject(new Error("sidecar startup timed out")), 30000)
    sidecar!.once("message", (message) => {
      clearTimeout(timer)
      resolve(message as typeof connection)
    })
    sidecar!.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`sidecar exited ${code}`))
    })
  })
  log(`isolated sidecar ready pid=${sidecar.pid}`)
}
const stop = async () => {
  if (!sidecar || sidecar.exitCode !== null) return
  const child = sidecar
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGTERM"), 5000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.send("stop")
  })
}
const raw = (route: string, method = "GET", body?: unknown) =>
  fetch(connection.url.replace(/\/$/, "") + route, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
const request = async (route: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await raw(route, method, body)
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
const snapshots = (id: string) => {
  const db = new SQLite(path.join(root, "data/opencode/opencode.db"), { readonly: true })
  try {
    return db.query("SELECT * FROM session_instruction_snapshot WHERE session_id=? ORDER BY rowid").all(id) as Array<{
      source: string
      message_id: string
      kind: string
      hash: string
      snapshot: string
      text: string
    }>
  } finally {
    db.close()
  }
}
const send = async (id: string, phase: string, disabled = false) => {
  const result = await request(`/session/${id}/message`, "POST", {
    agent: "build",
    model: { providerID: "sourceqa", modelID: "source-model" },
    parts: [{ type: "text", text: phase }],
    ...(disabled ? { tools: { skill: false } } : {}),
  })
  assert.ok(
    result.parts.some((part: any) => part.text === `${phase}_OK`),
    `response missing: ${phase}`,
  )
  return result.info.parentID as string
}
try {
  await start()
  const session = await request("/session", "POST", { title: "Instruction source QA" })
  await send(session.id, "SOURCES_QA_INITIAL")
  assert.ok(
    baseline?.includes("SOURCE_LOCAL_A") &&
      baseline.includes("SOURCE_CONFIG_A") &&
      baseline.includes("SOURCE_REMOTE_A") &&
      baseline.includes("SOURCE_SKILL_A"),
  )
  assert.equal(snapshots(session.id).length, 2)
  const boundary = await send(session.id, "SOURCES_QA_UNCHANGED")
  assert.equal(snapshots(session.id).length, 2)
  await Bun.write(agents, "SOURCE_LOCAL_B\n")
  await send(session.id, "SOURCES_QA_LOCAL")
  await Bun.write(configured, "SOURCE_CONFIG_B\n")
  await send(session.id, "SOURCES_QA_CONFIG")
  const beforeFailure = snapshots(session.id)
  remoteStatus = 500
  await send(session.id, "SOURCES_QA_REMOTE_UNAVAILABLE")
  assert.deepEqual(snapshots(session.id), beforeFailure)
  log("PASS local/config deltas and HTTP failure retention without rewriting the system baseline")
  remoteStatus = 404
  await send(session.id, "SOURCES_QA_REMOTE_REMOVED")
  assert.ok(
    !snapshots(session.id)
      .filter((row) => row.source === "core/instructions")
      .at(-1)!
      .snapshot.includes("SOURCE_REMOTE_A"),
  )
  remoteStatus = 200
  remoteBody = "SOURCE_REMOTE_B"
  await send(session.id, "SOURCES_QA_REMOTE_RESTORED")
  await writeSkill("SOURCE_SKILL_B")
  await send(session.id, "SOURCES_QA_SKILL")
  const beforeInvalid = snapshots(session.id)
  await Bun.write(skillFile, "---\nname: [\n---\nbroken")
  await send(session.id, "SOURCES_QA_SKILL_UNAVAILABLE")
  assert.deepEqual(snapshots(session.id), beforeInvalid)
  await rm(skillFile)
  await send(session.id, "SOURCES_QA_SKILL_REMOVED")
  await send(session.id, "SOURCES_QA_DISABLED", true)
  assert.equal(
    snapshots(session.id)
      .filter((row) => row.source === "core/skill-guidance")
      .at(-1)!.snapshot,
    "[]",
  )
  log("PASS remote restoration, live skill updates, invalid edit retention, deletion and permission exclusion")
  const beforeRestart = snapshots(session.id)
  await stop()
  await start()
  await send(session.id, "SOURCES_QA_RESTART", true)
  assert.deepEqual(snapshots(session.id), beforeRestart)
  const forked = await request(`/session/${session.id}/fork`, "POST", {})
  await send(forked.id, "SOURCES_QA_FORK", true)
  assert.equal(snapshots(forked.id).length, beforeRestart.length)
  await request(`/session/${session.id}/revert`, "POST", { messageID: boundary })
  await send(session.id, "SOURCES_QA_REVERT", true)
  assert.ok(!snapshots(session.id).some((row) => row.text.includes("SOURCE_SKILL_B")))
  log("PASS durable restart, fork anchor remapping and revert cleanup")
  compacting = true
  await request(`/session/${session.id}/summarize`, "POST", {
    providerID: "sourceqa",
    modelID: "source-model",
    auto: false,
  })
  compacting = false
  compacted = true
  await send(session.id, "SOURCES_QA_COMPACT", true)
  assert.ok(snapshots(session.id).filter((row) => row.kind === "initial").length >= 4)
  log("PASS compaction rebases current file and skill state without retained-tail deltas")
  const blocked = await request("/session", "POST", { title: "Unavailable first source QA" })
  remoteStatus = 500
  const response = await raw(`/session/${blocked.id}/message`, "POST", {
    agent: "build",
    model: { providerID: "sourceqa", modelID: "source-model" },
    parts: [{ type: "text", text: "SOURCES_QA_INITIAL_FAILURE" }],
  })
  assert.ok(!response.ok, "first unavailable instruction source should fail closed")
  assert.equal(phases.has("SOURCES_QA_INITIAL_FAILURE"), false)
  assert.equal(snapshots(blocked.id).length, 0)
  assert.deepEqual(failures, [])
  log("PASS first-read failure blocks model dispatch without partially committing instruction sources")
  for (const item of [session, forked, blocked]) await request(`/session/${item.id}`, "DELETE")
  log("PASS all instruction source scenarios and test-session cleanup")
} finally {
  await stop()
  const logDir = path.join(root, "data/opencode/log")
  const logs: string[] = []
  for (const name of await readdir(logDir).catch(() => []))
    if (name.endsWith(".log")) logs.push(await readFile(path.join(logDir, name), "utf8"))
  await Bun.write("/tmp/opencode-instruction-sources-backend.log", logs.join("\n"))
  stdout.end()
  fixture.stop(true)
  await rm(root, { recursive: true, force: true })
}
