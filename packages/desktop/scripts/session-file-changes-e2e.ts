import { strict as assert } from "node:assert"
import { fork, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"

const log = (message: string) => console.log(`[session-file-changes-e2e] ${message}`)
const root = await realpath(await mkdtemp("/tmp/opencode-file-changes-"))
const directory = path.join(root, "workspace")
await mkdir(directory)
await Bun.$`git init -q ${directory}`.quiet()
const ready = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const backgroundReady = Promise.withResolvers<void>()
const backgroundRelease = Promise.withResolvers<void>()
const phases = new Map<string, number>()
const fixture = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/background-gate") {
      backgroundReady.resolve()
      await backgroundRelease.promise
      return new Response("background gate released")
    }
    if (new URL(request.url).pathname === "/gate") {
      ready.resolve()
      await release.promise
      return new Response("gate released")
    }
    const body = (await request.json()) as any
    const phase = body.messages
      .filter((message: any) => message.role === "user")
      .map((message: any) => JSON.stringify(message.content).match(/CHANGES_QA_[A-Z_]+/)?.[0])
      .filter(Boolean)
      .at(-1)
    const step = phase ? (phases.get(phase) ?? 0) + 1 : 0
    if (phase) phases.set(phase, step)
    let delta: unknown = { content: `${phase ?? "auxiliary"}_OK` }
    let finish = "stop"
    if (phase && step === 1 && body.tools?.some((tool: any) => tool.function.name === "write")) {
      const calls: { name: string; args: unknown }[] =
        phase === "CHANGES_QA_READ" || phase === "CHANGES_QA_BACKGROUND"
          ? [
              {
                name: "bash",
                args: {
                  command: `curl -fsS '${fixture.url}${phase === "CHANGES_QA_BACKGROUND" ? "background-gate" : "gate"}'`,
                  description: "Read-only concurrency gate",
                  timeout: 60000,
                  ...(phase === "CHANGES_QA_BACKGROUND" ? { background: true } : {}),
                },
              },
            ]
          : phase === "CHANGES_QA_WRITE"
            ? ["foreign.txt", "shared.txt"].map((file) => ({
                name: "write",
                args: { filePath: path.join(directory, file), content: "B\n" },
              }))
            : phase === "CHANGES_QA_FIRST"
              ? [
                  {
                    name: "edit",
                    args: { filePath: path.join(directory, "shared.txt"), oldString: "B", newString: "C1" },
                  },
                ]
              : phase === "CHANGES_QA_BACKGROUND_WRITE"
                ? [
                    {
                      name: "write",
                      args: { filePath: path.join(directory, "background-foreign.txt"), content: "external\n" },
                    },
                  ]
                : phase === "CHANGES_QA_INTERLEAVE"
                  ? [
                      {
                        name: "write",
                        args: { filePath: path.join(directory, "shared.txt"), content: "C1\nFOREIGN\n" },
                      },
                    ]
                  : phase === "CHANGES_QA_SECOND"
                    ? [
                        {
                          name: "edit",
                          args: { filePath: path.join(directory, "shared.txt"), oldString: "C1", newString: "C2" },
                        },
                      ]
                    : []
      assert.ok(calls.length, `unrecognized phase ${phase}`)
      delta = {
        tool_calls: calls.map((call, index) => ({
          index,
          id: `call_${phase}_${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      }
      finish = "tool_calls"
    }
    log(`model received phase=${phase ?? "auxiliary"} step=${step} finish=${finish}`)
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-changes",
      object: "chat.completion.chunk",
      created: 0,
      model: "changes",
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
await Bun.write(
  path.join(directory, "opencode.json"),
  JSON.stringify({
    plugin: [],
    lsp: false,
    formatter: false,
    math: { disabled: true },
    permission: { "*": "allow" },
    model: "changesqa/changes",
    provider: {
      changesqa: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "local-fixture", baseURL: `${fixture.url}v1` },
        models: { changes: { name: "Changes QA", limit: { context: 100000, output: 10000 } } },
      },
    },
  }),
)
let sidecar: ChildProcess | undefined
let connection: { url: string; username: string; password: string }
const password = crypto.randomUUID()
const output = createWriteStream(path.join(root, "sidecar.log"))
async function start() {
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
  sidecar.stdout!.pipe(output, { end: false })
  sidecar.stderr!.pipe(output, { end: false })
  connection = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sidecar startup timed out")), 30000)
    sidecar!.once("message", (value) => {
      clearTimeout(timeout)
      resolve(value as typeof connection)
    })
    sidecar!.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`sidecar exited ${code}`))
    })
  })
  log(`sidecar started pid=${sidecar.pid}`)
}
async function stop() {
  if (!sidecar || sidecar.exitCode !== null) return
  const child = sidecar
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGTERM"), 5000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.send("stop")
  })
}
async function request(route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(connection.url.replace(/\/$/, "") + route, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
async function send(id: string, phase: string) {
  const result = await request(`/session/${id}/message`, "POST", {
    agent: "build",
    model: { providerID: "changesqa", modelID: "changes" },
    parts: [{ type: "text", text: phase }],
  })
  assert.ok(
    result.parts.some((part: any) => part.type === "text" && part.text.includes(`${phase}_OK`)),
    `missing reply ${phase}`,
  )
  log(`reply verified phase=${phase}`)
  return result
}
async function settled(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const statuses = await request("/session/status")
    if (!statuses[id] || statuses[id].type === "idle") return
    await Bun.sleep(20)
  }
  throw new Error(`session did not settle: ${id}`)
}
try {
  await start()
  const a = await request("/session", "POST", { title: "File change QA: reader" })
  const b = await request("/session", "POST", { title: "File change QA: other writer" })
  const c = await request("/session", "POST", { title: "File change QA: interleaved writer" })
  const reading = send(a.id, "CHANGES_QA_READ")
  await Promise.race([
    ready.promise,
    Bun.sleep(30000).then(() => {
      throw new Error("read-only shell never reached gate")
    }),
  ])
  await send(b.id, "CHANGES_QA_WRITE")
  release.resolve()
  await reading
  await settled(a.id)
  await settled(b.id)
  assert.deepEqual(await request(`/session/${a.id}/diff`), [])
  const readerMessages = await request(`/session/${a.id}/message`)
  const bash = readerMessages.flatMap((message: any) => message.parts).find((part: any) => part.tool === "bash")
  assert.equal(bash.state.status, "completed")
  assert.equal(bash.state.metadata.files, undefined)
  assert.deepEqual((await request(`/session/${b.id}/diff`)).map((diff: any) => diff.file).sort(), [
    "foreign.txt",
    "shared.txt",
  ])
  log("PASS read-only shell did not claim concurrent writes")
  await send(c.id, "CHANGES_QA_FIRST")
  await send(b.id, "CHANGES_QA_INTERLEAVE")
  await send(c.id, "CHANGES_QA_SECOND")
  await settled(c.id)
  const diffs = await request(`/session/${c.id}/diff`)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].file, "shared.txt")
  assert.equal(diffs[0].operations.length, 2)
  assert.ok(diffs[0].operations.every((operation: any) => !operation.patch.includes("+FOREIGN")))
  log("PASS interleaved file changes remained separate operations")
  const d = await request("/session", "POST", { title: "File change QA: background reader" })
  await send(d.id, "CHANGES_QA_BACKGROUND")
  await Promise.race([
    backgroundReady.promise,
    Bun.sleep(30000).then(() => {
      throw new Error("background shell never reached gate")
    }),
  ])
  await send(b.id, "CHANGES_QA_BACKGROUND_WRITE")
  backgroundRelease.resolve()
  let backgroundExited = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const shells = await request(`/background-shell?sessionID=${d.id}`)
    if (shells.length && shells.every((shell: any) => shell.status !== "running")) {
      backgroundExited = true
      break
    }
    await Bun.sleep(20)
  }
  assert.ok(backgroundExited, "background shell never exited")
  assert.deepEqual(await request(`/session/${d.id}/diff`), [])
  log("PASS background shell did not claim another session's writes")
  await stop()
  const db = new Database(path.join(root, "data/opencode/opencode.db"))
  const message = db
    .query(
      "SELECT id,data FROM message WHERE session_id=? AND json_extract(data,'$.role')='user' ORDER BY time_created LIMIT 1",
    )
    .get(c.id) as { id: string; data: string }
  const data = JSON.parse(message.data)
  data.summary = { diffs: [{ file: "foreign.txt", additions: 9, deletions: 0 }] }
  db.query("UPDATE message SET data=? WHERE id=?").run(JSON.stringify(data), message.id)
  db.close()
  await rm(path.join(root, "data/opencode/storage/session_diff_version", `${c.id}.json`), { force: true })
  await start()
  const history = await request(`/session/${c.id}/message`)
  const repaired = history.find((item: any) => item.info.id === message.id)
  assert.deepEqual(
    repaired.info.summary.diffs.map((diff: any) => diff.file),
    ["shared.txt"],
  )
  assert.deepEqual(await request(`/session/${c.id}/diff`), diffs)
  log("PASS restart retained mutation evidence and repaired polluted history")
  log(`PASS all checks; artifacts=${root}`)
} finally {
  release.resolve()
  backgroundRelease.resolve()
  await stop()
  fixture.stop(true)
  output.end()
}
