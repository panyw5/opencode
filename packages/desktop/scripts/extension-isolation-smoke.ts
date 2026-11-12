import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Preparation only; never launches Electron or a backend and never installs dependencies.
 *
 * bun packages/desktop/scripts/extension-isolation-smoke.ts prepare [--deps /local/repo]
 * bun packages/desktop/scripts/extension-isolation-smoke.ts mock /new/tmp/root
 * /new/tmp/root/start-backend.sh /worktree/under/test [port=0] # MAIN SESSION ONLY
 * bun packages/desktop/scripts/extension-isolation-smoke.ts check /new/tmp/root --backend http://127.0.0.1:PORT
 *
 * Keep `mock` running while the main session starts its isolated backend and runs `check`.
 * `check` refuses a non-loopback URL or a backend whose registry/path/config identity differs.
 * Artifacts are retained. SIGINT/SIGTERM stop only this script's model/build child, never Electron/backend.
 * The backend is real; only its OpenAI-compatible model is replaced. A failed/hung baseline is NOT a pass.
 * UI evidence is deliberately separate: open the recorded session in an explicitly isolated dev renderer,
 * verify the throwing card's fallback, healthy sibling and responsive input, then record CDP evidence.
 */
const repo = path.resolve(import.meta.dir, "../../..")
const log = (text: string) => console.log(`[extension-isolation-smoke] ${text}`)
const args = process.argv.slice(2)
const command = args[0]
const option = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

if (command === "--build-web") {
  const fixture = args[1]!
  const dependencies = args[2]!
  const id = args[3]!
  const require = createRequire(path.join(dependencies, "packages/extension-kit/package.json"))
  const { build } = await import(pathToFileURL(require.resolve("vite")).href)
  const { default: extensionKit } = await import(pathToFileURL(path.join(repo, "packages/extension-kit/vite.js")).href)
  await build({
    root: fixture,
    configFile: false,
    logLevel: "warn",
    cacheDir: path.join(fixture, "vite-cache"),
    plugins: extensionKit({
      scope: id,
      entry: path.join(fixture, "src/web.tsx"),
      outDir: path.join(fixture, "dist/web"),
    }),
  })
} else if (command === "prepare") {
  await prepare()
} else if (command === "mock") {
  await mock(await load(args[1]))
} else if (command === "check") {
  await check(await load(args[1]))
} else {
  log("Commands: prepare [--deps LOCAL_REPO] | mock ROOT | check ROOT --backend http://127.0.0.1:PORT")
  if (command && command !== "--help") process.exitCode = 1
}

type Run = {
  owner: "opencode.extension-isolation-smoke"
  root: string
  token: string
  password: string
  project: string
  registry: string
  ids: { hang: string; dispose: string; healthy: string }
  tools: { hello: string; throwing: string }
}

async function load(directory: string | undefined): Promise<Run> {
  assert.ok(directory, "ROOT is required")
  const root = await realpath(directory)
  const run = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as Run
  assert.equal(run.owner, "opencode.extension-isolation-smoke")
  assert.equal(run.root, root)
  assert.match(run.token, /^[a-f0-9]{12}$/)
  assert.equal(run.project, path.join(root, "project"))
  assert.equal(run.registry, path.join(root, "registry/registry.json"))
  return run
}

async function json(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2) + "\n")
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

