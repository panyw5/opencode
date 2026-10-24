#!/usr/bin/env bun
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRemoteGateway } from "../src/main/remote/gateway"

// A deterministic provider exercises the real sidecar without using user data,
// provider credentials, or paid model requests.
const marker = "REMOTE_ACCESS_SIDECAR_OK"
const responsiveFixture = process.argv.includes("--responsive")
const taskCardsFixture = process.argv.includes("--task-cards")
const presenceFixture = process.argv.includes("--presence")
const permissionFixture = process.argv.includes("--permission")
const permissionMarker = "REMOTE_PERMISSION_TOOL_OK"
const delayFlag = process.argv.find((arg) => arg.startsWith("--completion-delay="))
const completionDelay = Math.min(10_000, Math.max(0, Number(delayFlag?.split("=")[1]) || 0))
const completion = responsiveFixture
  ? `${marker}\n\n## Responsive layout review\n\nThe workspace is ready. This conversation has a deliberately long title and model name.\n\n| File | Result |\n| --- | --- |\n| packages/app/src/components/session/session-header.tsx | Reviewed |\n\n\`\`\`typescript\nconst veryLongLine = "${"unbroken-long-code-segment-".repeat(12)}"\n\`\`\`\n\nhttps://example.invalid/${"unbrokenpath".repeat(18)}\n\n1. Keep the conversation readable.\n2. Keep every message control reachable.\n3. Review changes without covering the conversation.`
  : marker
const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-remote-e2e-")))
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const project = join(root, "project")
const webRoot = join(root, "web")
await mkdir(project, { recursive: true })
await mkdir(webRoot, { recursive: true })
await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Remote access QA</title>")
await writeFile(
  join(project, "AGENTS.md"),
  permissionFixture
    ? "This is an isolated remote permission test. Only run the harmless printf requested by the test.\n"
    : "This is an isolated remote-access test. Do not use tools.\n",
)
const password = randomBytes(32).toString("hex")
let modelCalls = 0
let backendLogs = ""
let backend: ReturnType<typeof Bun.spawn> | undefined
let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined
let bridge: { origin: string; close(): Promise<void> } | undefined
const useTunnel = process.argv.includes("--tunnel")
const holdForBrowser = process.argv.includes("--hold")
const webRootFlag = process.argv.indexOf("--web-root")
const browserWebRoot = webRootFlag >= 0 ? process.argv[webRootFlag + 1] : undefined
const sidecarFlag = process.argv.indexOf("--sidecar")
const packagedSidecar = sidecarFlag >= 0 ? process.argv[sidecarFlag + 1] : undefined
if (sidecarFlag >= 0 && (!packagedSidecar || packagedSidecar.startsWith("--")))
  throw new Error("--sidecar requires a packaged executable")
if (webRootFlag >= 0 && (!browserWebRoot || browserWebRoot.startsWith("--"))) {
  throw new Error("--web-root requires a compiled web directory")
}

