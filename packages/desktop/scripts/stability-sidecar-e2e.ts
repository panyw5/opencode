import { strict as assert } from "node:assert"
import { fork } from "node:child_process"
import { createWriteStream } from "node:fs"
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

const log = (message: string) => console.log(`[stability-e2e] ${message}`)
const temporary = await mkdtemp("/tmp/opencode-stability-e2e-")
const workspace = path.join(temporary, "workspace")
await mkdir(workspace)
await Bun.$`git init -q ${workspace}`.quiet()
await Bun.write(path.join(workspace, "initial.txt"), "initial")
await Bun.$`git -C ${workspace} -c user.name=QA -c user.email=qa@example.test add .`.quiet()
await Bun.$`git -C ${workspace} -c user.name=QA -c user.email=qa@example.test commit -qm initial`.quiet()
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port
    server.close(() => resolve(port))
  })
})
const counts = new Map<string, number>()
const model = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: unknown[] }
    const context = JSON.stringify(body.messages)
    const scenario =
      ["STABILITY_TEXT", "STABILITY_TOOL", "STABILITY_EXHAUST", "STABILITY_WRITE", "STABILITY_IMAGE"].find((key) =>
        context.includes(key),
      ) ?? "TITLE"
    const count = (counts.get(scenario) ?? 0) + 1
    counts.set(scenario, count)
    let finish = "stop"
    let delta: Record<string, unknown> = { content: `${scenario}_OK` }
    if ((scenario === "STABILITY_TEXT" && count === 1) || scenario === "STABILITY_EXHAUST") {
      finish = "length"
      delta = { content: `${scenario}_PARTIAL` }
    }
    if ((scenario === "STABILITY_TOOL" || scenario === "STABILITY_WRITE") && count === 1) {
      const args = JSON.stringify({ filePath: path.join(workspace, `${scenario}.txt`), content: "written by tool" })
      finish = scenario === "STABILITY_TOOL" ? "length" : "tool_calls"
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "call_qa",
            type: "function",
            function: { name: "write", arguments: scenario === "STABILITY_TOOL" ? args.slice(0, -8) : args },
          },
        ],
      }
    }
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      id: "chatcmpl-qa",
      object: "chat.completion.chunk",
      created: 0,
      model: "stability-model",
      choices: [{ index: 0, delta, finish_reason }],
    })
    log(`provider received scenario=${scenario} step=${count} finish=${finish}`)
    return new Response(
      [chunk({ role: "assistant" }), chunk(delta), chunk({}, finish)]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    )
  },
})
const password = crypto.randomUUID()
const bundle = process.argv[2] ?? path.resolve(import.meta.dir, "../out/main/sidecar.js")
const logfile = `${temporary}.log`
const backendLogs = async () => {
  const directory = path.join(temporary, "data/opencode/log")
  const files = await readdir(directory).catch(() => [])
  return (
    await Promise.all(
      files.filter((file) => file.endsWith(".log")).map((file) => readFile(path.join(directory, file), "utf8")),
    )
  ).join("\n")
}
const output = createWriteStream(logfile)
const child = fork(path.resolve(import.meta.dir, "stability-sidecar-runner.mjs"), [pathToFileURL(bundle).href], {
  execPath: "node",
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  cwd: workspace,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: `${temporary}/config`,
    XDG_DATA_HOME: `${temporary}/data`,
    XDG_STATE_HOME: `${temporary}/state`,
    XDG_CACHE_HOME: `${temporary}/cache`,
    OPENCODE_TEST_HOME: `${temporary}/home`,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "stability/stability-model",
      plugin: [],
      mcp: {},
      permission: { "*": "allow" },
      provider: {
        stability: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local stability fixture",
          options: { apiKey: "test-only", baseURL: `${model.url}v1` },
          models: {
            "stability-model": { name: "Stability", attachment: true, limit: { context: 100000, output: 10000 } },
          },
        },
      },
    }),
  },
})
child.stdout!.pipe(output, { end: false })
child.stderr!.pipe(output, { end: false })
const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Sidecar startup timed out, logs=${logfile}`)), 30_000)
  child.on("message", (message: any) => {
    if (message.type === "booted")
      child.send({ type: "start", hostname: "127.0.0.1", port, password, needsMigration: true })
    if (message.type === "ready") {
      clearTimeout(timer)
      resolve()
    }
    if (message.type === "error") {
      clearTimeout(timer)
      reject(new Error(message.error.message))
    }
  })
  child.once("exit", (code) => {
    clearTimeout(timer)
    reject(new Error(`Sidecar exited code=${code}, logs=${logfile}`))
  })
})
const request = async (route: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(workspace),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  assert.ok(response.ok, `${method} ${route} HTTP ${response.status} ${response.ok ? "" : await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
const sessions: string[] = []
const send = async (scenario: string, files: unknown[] = []) => {
  const session = await request("/session", "POST", { title: `QA ${scenario}` })
  sessions.push(session.id)
  const result = await request(`/session/${session.id}/message`, "POST", {
    agent: "build",
    model: { providerID: "stability", modelID: "stability-model" },
    parts: [{ type: "text", text: scenario }, ...files],
  })
  return { session, result, history: (await request(`/session/${session.id}/message`)) as any[] }
}
try {
  await ready
  log(`isolated bundled sidecar ready pid=${child.pid} logs=${logfile}`)
  const text = await send("STABILITY_TEXT")
  assert.equal(counts.get("STABILITY_TEXT"), 2)
  assert.ok(text.result.parts.some((part: any) => part.text === "STABILITY_TEXT_OK"))
  assert.ok(text.history.flatMap((message) => message.parts).some((part) => part.text === "STABILITY_TEXT_PARTIAL"))
  assert.equal(text.history.filter((message) => message.info.role === "user").length, 1)
  log("PASS truncated text continued once and original partial output was retained")
  const tool = await send("STABILITY_TOOL")
  assert.equal(counts.get("STABILITY_TOOL"), 2)
  assert.ok(tool.result.parts.some((part: any) => part.text === "STABILITY_TOOL_OK"))
  assert.equal(await Bun.file(path.join(workspace, "STABILITY_TOOL.txt")).exists(), false)
  assert.ok(
    tool.history
      .flatMap((message) => message.parts)
      .some((part) => part.type === "tool" && part.state.error?.includes("output token limit")),
  )
  log("PASS truncated tool arguments were not executed and the next reply arrived")
  const exhausted = await send("STABILITY_EXHAUST")
  assert.equal(counts.get("STABILITY_EXHAUST"), 3)
  assert.ok(exhausted.result.info.error.data.message.includes("after two"))
  log("PASS output-limit recovery stops after two continuations")
  const write = await send("STABILITY_WRITE")
  assert.equal(await Bun.file(path.join(workspace, "STABILITY_WRITE.txt")).text(), "written by tool")
  const user = write.history.find((message) => message.info.role === "user")
  await request(`/session/${write.session.id}/revert`, "POST", { messageID: user.info.id })
  assert.equal(await Bun.file(path.join(workspace, "STABILITY_WRITE.txt")).exists(), false)
  log("PASS real tool write and transactional conversation/file rollback")
  const image = await send("STABILITY_IMAGE", [
    {
      type: "file",
      mime: "image/webp",
      url: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    },
  ])
  assert.ok(image.result.parts.some((part: any) => part.text === "STABILITY_IMAGE_OK"))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const backend = (await readFile(logfile, "utf8")) + (await backendLogs())
  assert.ok(backend.includes("image worker ready"), "bundled worker did not become ready")
  assert.ok(!backend.includes("image worker unavailable"), "bundled worker silently fell back")
  assert.ok(backend.includes("continuing after output token limit"))
  assert.ok(backend.includes("snapshot temporary index installed"))
  log("PASS bundled sidecar image normalization used its worker; backend logs verified")
  log("PASS all stability scenarios")
} finally {
  for (const id of sessions) await request(`/session/${id}`, "DELETE").catch(() => {})
  child.kill()
  model.stop(true)
  await new Promise<void>((resolve) => (child.exitCode === null ? child.once("close", () => resolve()) : resolve()))
  await new Promise<void>((resolve) => output.end(resolve))
  await appendFile(logfile, await backendLogs())
  await rm(temporary, { recursive: true, force: true })
  log(`isolated sidecar stopped; retained logs=${logfile}`)
}