async function prepare() {
  // Dependency roots are read-only. Bun's module paths are inherited only by our build child.
  const dependencies = path.resolve(option("--deps") ?? repo)
  const require = createRequire(path.join(dependencies, "packages/extension-kit/package.json"))
  for (const name of ["vite", "vite-plugin-solid"]) require.resolve(name)
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-extension-isolation-")))
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const run: Run = {
    owner: "opencode.extension-isolation-smoke",
    root,
    token,
    password: randomUUID(),
    project: path.join(root, "project"),
    registry: path.join(root, "registry/registry.json"),
    ids: {
      hang: `smoke.${token}-a-hang-activate`,
      dispose: `smoke.${token}-b-throw-dispose`,
      healthy: `smoke.${token}-c-healthy`,
    },
    tools: { hello: `iso_hello_${token}`, throwing: `iso_throw_${token}` },
  }
  log(`PREPARING root=${root}`)
  for (const dir of [
    "project",
    "registry",
    "config/opencode/node_modules",
    "data",
    "cache",
    "state",
    "home",
    "tmp",
    "managed",
  ])
    await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 })
  await json(path.join(root, "run.json"), run)
  // Config.loadInstanceState always requests @opencode-ai/plugin. An empty node_modules plus
  // matching lock root bypasses Npm.install's reify path; these fixtures have no bare server imports.
  const dependenciesLocked = { "@opencode-ai/plugin": "0.0.0" }
  await json(path.join(root, "config/opencode/package.json"), { private: true, dependencies: dependenciesLocked })
  await json(path.join(root, "config/opencode/package-lock.json"), {
    lockfileVersion: 3,
    packages: { "": { dependencies: dependenciesLocked } },
  })
  await Bun.write(path.join(root, "models.json"), "{}\n")
  await Bun.write(path.join(root, "fixture-events.jsonl"), "")
  await Bun.write(path.join(root, "model-events.jsonl"), "")
  const rows: Record<string, unknown> = {}
  for (const [kind, id] of Object.entries(run.ids)) {
    const directory = path.join(root, "fixtures", kind)
    await mkdir(path.join(directory, "dist/server"), { recursive: true })
    await json(path.join(directory, "package.json"), {
      name: `extension-isolation-${kind}-${token}`,
      version: "0.0.0",
      type: "module",
      exports: {
        "./server": "./dist/server/index.js",
        ...(kind === "healthy" ? { "./web": "./dist/web/index.js" } : {}),
      },
      opencode: {
        manifestVersion: 1,
        id,
        displayName: `Isolation fixture: ${kind}`,
        ...(kind === "healthy"
          ? {
              web: { apiVersion: 1 },
              activation: ["onStartup", `onTool:${run.tools.hello}`, `onTool:${run.tools.throwing}`],
              contributes: { toolRenderers: [{ tool: run.tools.hello }, { tool: run.tools.throwing }] },
            }
          : {}),
      },
    })
    const event = `const event = async (phase) => { const line = JSON.stringify({ id: ${JSON.stringify(id)}, phase, at: Date.now() }); console.log('[isolation-fixture] ' + line); await appendFile(${JSON.stringify(path.join(root, "fixture-events.jsonl"))}, line + '\\n'); };`
    const service =
      kind === "hang"
        ? `await event('activate-hanging'); return new Promise(() => {});`
        : `await event('activate-ready'); return { rpc: { ping: async () => ({ token: ${JSON.stringify(token)}, id: ${JSON.stringify(id)} }) }, dispose: async () => { await event('dispose-start'); ${kind === "dispose" ? "throw new Error('ISOLATION_THROW_DISPOSE');" : ""} } };`
    const tools =
      kind === "healthy"
        ? `tool: {
          ${run.tools.hello}: { description: 'Local isolation hello fixture', args: {}, execute: async () => { await event('hello-executed'); return 'HELLO_OK_${token}'; } },
          ${run.tools.throwing}: { description: 'Successful tool with intentionally broken web renderer', args: {}, execute: async () => { await event('throw-card-executed'); return 'THROW_CARD_TOOL_OK_${token}'; } }
        },`
        : ""
    await Bun.write(
      path.join(directory, "dist/server/index.js"),
      `import { appendFile } from 'node:fs/promises';\n${event}\nexport default { id: ${JSON.stringify(id)}, async activate() { ${service} }, async server() { await event('server-ready'); return { ${tools} dispose: async () => { await event('hooks-dispose-start'); ${kind === "dispose" ? "throw new Error('ISOLATION_THROW_HOOKS_DISPOSE');" : ""} } }; } };\n`,
    )
    rows[id] = {
      name: `extension-isolation-${kind}-${token}`,
      version: "0.0.0",
      source: { type: "path", path: directory },
      dir: directory,
      enabled: true,
      installedAt: Date.now(),
      revision: 0,
    }
  }
  const healthy = path.join(root, "fixtures/healthy")
  await mkdir(path.join(healthy, "src"))
  await Bun.write(
    path.join(healthy, "src/web.tsx"),
    `
export default {
  id: ${JSON.stringify(run.ids.healthy)}, apiVersion: 1,
  activate(context) {
    context.log.info('ISOLATION_WEB_ACTIVATE_${token}');
    const good = context.toolRenderers.register({ tool: ${JSON.stringify(run.tools.hello)}, component: (props) => <div data-isolation-healthy=${JSON.stringify(token)}>HEALTHY_SIBLING_${token}: {props.output}</div> });
    const bad = context.toolRenderers.register({ tool: ${JSON.stringify(run.tools.throwing)}, component: () => { context.log.error('ISOLATION_RENDER_THROW_${token}'); throw new Error('ISOLATION_RENDER_THROW_${token}'); } });
    return () => { good.dispose(); bad.dispose(); };
  }
};\n`,
  )
  const child = Bun.spawn([process.execPath, import.meta.path, "--build-web", healthy, dependencies, run.ids.healthy], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      NODE_PATH: path.join(dependencies, "packages/extension-kit/node_modules"),
    },
    stdout: Bun.file(path.join(root, "web-build.log")),
    stderr: Bun.file(path.join(root, "web-build-errors.log")),
  })
  const stop = () => child.kill("SIGKILL")
  const timer = setTimeout(stop, 60000)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    assert.equal(await child.exited, 0, `Web build failed; see ${root}/web-build-errors.log`)
  } finally {
    clearTimeout(timer)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
  const bundle = await Bun.file(path.join(healthy, "dist/web/index.js")).text()
  assert.ok(bundle.includes("__OPENCODE_EXTENSION_HOST__"), "Bundle must use extension-kit shared host shim")
  await json(run.registry, { version: 2, revision: 0, extensions: rows, receipts: {}, retained: {} })
  await json(path.join(root, "config/opencode/opencode.json"), config(run, "http://127.0.0.1:1/v1"))
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    OPENCODE_EXTENSION_REGISTRY_FILE: run.registry,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PRUNE: "true",
    OPENCODE_SERVER_PASSWORD: run.password,
    OPENCODE_SERVER_USERNAME: "opencode",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_USERCONFIG: path.join(root, "home/.npmrc"),
  }
  await Bun.write(path.join(root, "home/.npmrc"), "offline=true\naudit=false\nfund=false\n")
  await Bun.write(
    path.join(root, "start-backend.sh"),
    `#!/bin/sh\nset -eu\n# Foreground backend: caller owns its lifetime. No Electron, service election, or installed CLI.\nbackend=\"\${1:?pass the worktree under test}\"\nport=\"\${2:-0}\"\ntest -f ${shell(path.join(root, "mock-state.json"))}\ntest -f \"$backend/packages/opencode/src/index.ts\"\nprintf '%s\\n' ${shell(`[extension-isolation-smoke] backend log=${root}/backend.log`)}\ncd ${shell(run.project)}\nexec env -i ${Object.entries(
      environment,
    )
      .map(([key, value]) => `${key}=${shell(value)}`)
      .join(
        " ",
      )} ${shell(process.execPath)} run --conditions=browser \"$backend/packages/opencode/src/index.ts\" serve --hostname 127.0.0.1 --port \"$port\" --print-logs >>${shell(path.join(root, "backend.log"))} 2>&1\n`,
  )
  await chmod(path.join(root, "start-backend.sh"), 0o700)
  await Bun.write(
    path.join(root, "FIXTURES.txt"),
    `Prepared offline extension isolation fixture ${token}\n\nThree random-ID path extensions in this root ONLY:\n- ${run.ids.hang}: activate returns a never-settling Promise (not CPU starvation).\n- ${run.ids.dispose}: process and instance dispose throw distinguishable errors.\n- ${run.ids.healthy}: hello + successful tool with throwing renderer, service ping.\n\nWeb bundle uses this worktree's extension-kit/vite.js and local Vite/Solid dependencies.\nNo npm/bun install, backend, Electron, CDP or external model is started by prepare.\nStart mock first, then let the main session run start-backend.sh WORKTREE [PORT].\nA backend needs its own already-installed, compatible dependencies; this script does not install/link them.\nThe launcher clears inherited environment/credentials, isolates HOME/XDG/TMP/registry/auth, disables models fetch/update, uses offline npm, and avoids config dependency reify using a lock-root fixture.\nThis is not an OS network sandbox: only the model fixture is strictly loopback; enforce OS egress denial separately if required.\nNever use dev:live/service discovery, a live renderer's SDK, shared registry, or installed app.\n\ncheck performs strict identity checks before writes, sends two real messages in owned sessions, verifies tool completion, model's tool-result receipt and final text, disables only the owned throw-dispose extension, then verifies a second healthy session.\nFailed identity checks never trigger backend mutation. Failed requests have bounded timeouts and evidence.json records failure, not pass.\nIt never kills an externally started backend or removes artifacts. Stop the foreground backend in its owning terminal; stop mock with Ctrl-C. Remove only this printed root after all owned processes have stopped.\n\nUI verification is NOT performed by check. In a separately isolated renderer connected ONLY to this backend, open evidence.json's first session. Assert ISOLATION_RENDER_THROW_${token} in renderer logs, fallback local to the throwing card, [data-isolation-healthy=\"${token}\"] remains visible and input can send/receive another message.\nUse chromium.connectOverCDP(endpoint, { noDefaults: true }); do not connect shared Electron.\nA DOM-only test or healthy backend reply does NOT prove renderer containment.\n\nEvidence files: run.json (private local password), fixture-events.jsonl, model-events.jsonl, web-build*.log, backend.log, evidence.json (after check), backend data/opencode/log.\n`,
  )
  log(`PREPARED root=${root} registry=${run.registry} extensions=${Object.values(run.ids).join(",")}`)
  log(`NEXT mock: ${process.execPath} ${import.meta.path} mock ${shell(root)}`)
  log(`MAIN ONLY backend: ${shell(path.join(root, "start-backend.sh"))} /worktree/under/test 0`)
  log(`CHECK: ${process.execPath} ${import.meta.path} check ${shell(root)} --backend http://127.0.0.1:PORT`)
}

