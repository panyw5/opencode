import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import appPlugin from "../../app/vite.js"
import { CdpClient, connectCdp, listTargets } from "./cdp"
import { projectReadAllowed, sessionContextRules } from "../../core/src/session-context-access"

// Real sidecar/SDK/tool execution, with deterministic local model responses.
// Only an isolated view in the already-running development Electron is opened.
const root = resolve(import.meta.dir, "../../..")
const scratch = await realpath(await mkdtemp(join(tmpdir(), "opencode-context-access-")))
console.log(`[context-access-qa] artifacts=${scratch}`)
const project = join(scratch, "project")
await mkdir(project)
await mkdir(join(scratch, "config/opencode/quick-assistant"), { recursive: true })
const directory = await realpath(project)
const file = join(directory, "fixture.txt")
await Bun.write(file, "QA_PROJECT_CONTENT")
let sourceID = ""
let transcriptID = ""
let readPath = file
let lastToolResult = ""
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { role: string; content: unknown }[]; tools?: unknown[] }
    const messages = body.messages ?? []
    const user = messages.findLastIndex((message) => message.role === "user")
    const prompt = JSON.stringify(messages[user]?.content)
    const result = messages.slice(user + 1).findLast((message) => message.role === "tool")
    const action = body.tools?.length
      ? prompt?.match(
          /QA_(SWITCH_TRANSCRIPT|SWITCH_READ|SAME_PROJECT_READ|TRANSCRIPT|READ|WRITE|BASH|REVOKED|UNKNOWN)/,
        )?.[1]
      : undefined
    const call = action?.endsWith("TRANSCRIPT")
      ? ["session_transcript", { session_id: transcriptID || sourceID }]
      : action === "WRITE"
        ? ["write", { filePath: file, content: "UNEXPECTED_WRITE" }]
        : action === "BASH"
          ? ["bash", { command: "pwd", workdir: directory, description: "Read current directory" }]
          : action === "UNKNOWN"
            ? ["session_transcript", { session_id: "ses_unknown" }]
            : ["read", { filePath: readPath }]
    const delta =
      action && !result
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call_${action}_${Date.now()}`,
                type: "function",
                function: { name: call[0], arguments: JSON.stringify(call[1]) },
              },
            ],
          }
        : { content: action ? `QA_OK_${action}` : "Context access QA" }
    if (result) lastToolResult = JSON.stringify(result.content)
    const chunks = [
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta }] },
      { choices: [{ delta: {}, finish_reason: action && !result ? "tool_calls" : "stop" }] },
    ]
    return new Response(
      chunks
        .map((item) => `data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", ...item })}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    )
  },
})
const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
const port = listener.port!
listener.stop(true)
const backend = `http://127.0.0.1:${port}`
const logFile = join(scratch, "sidecar.log")
const config = {
  model: "qa/qa-model",
  small_model: "qa/qa-model",
  enabled_providers: ["qa"],
  plugin: [],
  lsp: false,
  formatter: false,
  provider: {
    qa: {
      npm: "@ai-sdk/openai-compatible",
      name: "QA",
      options: { baseURL: `${model.url}v1`, apiKey: "qa-only" },
      models: { "qa-model": { name: "QA Model", limit: { context: 65536, output: 4096 } } },
    },
  },
}
const sidecar = Bun.spawn(
  [
    "bun",
    "run",
    "--conditions=browser",
    "./src/index.ts",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
    "--print-logs",
  ],
  {
    cwd: join(root, "packages/opencode"),
    env: {
      ...process.env,
      XDG_DATA_HOME: join(scratch, "data"),
      XDG_CACHE_HOME: join(scratch, "cache"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_STATE_HOME: join(scratch, "state"),
      OPENCODE_TEST_HOME: join(scratch, "home"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(scratch, "managed"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_MODELS_PATH: join(root, "packages/opencode/test/tool/fixtures/models-api.json"),
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
    },
    stdout: Bun.file(logFile),
    stderr: Bun.file(join(scratch, "sidecar-errors.log")),
  },
)
const server = await createServer({
  configFile: false,
  root: join(root, "packages/app"),
  cacheDir: join(scratch, "vite-cache"),
  plugins: [
    appPlugin,
    {
      name: "context-access-qa",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith("/__context-access-qa")) return next()
          void vite
            .transformIndexHtml(
              request.url,
              `<!doctype html><html><head><title>Context access QA</title></head><body><div id="root"></div><script type="module" src="/@fs/${join(import.meta.dir, "fixtures/quick-assistant-context-access.tsx")}"></script></body></html>`,
            )
            .then((html) => {
              response.setHeader("Content-Type", "text/html")
              response.end(html)
            }, next)
        })
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
})
async function wait<T>(read: () => Promise<T | undefined>, description: string, timeout = 60000): Promise<T> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${description}; artifacts=${scratch}`)
}
async function api(path: string, method = "GET", body?: unknown, dir = directory) {
  const response = await fetch(`${backend}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-opencode-directory": dir },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}
let parent: CdpClient | undefined
let cdp: CdpClient | undefined
const viewID = `context-access-qa-${Date.now()}`
const panel = `[data-component="quick-assistant-panel"]:not([hidden])`
let readerID = ""
try {
  // Never launch or terminate an Electron app; require the dev renderer at :9222.
  parent = (await connectCdp()).client
  console.log("[context-access-qa] connected to development Electron")
  await wait(
    async () =>
      (await fetch(`${backend}/global/health`, { signal: AbortSignal.timeout(2000) })).ok ? true : undefined,
    "sidecar health",
  )
  console.log("[context-access-qa] sidecar ready")
  const source = await api("/session", "POST", { title: "Linked source session" })
  sourceID = source.id
  await api(`/session/${sourceID}/message`, "POST", {
    noReply: true,
    parts: [{ type: "text", text: "QA_SOURCE_TRANSCRIPT" }],
  })
  console.log(`[context-access-qa] source seeded session=${sourceID}`)
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/__context-access-qa?${new URLSearchParams({ backend, directory, source: sourceID })}`
  await parent.evaluate(`window.api.browser.open(${JSON.stringify(viewID)},${JSON.stringify(url)})`)
  const target = await wait(
    async () => (await listTargets()).find((item) => item.url === url),
    "isolated Electron view",
  )
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  await cdp.call("Page.bringToFront")
  await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  const visible = (selector: string) => `!!document.querySelector(${JSON.stringify(selector)})`
  const click = async (selector: string) => {
    assert.equal(
      await cdp!.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
      ),
      true,
      `missing ${selector}`,
    )
  }
  const rendered = (expression: string, label: string) =>
    wait(async () => ((await cdp!.evaluate(expression)) ? true : undefined), label)
  const enableContext = async () => {
    const selector = `${panel} [data-action="quick-assistant-context"]`
    const enabled = await cdp!.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-pressed") === "true"`,
    )
    if (!enabled) await click(selector)
    console.log(`[context-access-qa] context enabled existing=${enabled}`)
  }
  await rendered(visible('[data-component="quick-assistant-launcher"]'), "assistant launcher")
  await click('[data-component="quick-assistant-launcher"]')
  await rendered(visible(`${panel} [data-action="quick-assistant-context"]:not(:disabled)`), "context link")
  await enableContext()
  const assertNoAccessUI = async () => {
    assert.equal(
      await cdp!.evaluate(
        `!!document.querySelector('[data-component="quick-assistant-context-access"], [data-action="quick-assistant-project-read"]')`,
      ),
      false,
      "project read is automatic and must not show a permission footer or checkbox",
    )
  }
  await assertNoAccessUI()
  // Empty input legitimately disables send; focus/type before waiting for readiness.
  const prompt = async (text: string) => {
    await rendered(visible(`${panel} [contenteditable="true"]`), "editor ready")
    await rendered(
      `[...document.querySelectorAll(${JSON.stringify(`${panel} button span`)})].some(el => el.textContent === 'QA Model')`,
      "model provider loaded",
    )
    await cdp!.evaluate(`document.querySelector(${JSON.stringify(`${panel} [contenteditable="true"]`)}).focus()`)
    await cdp!.call("Input.insertText", { text })
    await rendered(
      visible(`${panel} [data-action="quick-assistant-submit"][aria-label="Send"]:not(:disabled)`),
      "send enabled and not stop",
    )
    await click(`${panel} [data-action="quick-assistant-submit"]`)
  }
  const received = (marker: string) =>
    rendered(
      `(() => {
        const messages = document.querySelectorAll(${JSON.stringify(`${panel} [data-component="quick-assistant-message"]`)});
        const last = messages[messages.length - 1];
        return last?.dataset.role === 'assistant' && last.textContent.includes(${JSON.stringify(marker)});
      })()`,
      `received ${marker}`,
    )
  await prompt("QA_TRANSCRIPT")
  await received("QA_OK_TRANSCRIPT")
  assert.match(lastToolResult, /QA_SOURCE_TRANSCRIPT/)
  const contextBlock = `${panel} [data-component="quick-assistant-context"]`
  const inspectContext = () =>
    cdp!.evaluate<{
      width: number
      height: number
      available: number
      rightGap: number
      overflow: number
      text: string
    }>(
      `(() => {
        const block = document.querySelector(${JSON.stringify(contextBlock)});
        const box = block.getBoundingClientRect();
        const parent = block.parentElement.getBoundingClientRect();
        return {width:box.width,height:box.height,available:parent.width,rightGap:parent.right-box.right,
          overflow:block.scrollWidth-block.clientWidth,text:block.textContent};
      })()`,
    )
  try {
    for (const width of [1728, 430]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      const compact = await wait(async () => {
        const box = await inspectContext()
        return box.available <= width && box.width > 0 ? box : undefined
      }, `compact context layout at ${width}px`)
      assert.ok(compact.width < compact.available * 0.8, "collapsed context must not stretch across the message")
      assert.ok(compact.height <= 32, "collapsed context must remain a compact single row")
      assert.ok(Math.abs(compact.rightGap) <= 1, "context must align with the user message on the right")
      await click(`${contextBlock} summary`)
      const expanded = await inspectContext()
      assert.ok(expanded.width > compact.width, "expanded context must retain a wide reading area")
      assert.ok(expanded.height > compact.height, "click must reveal the context preview")
      assert.ok(expanded.overflow <= 1, "expanded context must not overflow at narrow widths")
      assert.match(expanded.text, /QA_SOURCE_TRANSCRIPT/)
      await click(`${contextBlock} summary`)
      assert.ok((await inspectContext()).height <= 32, "context must collapse back to one row")
      const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(join(scratch, `context-compact-${width}.png`), Buffer.from(shot.data, "base64"))
      console.log(
        `[context-access-qa] compact context viewport=${width} collapsed=${compact.width}x${compact.height} expanded=${expanded.width}x${expanded.height} rightGap=${compact.rightGap}`,
      )
    }
  } finally {
    await cdp.call("Emulation.clearDeviceMetricsOverride")
  }
  const assistantDir = join(scratch, "config/opencode/quick-assistant")
  readerID = await wait(
    async () =>
      (await api("/session", "GET", undefined, assistantDir)).find((item: { id: string }) => item.id !== sourceID)?.id,
    "assistant session",
  )
  assert.equal((await api("/permission", "GET", undefined, assistantDir)).length, 0)
  console.log("[context-access-qa] linked transcript received without directory access")

  await prompt("QA_READ")
  await received("QA_OK_READ")
  assert.match(lastToolResult, /QA_PROJECT_CONTENT/)
  assert.equal((await api("/permission", "GET", undefined, assistantDir)).length, 0)
  assert.equal(
    projectReadAllowed((await api(`/session/${readerID}`, "GET", undefined, assistantDir)).permission, sourceID),
    true,
  )
  console.log("[context-access-qa] associated project file received by default without permission prompt or opt-in UI")

  const idle = () =>
    wait(async () => {
      const status = await api("/session/status", "GET", undefined, assistantDir)
      return !status[readerID] || status[readerID].type === "idle" ? true : undefined
    }, "assistant idle after rejected tool")

  // Switching the main session grants read access to its linked project on send.
  const originalReader = readerID
  const originalPanel = await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(panel)}).dataset.windowId`)
  const navigate = async (directory: string, sessionID: string, title: string) => {
    await idle()
    await cdp!.evaluate(`window.dispatchEvent(new CustomEvent('context-access-qa:navigate', {
      detail: ${JSON.stringify({ directory, sessionID })}
    }))`)
    await rendered(
      `document.querySelector(${JSON.stringify(`${panel} [data-slot="quick-assistant-context-title"]`)})?.textContent.trim() === ${JSON.stringify(title)}`,
      `context follows main session ${sessionID}`,
    )
    assert.equal(
      await cdp!.evaluate(`document.querySelector(${JSON.stringify(panel)}).dataset.windowId`),
      originalPanel,
    )
    assert.equal(
      await cdp!.evaluate(
        `JSON.parse(sessionStorage.getItem('context-access-qa:opencode.global.dat:quick-assistant')).windows.find(item => item.id === ${JSON.stringify(originalPanel)}).session`,
      ),
      originalReader,
    )
    console.log(`[context-access-qa] main session switched source=${sessionID}; assistant panel retained`)
  }
  const sibling = await api("/session", "POST", { title: "Same project session" })
  await api(`/session/${sibling.id}/message`, "POST", {
    noReply: true,
    parts: [{ type: "text", text: "QA_SIBLING_SOURCE_CONTENT" }],
  })
  await navigate(directory, sibling.id, sibling.title)
  await assertNoAccessUI()
  await prompt("QA_SAME_PROJECT_READ")
  await received("QA_OK_SAME_PROJECT_READ")
  assert.match(lastToolResult, /QA_PROJECT_CONTENT/)
  assert.equal((await api("/permission", "GET", undefined, assistantDir)).length, 0)
  console.log("[context-access-qa] same-project switch reads the linked directory by default")

  const otherDirectory = join(scratch, "other-project")
  await mkdir(otherDirectory)
  const otherFile = join(otherDirectory, "fixture.txt")
  await Bun.write(otherFile, "QA_OTHER_PROJECT_CONTENT")
  const other = await api("/session", "POST", { title: "Other project session" }, otherDirectory)
  await api(
    `/session/${other.id}/message`,
    "POST",
    {
      noReply: true,
      parts: [{ type: "text", text: "QA_OTHER_SOURCE_CONTENT" }],
    },
    otherDirectory,
  )
  await navigate(otherDirectory, other.id, other.title)
  await assertNoAccessUI()
  const beforeSwitchSend = await api(`/session/${readerID}`, "GET", undefined, assistantDir)
  assert.equal(
    beforeSwitchSend.permission.some((rule: { pattern: string }) => rule.pattern === other.id),
    false,
  )
  transcriptID = other.id
  readPath = otherFile
  await prompt("QA_SWITCH_TRANSCRIPT")
  await received("QA_OK_SWITCH_TRANSCRIPT")
  assert.match(lastToolResult, /QA_OTHER_SOURCE_CONTENT/)
  const switchedMessages = await api(`/session/${readerID}/message`, "GET", undefined, assistantDir)
  const switchedUser = switchedMessages.findLast((item: { info: { role: string } }) => item.info.role === "user")
  assert.ok(
    switchedUser.parts.some(
      (part: { type: string; text?: string }) =>
        part.type === "text" && part.text?.includes(`session_id: ${other.id}`) && part.text?.includes(otherDirectory),
    ),
  )
  await prompt("QA_SWITCH_READ")
  await received("QA_OK_SWITCH_READ")
  assert.match(lastToolResult, /QA_OTHER_PROJECT_CONTENT/)
  assert.equal((await api("/permission", "GET", undefined, assistantDir)).length, 0)
  await idle()
  console.log("[context-access-qa] cross-project switch grants read-only access to the newly linked project")
  transcriptID = sourceID
  readPath = file
  await navigate(directory, sourceID, source.title)
  await assertNoAccessUI()
  console.log("[context-access-qa] switching back retained the assistant's linked project grants")

  // A renderer reload retains grants only for the same assistant session.
  const origin = await cdp.evaluate<number>("performance.timeOrigin")
  await cdp.call("Page.reload")
  await cdp.call("Page.bringToFront")
  await rendered(
    `performance.timeOrigin !== ${origin} && !!document.querySelector(${JSON.stringify(`${panel} [contenteditable="true"]`)})`,
    "same-session grant restored after reload",
  )
  await assertNoAccessUI()
  await prompt("QA_READ")
  await received("QA_OK_READ")
  assert.match(lastToolResult, /QA_PROJECT_CONTENT/)
  const originalWindow = await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(panel)}).dataset.windowId`)
  await click(`${panel} [data-action="quick-assistant-add-window"]`)
  await rendered(
    visible(`${panel} [data-action="quick-assistant-context"]:not(:disabled)`),
    "new assistant context link",
  )
  await enableContext()
  await assertNoAccessUI()
  await prompt("QA_READ")
  await received("QA_OK_READ")
  assert.match(lastToolResult, /QA_PROJECT_CONTENT/)
  const separate = await wait(
    async () =>
      (await api("/session", "GET", undefined, assistantDir)).find((item: { id: string }) => item.id !== readerID),
    "new assistant session",
  )
  assert.equal(projectReadAllowed(separate.permission, sourceID), true)
  assert.equal(projectReadAllowed(separate.permission, other.id), false, "new assistants must not inherit old links")
  readPath = otherFile
  await prompt("QA_SWITCH_READ")
  const unlinked = await wait(
    async () =>
      (await api("/permission", "GET", undefined, assistantDir)).find(
        (item: { sessionID: string }) => item.sessionID === separate.id,
      ),
    "unlinked project still requires confirmation",
  )
  assert.equal(unlinked.permission, "external_directory")
  await api(`/permission/${unlinked.id}/reply`, "POST", { reply: "reject" }, assistantDir)
  readPath = file
  await wait(async () => {
    const status = await api("/session/status", "GET", undefined, assistantDir)
    return !status[separate.id] || status[separate.id].type === "idle" ? true : undefined
  }, "new assistant idle")
  await click(`#quick-assistant-tab-${originalWindow}`)
  console.log("[context-access-qa] reload and new assistant use default reads; unrelated project still prompts")

  for (const action of ["WRITE", "BASH"]) {
    await prompt(`QA_${action}`)
    const permission = await wait(
      async () =>
        (await api("/permission", "GET", undefined, assistantDir)).find(
          (item: { sessionID: string }) => item.sessionID === readerID,
        ),
      `${action} directory prompt`,
    )
    assert.equal(permission.permission, "external_directory")
    await api(`/permission/${permission.id}/reply`, "POST", { reply: "reject" }, assistantDir)
    await idle()
  }
  assert.equal(await Bun.file(file).text(), "QA_PROJECT_CONTENT")
  const legacy = await api(`/session/${readerID}`, "GET", undefined, assistantDir)
  await api(
    `/session/${readerID}`,
    "PATCH",
    {
      permission: sessionContextRules(legacy.permission, [{ sessionID: sourceID, readFiles: false }]),
    },
    assistantDir,
  )
  await prompt("QA_REVOKED")
  await received("QA_OK_REVOKED")
  assert.match(lastToolResult, /QA_PROJECT_CONTENT/)
  assert.equal((await api("/permission", "GET", undefined, assistantDir)).length, 0)
  await idle()
  console.log("[context-access-qa] writes/shell still prompt; legacy unchecked option upgraded to default read")
  await prompt("QA_UNKNOWN")
  const unknown = await wait(
    async () =>
      (await api("/permission", "GET", undefined, assistantDir)).find(
        (item: { sessionID: string }) => item.sessionID === readerID,
      ),
    "unlinked transcript prompt",
  )
  assert.equal(unknown.permission, "session_transcript")
  await api(`/permission/${unknown.id}/reply`, "POST", { reply: "reject" }, assistantDir)
  await idle()
  const logs = await Bun.file(join(scratch, "sidecar-errors.log")).text()
  assert.match(logs, /linked project read authorized/)
  assert.match(logs, /session transcript read completed/)
  console.log(`[context-access-qa] PASS; backend logs verified; artifacts=${scratch}`)
} catch (error) {
  if (cdp) {
    console.error(
      `[context-access-qa] page=${await cdp.evaluate("document.body.innerText.slice(-4000)").catch(() => "unavailable")}`,
    )
  }
  throw error
} finally {
  cdp?.close()
  if (parent) {
    await parent.evaluate(`window.api.browser.close(${JSON.stringify(viewID)})`).catch(() => {})
    parent.close()
  }
  sidecar.kill("SIGTERM")
  await sidecar.exited
  model.stop(true)
  await server.close()
}