async function createNodeBridge(target: string) {
  const build = await Bun.build({
    entrypoints: [resolve(desktop, "../remote-tunnel/scripts/qa-bridge.ts")],
    outdir: join(root, "bridge"),
    target: "node",
    format: "esm",
    naming: "[name].mjs",
  })
  assert(build.success, "Node QA bridge could not be built")
  const child = Bun.spawn(["node", "--use-system-ca", "--use-env-proxy", join(root, "bridge/qa-bridge.mjs"), target], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" },
  })
  const errors = new Response(child.stderr).text()
  let stopping: Promise<void> | undefined
  const close = () => {
    if (stopping) return stopping
    stopping = (async () => {
      child.stdin.end()
      await Promise.race([child.exited, Bun.sleep(15_000)])
      if (child.exitCode === null) child.kill("SIGTERM")
      await Promise.race([child.exited, Bun.sleep(3_000)])
      if (child.exitCode === null) child.kill("SIGKILL")
      assert((await child.exited) === 0, "Node QA bridge could not cleanly revoke its temporary identity")
    })()
    return stopping
  }
  try {
    const reader = child.stdout.getReader()
    let text = ""
    const timeout = setTimeout(() => child.kill("SIGTERM"), 190_000)
    try {
      while (!text.includes("\n")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`Node bridge exited before ready: ${(await errors).slice(0, 160)}`)
        text += new TextDecoder().decode(chunk.value)
        assert(text.length < 4096, "Node bridge emitted invalid startup metadata")
      }
    } finally {
      clearTimeout(timeout)
      reader.releaseLock()
    }
    const { origin } = JSON.parse(text.split("\n")[0]) as { origin: string }
    assert(
      typeof origin === "string" && new URL(origin).protocol === "https:",
      "Node bridge returned an invalid origin",
    )
    return { origin, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function remoteRequest(url: string, init?: RequestInit): Promise<Response> {
  if (!useTunnel) return fetch(url, init)
  // The shipped runtime is Node/Electron. Use its system trust store for the
  // public HTTPS client too, rather than this test runner's older Bun TLS stack.
  const client = Bun.spawn(
    [
      "node",
      "--use-system-ca",
      "--use-env-proxy",
      "--input-type=module",
      "--eval",
      `
    import http from 'node:http';
    http.setGlobalProxyFromEnv?.();
    try {
      let input=''; for await (const chunk of process.stdin) input+=chunk;
      const {url,method,headers,body}=JSON.parse(input);
      const response=await fetch(url,{method,headers,body,signal:AbortSignal.timeout(90000)});
      const bytes=Buffer.from(await response.arrayBuffer());
      process.stdout.write(JSON.stringify({status:response.status,headers:[...response.headers],body:bytes.toString('base64')}));
    } catch(error) {
      process.stderr.write(String(error?.cause?.code??error?.code??error?.name??'REMOTE_FETCH_FAILED'));
      process.exitCode=1;
    }
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  client.stdin.write(
    JSON.stringify({
      url,
      method: init?.method ?? "GET",
      headers: [...new Headers(init?.headers)],
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    }),
  )
  client.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
    client.exited,
  ])
  assert(code === 0, `Node public HTTPS request failed: ${stderr.slice(0, 160)}`)
  const result = JSON.parse(stdout) as { status: number; headers: Array<[string, string]>; body: string }
  return new Response(result.status === 204 ? null : Buffer.from(result.body, "base64"), {
    status: result.status,
    headers: result.headers,
  })
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address !== "string", "Listener has no TCP address")
  return `http://127.0.0.1:${address.port}`
}

const modelServer = createServer(async (request, response) => {
  let requestBody = ""
  for await (const chunk of request) requestBody += chunk.toString()
  const input = JSON.parse(requestBody) as {
    messages?: Array<{ role: string }>
    tools?: Array<{ function?: { name: string } }>
  }
  const asksPermission =
    permissionFixture &&
    input.tools?.some((tool) => tool.function?.name === "bash") &&
    input.messages?.at(-1)?.role !== "tool"
  modelCalls += 1
  const event = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id: `qa-${modelCalls}`,
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
            id: `call_qa_permission_${modelCalls}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `printf ${permissionMarker}`,
                description: "Harmless isolated permission test",
                timeout: 10000,
              }),
            },
          },
        ],
      }
    : { role: "assistant", content: completion }
  response.write(`data: ${JSON.stringify(event(delta, null))}\n\n`)
  if (completionDelay) await Bun.sleep(completionDelay)
  response.end(`data: ${JSON.stringify(event({}, asksPermission ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`)
})

async function run() {
  const modelUrl = await listen(modelServer)
  const reserve = createServer()
  const backendUrl = await listen(reserve)
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  const port = new URL(backendUrl).port
  const config = {
    model: "remote-qa/echo",
    small_model: "remote-qa/echo",
    snapshot: false,
    autoupdate: false,
    permission: permissionFixture ? { "*": "deny", bash: "ask" } : { "*": "deny" },
    provider: {
      "remote-qa": {
        npm: "@ai-sdk/openai-compatible",
        name: "Isolated QA provider",
        options: { baseURL: `${modelUrl}/v1`, apiKey: "isolated-test-key" },
        models: {
          echo: {
            name: responsiveFixture
              ? "Deterministic QA echo with an intentionally very long model name"
              : "Deterministic QA echo",
            tool_call: permissionFixture,
            limit: { context: 32_768, output: 2_048 },
          },
        },
      },
    },
  }
  backend = Bun.spawn(
    [
      ...(packagedSidecar
        ? [resolve(packagedSidecar)]
        : [process.execPath, "run", "--conditions=browser", "./src/index.ts"]),
      "--pure",
      "--print-logs",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      port,
    ],
    {
      cwd: resolve(desktop, "../opencode"),
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
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const bytes of stream) {
      backendLogs = (backendLogs + new TextDecoder().decode(bytes)).slice(-512_000)
    }
  }
  const logReaders = [
    consume(backend.stdout as ReadableStream<Uint8Array>),
    consume(backend.stderr as ReadableStream<Uint8Array>),
  ]
  const internalHeaders = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  const deadline = Date.now() + 90_000
  let healthy = false
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`Sidecar exited before ready (${backend.exitCode})`)
    healthy = await fetch(`${backendUrl}/global/health`, {
      headers: internalHeaders,
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (healthy) break
    await Bun.sleep(250)
  }
  assert(healthy, "Sidecar did not become healthy")
  console.log("[remote-e2e] isolated sidecar healthy")
  if (packagedSidecar) {
    await writeFile(
      join(root, "package-worker-input.json"),
      JSON.stringify({
        upstream: { url: backendUrl, username: "opencode", password },
        project,
        permission: permissionFixture,
        config,
      }),
      { mode: 0o600 },
    )
    console.log("[remote-e2e] packaged sidecar fixture metadata saved privately")
  }
  gateway = await createRemoteGateway({
    upstream: () => ({ url: backendUrl, username: "opencode", password }),
    webRoot: holdForBrowser ? resolve(browserWebRoot ?? join(desktop, "resources/remote-web")) : webRoot,
    saveAuth: async (snapshot) => {
      assert(!JSON.stringify(snapshot).includes(password), "Internal password entered auth snapshot")
    },
    log: (line) => console.log(`[remote-e2e] ${line}`),
    allowHttpForTests: !useTunnel,
  })
  let origin = gateway.url
  if (useTunnel) {
    bridge = await createNodeBridge(gateway.url.replace(/^http:\/\//, ""))
    origin = bridge.origin
    console.log("[remote-e2e] real OpenTunnel bridge ready")
  }
  gateway.setPublicOrigin(origin)
  console.log("[remote-e2e] public pairing request started")
  const invite = await gateway.createPairing(origin)
  const response = await remoteRequest(`${origin}/remote/api/pair/redeem`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: new URL(invite.url).hash.slice(1), name: "Isolated E2E browser" }),
    signal: AbortSignal.timeout(30_000),
  })
  assert(response.ok, `Pairing failed: ${response.status}`)
  const cookie = response.headers.get("set-cookie")?.split(";")[0]
  assert(cookie, "Pairing did not issue a cookie")
  const sessionResponse = await remoteRequest(`${origin}/remote/api/session`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(30_000),
  })
  const session = (await sessionResponse.json()) as { csrfToken: string }
  assert(sessionResponse.ok && session.csrfToken, "Browser session not authenticated")
  const headers = {
    Cookie: cookie,
    Origin: origin,
    "x-opencode-csrf": session.csrfToken,
    "Content-Type": "application/json",
  }
  const query = `?directory=${encodeURIComponent(project)}`
  const remoteFetch = (path: string, init?: RequestInit) =>
    remoteRequest(`${origin}${path}${query}`, { ...init, headers, signal: AbortSignal.timeout(90_000) })
  assert((await remoteFetch("/global/health")).ok, "Remote sidecar health unavailable")
  const safeConfig = await remoteFetch("/config").then((result) => result.text())
  assert(!safeConfig.includes("isolated-test-key"), "Provider key leaked from queried config")
  const catalogResponse = await remoteFetch("/provider")
  const catalogText = await catalogResponse.text()
  assert(catalogResponse.ok, "Remote model catalog unavailable")
  assert(!catalogText.includes("isolated-test-key"), "Provider key leaked from model catalog")
  const catalog = JSON.parse(catalogText) as {
    all?: Array<{ id: string; models?: Record<string, { name?: string }> }>
    connected?: string[]
  }
  assert(
    catalog.connected?.includes("remote-qa") &&
      catalog.all
        ?.find((provider) => provider.id === "remote-qa")
        ?.models?.echo?.name?.startsWith("Deterministic QA echo"),
    "Safe model catalog lost the connected provider or model display metadata",
  )
  console.log("[remote-e2e] credential-free model catalog verified")
  const created = await remoteFetch("/session", {
    method: "POST",
    body: JSON.stringify({
      title: responsiveFixture
        ? "Review uncommitted changes across a very long OpenCode workspace session title"
        : "Remote access isolated QA",
    }),
  })
  const createdBody = await created.text()
  assert(created.ok, `Session create failed (${created.status}): ${createdBody.slice(0, 500)}`)
  const createdSession = JSON.parse(createdBody) as { id: string; directory?: string; projectID: string }
  const id = createdSession.id
  assert(id, "Created session has no id")
  console.log(`[remote-e2e] created isolated session=${id}`)
  if (taskCardsFixture) {
    // Seed only this test's isolated sidecar; the public task API stays read-only.
    const opened = await fetch(`${backendUrl}/project/open${query}`, {
      method: "POST",
      headers: internalHeaders,
      signal: AbortSignal.timeout(30_000),
    })
    assert(opened.ok, `Task fixture project registration failed status=${opened.status}`)
    const registered = (await opened.json()) as { id: string }
    // Preconfigure display metadata; public clients cannot mutate project settings.
    const styled = await fetch(`${backendUrl}/project/${registered.id}${query}`, {
      method: "PATCH",
      headers: { ...internalHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ icon: { color: "blue" } }),
      signal: AbortSignal.timeout(30_000),
    })
    assert(styled.ok, `Task fixture project metadata setup failed status=${styled.status}`)
    console.log("[remote-e2e] isolated task project registered as user-visible")
    for (const [route, payload] of [
      [
        "project-task",
        { title: "Mobile project task card QA", description: "Card content should reclaim the icon column." },
      ],
      [
        "scheduled-task",
        {
          projectID: createdSession.projectID,
          directory: project,
          name: "Mobile scheduled task card QA",
          prompt: "Disabled layout fixture; never execute.",
          schedule: { kind: "every", interval: 86_400_000 },
          agent: "build",
          model: { providerID: "remote-qa", modelID: "echo" },
          enabled: false,
          unattended: true,
        },
      ],
    ] as const) {
      const response = await fetch(`${backendUrl}/${route}${query}`, {
        method: "POST",
        headers: { ...internalHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
      assert(
        response.ok,
        `Task card fixture create failed route=${route} status=${response.status}: ${(await response.text()).slice(0, 300)}`,
      )
      console.log(`[remote-e2e] task card fixture created route=${route}`)
    }
  }
  const prompt = await remoteFetch(`/session/${id}/${permissionFixture ? "prompt_async" : "message"}`, {
    method: "POST",
    body: JSON.stringify({
      model: { providerID: "remote-qa", modelID: "echo" },
      parts: [
        {
          type: "text",
          text: permissionFixture
            ? `Run the harmless printf test, then reply ${marker}.`
            : `Reply with exactly ${marker}. Do not use any tools.`,
        },
      ],
    }),
  })
  const promptBody = await prompt.text()
  assert(prompt.ok, `Message send failed (${prompt.status}): ${promptBody.slice(0, 800)}`)
  if (permissionFixture) {
    let pending: { id: string; permission: string } | undefined
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !pending) {
      const permissions = (await remoteFetch("/permission").then((response) => response.json())) as Array<{
        id: string
        sessionID: string
        permission: string
      }>
      pending = permissions.find((permission) => permission.sessionID === id)
      if (!pending) await Bun.sleep(250)
    }
    assert(pending?.permission === "bash", "Expected only the isolated bash permission request")
    console.log("[remote-e2e] isolated bash permission pending; approving via the actual frontend route")
    const reply = await remoteFetch(`/session/${id}/permissions/${pending.id}`, {
      method: "POST",
      body: JSON.stringify({ response: "once" }),
    })
    assert(reply.ok, `Session permission approval failed (${reply.status})`)
    const completeDeadline = Date.now() + 45_000
    let completed = false
    while (Date.now() < completeDeadline) {
      const messages = (await remoteFetch(`/session/${id}/message`).then((response) => response.json())) as Array<{
        info?: { role: string }
        parts?: Array<{ type: string; text?: string; state?: { status: string; output?: string } }>
      }>
      const assistantDone = messages.some(
        (message) =>
          message.info?.role === "assistant" &&
          message.parts?.some((part) => part.type === "text" && part.text?.includes(marker)),
      )
      const toolDone = messages.some((message) =>
        message.parts?.some(
          (part) =>
            part.type === "tool" && part.state?.status === "completed" && part.state.output?.includes(permissionMarker),
        ),
      )
      if (assistantDone && toolDone) {
        completed = true
        break
      }
      await Bun.sleep(250)
    }
    assert(completed, "Approved isolated command and assistant reply did not finish")
    console.log("[remote-e2e] permission approved and harmless tool completed")
  }
  const history = (await remoteFetch(`/session/${id}/message`).then((result) => result.json())) as Array<{
    info?: { role: string }
    parts?: Array<{ type: string; text?: string }>
  }>
  const received = history.some(
    (message) =>
      message.info?.role === "assistant" &&
      message.parts?.some((part) => part.type === "text" && part.text?.includes(marker)),
  )
  assert(
    received && modelCalls > 0,
    `Sidecar did not persist the model response: ${JSON.stringify(history).slice(0, 800)}`,
  )
  console.log(`[remote-e2e] message sent and persisted assistant response verified modelCalls=${modelCalls}`)
  const devices = gateway.devices()
  assert(devices.length === 1, "Expected one paired device")
  await gateway.revoke(devices[0].id)
  assert((await remoteFetch(`/session/${id}`)).status === 401, "Revoked device retained access")
  console.log("[remote-e2e] revoke verified; PASS")
  if (holdForBrowser) {
    const refreshInvite = async () => {
      const browserInvite = await gateway!.createPairing(origin)
      const temporary = join(root, "browser-invite.tmp")
      await writeFile(
        temporary,
        JSON.stringify({
          ...browserInvite,
          directory: createdSession.directory ?? project,
          sessionId: id,
          permission: permissionFixture,
          presence: presenceFixture,
          pid: process.pid,
        }),
        { mode: 0o600 },
      )
      await rename(temporary, join(root, "browser-invite.json"))
    }
    await refreshInvite()
    let snapshotWrite = Promise.resolve()
    const snapshots = presenceFixture
      ? setInterval(() => {
          snapshotWrite = snapshotWrite
            .then(async () => {
              const temporary = join(root, "browser-devices.tmp")
              await writeFile(temporary, JSON.stringify(gateway!.devices()), { mode: 0o600 })
              await rename(temporary, join(root, "browser-devices.json"))
            })
            .catch(() => {})
        }, 500)
      : undefined
    const refresh = setInterval(() => {
      void refreshInvite().catch(() => {})
    }, 30_000)
    console.log(`[remote-e2e] browser fixture ready artifacts=${root}; stop this test with Ctrl-C after CDP checks`)
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
    clearInterval(refresh)
    if (snapshots) clearInterval(snapshots)
    await snapshotWrite
  }
  await bridge?.close()
  bridge = undefined
  await gateway.close()
  gateway = undefined
  backend.kill("SIGTERM")
  await backend.exited
  await Promise.all(logReaders)
}

try {
  await run()
} finally {
  await bridge?.close().catch(() => console.log("[remote-e2e] tunnel-identity-cleanup-failed"))
  await gateway?.close().catch(() => {})
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM")
    await Promise.race([backend.exited, Bun.sleep(3_000)])
    if (backend.exitCode === null) backend.kill("SIGKILL")
  }
  await new Promise<void>((resolve) => modelServer.close(() => resolve()))
  await writeFile(join(root, "sidecar.log"), backendLogs.split(password).join("[redacted]"))
  console.log(`[remote-e2e] isolated artifacts=${root}`)
}