function config(run: Run, baseURL: string) {
  return {
    model: "isolation/isolation-model",
    small_model: "isolation/isolation-model",
    enabled_providers: ["isolation"],
    plugin: [],
    mcp: {},
    lsp: false,
    formatter: false,
    snapshot: false,
    share: "disabled",
    autoupdate: false,
    permission: { "*": "deny", [run.tools.hello]: "allow", [run.tools.throwing]: "allow" },
    tools: { "*": false, [run.tools.hello]: true, [run.tools.throwing]: true },
    provider: {
      isolation: {
        npm: "@ai-sdk/openai-compatible",
        name: "Loopback isolation mock",
        options: { baseURL, apiKey: run.token },
        models: { "isolation-model": { name: "Isolation fixture", limit: { context: 65536, output: 4096 } } },
      },
    },
  }
}

async function mock(run: Run) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ token: run.token })
      if (request.headers.get("authorization") !== `Bearer ${run.token}`)
        return new Response("Unauthorized", { status: 401 })
      if (url.pathname === "/v1/models")
        return Response.json({ object: "list", data: [{ id: "isolation-model", object: "model", owned_by: "local" }] })
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST")
        return new Response("Not found", { status: 404 })
      const body = (await request.json()) as {
        stream?: boolean
        messages: { role: string; content: unknown }[]
        tools?: { function: { name: string } }[]
      }
      const lastUser = body.messages.findLastIndex((message) => message.role === "user")
      const prompt = JSON.stringify(body.messages[lastUser]?.content)
      const toolNames = body.tools?.map((item) => item.function.name) ?? []
      const scenario = prompt.includes(`ISOLATION_SMOKE_${run.token}`) && toolNames.includes(run.tools.hello)
      const results = body.messages.slice(lastUser + 1).filter((message) => message.role === "tool")
      const hello = results.some((item) => JSON.stringify(item.content).includes(`HELLO_OK_${run.token}`))
      const throwing = results.some((item) => JSON.stringify(item.content).includes(`THROW_CARD_TOOL_OK_${run.token}`))
      const calls =
        scenario && !results.length
          ? [run.tools.hello, run.tools.throwing].map((name, index) => ({
              index,
              id: `call_${run.token}_${index}`,
              type: "function",
              function: { name, arguments: "{}" },
            }))
          : undefined
      const text = scenario
        ? hello && throwing
          ? `ISOLATION_DONE_${run.token}`
          : `ISOLATION_MISSING_TOOL_RESULT_${run.token}`
        : "Local isolation fixture"
      await appendFile(
        path.join(run.root, "model-events.jsonl"),
        JSON.stringify({
          at: Date.now(),
          scenario,
          toolNames,
          toolResults: results.length,
          hello,
          throwing,
          finish: calls ? "tool_calls" : "stop",
        }) + "\n",
      )
      log(`MODEL scenario=${scenario} toolResults=${results.length} hello=${hello} throwing=${throwing}`)
      const common = { id: `chatcmpl-${run.token}`, created: 0, model: "isolation-model" }
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: calls ? null : text,
                ...(calls ? { tool_calls: calls.map(({ index, ...call }) => call) } : {}),
              },
              finish_reason: calls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      const chunks = [{ role: "assistant" }, calls ? { tool_calls: calls } : { content: text }, {}].map(
        (delta, index) => ({
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: index === 2 ? (calls ? "tool_calls" : "stop") : null }],
        }),
      )
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  const baseURL = `${server.url}v1`
  await json(path.join(run.root, "config/opencode/opencode.json"), config(run, baseURL))
  await json(path.join(run.root, "mock-state.json"), { token: run.token, pid: process.pid, baseURL })
  log(`MOCK_READY root=${run.root} baseURL=${baseURL} pid=${process.pid}; Ctrl-C stops only mock`)
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true)
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
      log("MOCK_STOPPED artifacts retained; externally owned backend untouched")
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

async function check(run: Run) {
  const backend = new URL(option("--backend") ?? "http://invalid")
  assert.equal(backend.protocol, "http:")
  assert.equal(backend.hostname, "127.0.0.1", "Only explicit IPv4 loopback is permitted")
  assert.equal(backend.pathname, "/")
  assert.ok(backend.port && !backend.username && !backend.password && !backend.search && !backend.hash)
  const events: { step: string; at: number; detail?: unknown }[] = []
  const sessions: string[] = []
  let verified = false
  const record = (step: string, detail?: unknown) => {
    events.push({ step, at: Date.now(), detail })
    log(`${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`)
  }
  const api = async (route: string, method = "GET", body?: unknown, timeout = 45000): Promise<unknown> => {
    if (method !== "GET") assert.ok(verified, "Backend identity must be verified before mutation")
    const response = await fetch(new URL(route, backend), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${run.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(run.project),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${route}: HTTP ${response.status} ${await response.clone().text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  type Message = {
    info: { role: string; error?: unknown }
    parts: { type: string; text?: string; tool?: string; state?: { status: string; output?: string } }[]
  }
  const send = async () => {
    const session = (await api("/session", "POST", { title: `Extension isolation ${run.token}` })) as { id: string }
    assert.match(session.id, /^ses_/)
    sessions.push(session.id)
    record("MESSAGE_SEND", { sessionID: session.id })
    await api(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "isolation", modelID: "isolation-model" },
      parts: [{ type: "text", text: `ISOLATION_SMOKE_${run.token}` }],
    })
    const history = (await api(`/session/${session.id}/message`)) as Message[]
    assert.ok(
      history.some(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.text === `ISOLATION_SMOKE_${run.token}`),
      ),
    )
    assert.ok(!history.some((message) => message.info.error), "Assistant reported an error")
    for (const [tool, output] of [
      [run.tools.hello, `HELLO_OK_${run.token}`],
      [run.tools.throwing, `THROW_CARD_TOOL_OK_${run.token}`],
    ])
      assert.ok(
        history.some((message) =>
          message.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === tool &&
              part.state?.status === "completed" &&
              part.state.output?.includes(output!),
          ),
        ),
        `Missing completed tool: ${tool}`,
      )
    assert.ok(
      history.some(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.some((part) => part.type === "text" && part.text?.includes(`ISOLATION_DONE_${run.token}`)),
      ),
      "No final response after actual tool results",
    )
    const modelEvents = await readFile(path.join(run.root, "model-events.jsonl"), "utf8")
    assert.ok(
      modelEvents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((item) => item.scenario && item.hello && item.throwing),
    )
    record("MESSAGE_RECEIVED", {
      sessionID: session.id,
      messages: history.length,
      completedTools: [run.tools.hello, run.tools.throwing],
    })
  }
  try {
    await api("/global/health", "GET", undefined, 5000)
    const list = (await api("/global/extension")) as { id: string; enabled: boolean }[]
    assert.deepEqual(
      list.map((item) => item.id).sort(),
      Object.values(run.ids).sort(),
      "Refuse any registry other than the three random fixture IDs",
    )
    assert.ok(
      list.every((item) => item.enabled),
      "Fixtures must start enabled; prepare a fresh root for each run",
    )
    const paths = (await api("/path")) as { home: string; state: string; config: string; directory: string }
    assert.equal(paths.home, path.join(run.root, "home"))
    assert.equal(paths.state, path.join(run.root, "state/opencode"))
    assert.equal(paths.config, path.join(run.root, "config/opencode"))
    assert.equal(paths.directory, run.project)
    const current = (await api("/config")) as {
      model: string
      enabled_providers: string[]
      provider: { isolation: { options: { baseURL: string } } }
    }
    const model = JSON.parse(await readFile(path.join(run.root, "mock-state.json"), "utf8")) as {
      token: string
      baseURL: string
    }
    assert.equal(model.token, run.token)
    assert.equal(current.model, "isolation/isolation-model")
    assert.deepEqual(current.enabled_providers, ["isolation"])
    assert.equal(current.provider.isolation.options.baseURL, model.baseURL)
    const mockURL = new URL(model.baseURL)
    assert.equal(mockURL.hostname, "127.0.0.1")
    const health = (await fetch(new URL("/health", mockURL), {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    }).then((response) => response.json())) as { token: string }
    assert.equal(health.token, run.token)
    verified = true
    record("IDENTITY_VERIFIED", { backend: backend.href, registry: run.registry, paths })
    const ping = (await api(`/extension/${run.ids.dispose}/rpc/ping`, "POST", {})) as { result: { token: string } }
    assert.equal(ping.result.token, run.token)
    record("THROW_DISPOSE_ACTIVATED")
    await send()
    const activationEvents = await readFile(path.join(run.root, "fixture-events.jsonl"), "utf8")
    assert.ok(
      activationEvents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((event) => event.id === run.ids.hang && event.phase === "activate-hanging"),
      "Hang fixture was never attempted; a healthy reply alone does not prove isolation",
    )
    record("HANG_ACTIVATE_ISOLATED")
    await api(`/global/extension/${run.ids.dispose}/disable`, "POST")
    const fixtureEvents = await readFile(path.join(run.root, "fixture-events.jsonl"), "utf8")
    assert.ok(
      fixtureEvents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((event) => event.id === run.ids.dispose && event.phase === "dispose-start"),
      "Throw-dispose fixture was not exercised",
    )
    record("THROW_DISPOSE_EXERCISED")
    await api("/global/health", "GET", undefined, 5000)
    await send()
    record("PASS_BACKEND_ONLY", { uiVerified: false })
    await json(path.join(run.root, "evidence.json"), {
      result: "pass-backend-only",
      uiVerified: false,
      sessions,
      events,
    })
  } catch (error) {
    record("FAIL", { error: String(error), verified })
    await json(path.join(run.root, "evidence.json"), { result: "fail", uiVerified: false, sessions, events })
    process.exitCode = 1
  } finally {
    // Keep owned sessions for isolated-renderer/CDP follow-up; never mutate a failed-identity backend.
    const backendLog = await readFile(path.join(run.root, "backend.log"), "utf8").catch(
      () => "No backend.log; launcher may not have been used",
    )
    log(`BACKEND_LOG_TAIL ${JSON.stringify(backendLog.split("\n").slice(-60).join("\n"))}`)
    log(`EVIDENCE ${run.root}/evidence.json; retainedSessions=${sessions.join(",")}; no external process stopped`)
  }
}
