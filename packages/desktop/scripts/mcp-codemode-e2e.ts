import { strict as assert } from "node:assert"
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { withCdp } from "./cdp"
import { mcpSelectionID } from "../../app/src/pages/config-persistence"
import { fork } from "node:child_process"
import { createWriteStream } from "node:fs"

const log = (message: string) => console.log(`[mcp-codemode-e2e] ${message}`)
const directory = await realpath(await mkdtemp("/tmp/opencode-mcp-codemode-"))
log(`workspace=${directory}`)
const configFile = path.join(directory, "opencode.json")
await Bun.$`git init -q ${directory}`.quiet()
const rpcCalls: Array<{ name: string; value: number }> = []
let releaseParallel!: () => void
const parallel = new Promise<void>((resolve) => {
  releaseParallel = resolve
})
let parallelStarted = 0
let waitEntered = false
const scenarioCalls = new Map<string, number>()
const fixtureFailures: string[] = []
let direct = false
let transcriptSession = ""
let childTask = ""
const queryScripts = () => ({
  QUERY_CM_CODE:
    'const found = await tools.builtin.grep({pattern:"QA_TARGET",path:"src",include:"*.ts"}); const files = (await tools.builtin.glob({pattern:"src/*.ts"})).data.files; const rows = await Promise.all(files.map(filePath => tools.builtin.read({filePath}))); return {matches:found.data.total,values:rows.flatMap(row => row.data.lines.filter(line => line.text.startsWith("export")).map(line => line.text))}',
  QUERY_CM_WEB: `const pages = await Promise.all([1,2].map(id => tools.builtin.webfetch({url:${JSON.stringify(fixture.url.toString())}+"json?id="+id}))); return pages.flatMap(page => page.data.rows.filter(row => row.status === "failed").map(row => row.id))`,
  QUERY_CM_TASKS: `const tasks = await tools.builtin.task_list({}); const child = await tools.builtin.task_transcript({task_id:${JSON.stringify(childTask)},include:["text"]}); const history = await tools.builtin.session_transcript({session_id:${JSON.stringify(transcriptSession)},include:["text"]}); return {count:tasks.data.count,childMessages:child.data.messages.length,historyMessages:history.data.messages.length}`,
  QUERY_CM_BROWSER:
    'const page = await tools.builtin.browser_read({}); const log = await tools.builtin.browser_console({all:true}); return {title:page.data.title,buttons:page.data.nodes.filter(node => node.role === "button").map(node => node.name),errors:log.data.entries.filter(entry => entry.level === "error").map(entry => entry.text)}',
  QUERY_CM_READ_REJECT: 'return await tools.builtin.read({filePath:"src/a.ts"})',
  QUERY_CM_HIDDEN: 'return !search({namespace:"builtin",limit:100}).items.some(item => item.path === "builtin.read")',
  QUERY_CM_PREVIEW: "return 0",
})

const fixture = Bun.serve({
  port: 0,
  error(error) {
    fixtureFailures.push(String(error))
    return new Response("Local Code Mode fixture assertion failed", { status: 500 })
  },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/json")
      return Response.json({
        rows: [
          { id: Number(url.searchParams.get("id")), status: "failed" },
          { id: 99, status: "ok" },
        ],
      })
    if (url.pathname === "/page")
      return new Response(
        '<html><head><title>Query Code Mode QA</title></head><body><button>QA Button</button><script>console.error("QA_BROWSER_EXPECTED_ERROR")</script></body></html>',
        { headers: { "content-type": "text/html" } },
      )
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const rpc = (await request.json()) as any
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      let result: unknown = {}
      if (rpc.method === "initialize")
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "codeqa", version: "1" },
        }
      if (rpc.method === "tools/list")
        result = {
          tools: ["echo", "wait"].map((name) => ({
            name,
            description: `${name} a numeric value`,
            inputSchema: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              additionalProperties: false,
            },
          })),
        }
      if (rpc.method === "tools/call") {
        const value = rpc.params.arguments.value as number
        rpcCalls.push({ name: rpc.params.name, value })
        log(`MCP received tool=${rpc.params.name} value=${value}`)
        if (rpc.params.name === "wait") {
          waitEntered = true
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })), { once: true })
          })
        }
        if (value === 1 || value === 2) {
          parallelStarted++
          if (parallelStarted === 2) releaseParallel()
          await parallel
        }
        result = {
          content: [{ type: "text", text: "RAW_MCP_INTERMEDIATE_SHOULD_NOT_REACH_MODEL" }],
          structuredContent: { value },
        }
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
    }
    const body = (await request.json()) as any
    const history = JSON.stringify(body.messages)
    const scenario =
      [
        ...Object.keys(queryScripts()),
        "MCP_CM_COMPOSE",
        "MCP_CM_INVALID",
        "MCP_CM_REJECT",
        "MCP_CM_CANCEL",
        "MCP_CM_DIRECT",
      ].find((name) =>
        (JSON.stringify(body.messages.find((message: any) => message.role === "user")?.content) ?? "").includes(name),
      ) ?? "TITLE"
    const step = (scenarioCalls.get(scenario) ?? 0) + 1
    scenarioCalls.set(scenario, step)
    const names = (body.tools ?? []).map((tool: any) => tool.function.name) as string[]
    if (scenario !== "TITLE") {
      assert.equal(names.includes("execute"), true, `query Code Mode missing for ${scenario}`)
      assert.equal(names.includes("codeqa_echo"), direct, "MCP tools were exposed twice")
      assert.equal(names.includes("read"), scenario !== "QUERY_CM_HIDDEN", "wrong direct read exposure")
      assert.ok(names.includes("bash"), "built-in shell exposure changed")
    }
    let delta: Record<string, unknown> = { content: `${scenario}_OK` }
    let finish = "stop"
    const browserStep = scenario === "QUERY_CM_BROWSER"
    if (scenario !== "TITLE" && (step === 1 || (browserStep && (step === 2 || step === 3)))) {
      const queryCode = queryScripts()[scenario as keyof ReturnType<typeof queryScripts>]
      const code =
        queryCode ??
        (scenario === "MCP_CM_COMPOSE"
          ? "const rows = await Promise.all([1,2,3].map(value => tools.codeqa.echo({value}))); return rows.map(row => row.structuredContent.value * 2)"
          : scenario === "MCP_CM_INVALID"
            ? 'return await tools.codeqa.echo({value:"bad"})'
            : scenario === "MCP_CM_CANCEL"
              ? "return await tools.codeqa.wait({value:99})"
              : "return await tools.codeqa.echo({value:42})")
      const name =
        browserStep && step === 1
          ? "browser_navigate"
          : browserStep && step === 3
            ? "browser_close"
            : direct && !queryCode
              ? "codeqa_echo"
              : "execute"
      const args =
        name === "browser_navigate"
          ? { url: `${fixture.url}page` }
          : name === "browser_close"
            ? {}
            : name === "codeqa_echo"
              ? { value: 7 }
              : { code }
      delta = {
        tool_calls: [
          {
            index: 0,
            id: `call_${scenario}_${step}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
      finish = "tool_calls"
    }
    if (scenario === "MCP_CM_COMPOSE" && step === 2) {
      assert.ok(history.includes("2,4,6"), "composed result missing")
      assert.ok(!history.includes("RAW_MCP_INTERMEDIATE"), "raw MCP intermediates leaked into context")
    }
    if (scenario === "QUERY_CM_CODE" && step === 2) {
      assert.ok(history.includes("QA_TARGET = 7"), "selected source line missing")
      assert.ok(history.includes("QA_NESTED_INSTRUCTION"), "nested project instructions lost")
      assert.ok(!history.includes("RAW_QUERY_INTERMEDIATE"), "unselected source leaked")
    }
    if (scenario === "QUERY_CM_WEB" && step === 2) assert.ok(history.includes("1,2"), "JSON query result missing")
    if (scenario === "QUERY_CM_TASKS" && step === 2)
      assert.ok(history.includes("childMessages"), "structured transcript missing")
    if (scenario === "QUERY_CM_BROWSER" && step === 3)
      assert.ok(
        history.includes("QA_BROWSER_EXPECTED_ERROR") && history.includes("QA Button"),
        "structured browser query missing",
      )
    if (scenario === "QUERY_CM_READ_REJECT" && step === 2)
      assert.ok(
        history.includes('"ok":false') || history.includes('\\"ok\\":false'),
        "rejected read unexpectedly succeeded",
      )
    if (scenario === "QUERY_CM_HIDDEN" && step === 2)
      assert.ok(
        history.includes('"value":true') || history.includes('\\"value\\":true'),
        "disabled read leaked into catalog",
      )
    log(`model received scenario=${scenario} step=${step} mode=${direct ? "direct" : "code"}`)
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-cm",
      object: "chat.completion.chunk",
      created: 0,
      model: "codeqa-model",
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
const config = {
  model: "codeqa/codeqa-model",
  plugin: [],
  lsp: false,
  permission: { "*": "allow" },
  provider: {
    codeqa: {
      name: "Code Mode QA",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "local-test-only", baseURL: `${fixture.url}v1` },
      models: { "codeqa-model": { name: "Code Mode QA", limit: { context: 100000, output: 10000 } } },
    },
  },
  mcp: { codeqa: { type: "remote", url: `${fixture.url}mcp`, oauth: false, codemode: true } },
}
await Bun.write(configFile, JSON.stringify(config))
await Bun.write(path.join(directory, ".gitignore"), "/profile/\n")
await Bun.write(
  path.join(directory, "src/a.ts"),
  "export const QA_TARGET = 7\n// RAW_QUERY_INTERMEDIATE_SHOULD_NOT_REACH_MODEL\n",
)
await Bun.write(path.join(directory, "src/AGENTS.md"), "QA_NESTED_INSTRUCTION: preserve this project instruction.\n")

const sessions: string[] = []
let cleanup: (() => Promise<void>) | undefined
const isolated = process.argv.includes("--isolated")
const output = isolated ? createWriteStream(`${directory}.sidecar.log`) : undefined
const sidecar = isolated
  ? fork(path.join(import.meta.dir, "query-codemode-sidecar.mjs"), [], {
      execPath: "node",
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: `${directory}/profile/config`,
        XDG_DATA_HOME: `${directory}/profile/data`,
        XDG_STATE_HOME: `${directory}/profile/state`,
        XDG_CACHE_HOME: `${directory}/profile/cache`,
        OPENCODE_TEST_HOME: `${directory}/profile/home`,
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_CHANNEL_DB: "true",
        OPENCODE_AUTH_CONTENT: "{}",
        OPENCODE_SERVER_PASSWORD: crypto.randomUUID(),
      },
    })
  : undefined
sidecar?.stdout!.pipe(output!)
sidecar?.stderr!.pipe(output!)
const isolatedConnection = sidecar
  ? new Promise<{ url: string; username: string; password: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`isolated startup timeout: ${directory}.sidecar.log`)), 30000)
      sidecar.once("message", (connection: any) => {
        clearTimeout(timer)
        resolve(connection)
      })
      sidecar.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`isolated sidecar exited ${code}`))
      })
    })
  : undefined
try {
  await withCdp(async (cdp, target) => {
    assert.ok(target.url.includes("localhost:5173"), "Only development Electron may be tested")
    const desktopConnection = await cdp.evaluate<{ url: string; username: string; password: string }>(
      "window.api.awaitInitialization(() => {})",
    )
    const connection = isolatedConnection ? await isolatedConnection : desktopConnection
    const request = async (route: string, method = "GET", body?: unknown, target = connection): Promise<any> => {
      const response = await fetch(target.url + route, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`,
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(directory),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
      assert.ok(response.ok, `${method} ${route}: HTTP ${response.status} ${response.ok ? "" : await response.text()}`)
      return response.status === 204 ? undefined : response.json()
    }
    const previewSessions: string[] = []
    cleanup = async () => {
      for (const id of sessions) await request(`/session/${id}`, "DELETE").catch(() => {})
      for (const id of previewSessions)
        await request(`/session/${id}`, "DELETE", undefined, desktopConnection).catch(() => {})
    }
    const wait = async (label: string, check: () => Promise<boolean>, timeout = 15000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await check()) return
        await Bun.sleep(50)
      }
      log(
        `UI timeout ${label}: ${await cdp.evaluate('JSON.stringify({body:document.body.innerText,errors:[...document.querySelectorAll("textarea")].map(el=>el.value)})')}`,
      )
      throw new Error(`Timed out: ${label}`)
    }
    const navigation = `${new URL(target.url).origin}/@fs${path.resolve(import.meta.dir, "../../app/src/utils/notification-click.ts")}`
    const navigate = (route: string) =>
      cdp.evaluate(
        `(() => { window.__mcpCodeModeNavigation = import(${JSON.stringify(navigation)}).then(m => m.handleNotificationClick(${JSON.stringify(route)})).catch(e => { window.__mcpCodeModeNavigationError=String(e); }); return true })()`,
      )
    const create = async (title: string, permission?: PermissionRules) => {
      const session = await request("/session", "POST", { title: `QA ${title}`, ...(permission ? { permission } : {}) })
      sessions.push(session.id)
      return session
    }
    const send = (id: string, text: string, tools?: Record<string, boolean>) =>
      request(`/session/${id}/message`, "POST", {
        agent: "build",
        model: { providerID: "codeqa", modelID: "codeqa-model" },
        parts: [{ type: "text", text }],
        ...(tools ? { tools } : {}),
      })
    await wait("MCP connection", async () => (await request("/mcp")).codeqa?.status === "connected")
    const composed = await create("MCP_CM_COMPOSE")
    const result = await send(composed.id, "MCP_CM_COMPOSE")
    assert.ok(result.parts.some((part: any) => part.text === "MCP_CM_COMPOSE_OK"))
    const history = await request(`/session/${composed.id}/message`)
    const execution = history.flatMap((message: any) => message.parts).find((part: any) => part.tool === "execute")
    assert.equal(execution.state.metadata.toolCalls.length, 3)
    assert.ok(execution.state.metadata.toolCalls.every((call: any) => call.status === "completed"))
    assert.equal(parallelStarted, 2)
    log(
      `PASS actual ${isolated ? "isolated Node" : "Electron"} sidecar composed three MCP calls, retained audit rows and filtered intermediates`,
    )

    const queries = await create("QUERY_CM_CODE")
    await send(queries.id, "QUERY_CM_CODE")
    const queryHistory = await request(`/session/${queries.id}/message`)
    const queryExecution = queryHistory
      .flatMap((message: any) => message.parts)
      .find((part: any) => part.tool === "execute")
    assert.equal(queryExecution.state.metadata.codemodeScope, "query")
    assert.deepEqual(queryExecution.state.metadata.toolCalls.map((call: any) => call.tool).sort(), [
      "glob",
      "grep",
      "read",
    ])
    assert.ok(queryExecution.state.metadata.loaded.includes(path.join(directory, "src/AGENTS.md")))
    log("PASS real glob/grep/read compose structured data, filter source content and retain project instructions")
    const web = await create("QUERY_CM_WEB")
    await send(web.id, "QUERY_CM_WEB")
    log("PASS webfetch JSON queries filter two parallel HTTP results")
    const tasks = await create("QUERY_CM_TASKS")
    const child = await request("/session", "POST", { title: "QA child query", parentID: tasks.id })
    sessions.push(child.id)
    transcriptSession = queries.id
    childTask = child.id
    await send(tasks.id, "QUERY_CM_TASKS")
    log("PASS real task discovery, child transcript and session transcript queries")
    if (!isolated) {
      const browser = await create("QUERY_CM_BROWSER")
      await send(browser.id, "QUERY_CM_BROWSER")
      log("PASS actual Electron browser snapshot and console query, with browser actions kept outside Code Mode")
    }
    const deniedRead = await create("QUERY_CM_READ_REJECT", [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*", action: "ask" },
    ])
    const readReply = send(deniedRead.id, "QUERY_CM_READ_REJECT")
    let readApproval: any
    await wait("nested read permission", async () => {
      readApproval = (await request("/permission")).find(
        (item: any) => item.sessionID === deniedRead.id && item.permission === "read",
      )
      return !!readApproval
    })
    await request(`/permission/${readApproval.id}/reply`, "POST", { reply: "reject" })
    await readReply
    const hidden = await create("QUERY_CM_HIDDEN")
    await send(hidden.id, "QUERY_CM_HIDDEN", { read: false })
    log("PASS original read permission rejection and per-prompt catalog exclusion")

    let previewTitle = "QA QUERY_CM_CODE"
    if (isolated) {
      // Replay the real isolated execution into a test-owned view session, without restarting the user's old backend.
      const preview = await request("/session", "POST", { title: "QA QUERY_CM_PREVIEW" }, desktopConnection)
      previewSessions.push(preview.id)
      await request(
        `/session/${preview.id}/message`,
        "POST",
        {
          agent: "build",
          model: { providerID: "codeqa", modelID: "codeqa-model" },
          parts: [{ type: "text", text: "QUERY_CM_PREVIEW" }],
        },
        desktopConnection,
      )
      const messages = await request(`/session/${preview.id}/message`, "GET", undefined, desktopConnection)
      const part = messages.flatMap((message: any) => message.parts).find((part: any) => part.tool === "execute")
      assert.ok(part, "preview execute part missing")
      await request(
        `/session/${preview.id}/message/${part.messageID}/part/${part.id}`,
        "PATCH",
        { ...part, state: queryExecution.state },
        desktopConnection,
      )
      previewTitle = "QA QUERY_CM_PREVIEW"
      log("Replaying the captured real query execution for CDP UI verification only")
    }
    {
      await navigate("/")
      await cdp.evaluate(
        '(() => { const button=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="Not yet"); button?.click(); return true })()',
      )
      const recent = `(() => [...document.querySelectorAll("button,a,[role=button]")].find(el => el.textContent.includes(${JSON.stringify(previewTitle)}) && el.textContent.includes(${JSON.stringify(path.basename(directory))})))()`
      await wait("owned session in recent list", () => cdp.evaluate(`!!${recent}`))
      await cdp.evaluate(`${recent}.click()`)
      await wait("tool activity group", () =>
        cdp.evaluate('!!document.querySelector(".tool-activity-group button[aria-expanded=false]")'),
      )
      await cdp.evaluate('document.querySelector(".tool-activity-group button[aria-expanded=false]").click()')
      const card =
        '[...document.querySelectorAll("[data-tool=execute] [aria-label]")].find(el => el.getAttribute("aria-label") === "Code Mode")'
      await wait("Code Mode card", () => cdp.evaluate(`!!(${card})`))
      await cdp.evaluate(`(${card}).closest("button").click()`)
      await wait("Code Mode subcall details", () =>
        cdp.evaluate('document.querySelectorAll("[data-slot=mcp-codemode-call][data-status=completed]").length === 3'),
      )
      const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write("/tmp/opencode-mcp-codemode.png", Buffer.from(screenshot.data, "base64"))
      log("PASS frontend shows the script, three completed subcalls and selected result")
    }

    const beforeInvalid = rpcCalls.length
    const invalid = await create("MCP_CM_INVALID")
    await send(invalid.id, "MCP_CM_INVALID")
    assert.equal(rpcCalls.length, beforeInvalid)
    log("PASS invalid script arguments never reached MCP")

    const rejected = await create("MCP_CM_REJECT", [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "codeqa_echo", pattern: "*", action: "ask" },
    ])
    const beforeRejected = rpcCalls.length
    const reply = send(rejected.id, "MCP_CM_REJECT")
    let approval: any
    await wait("nested MCP permission request", async () => {
      approval = (await request("/permission")).find(
        (item: any) => item.sessionID === rejected.id && item.permission === "codeqa_echo",
      )
      return !!approval
    })
    await request(`/permission/${approval.id}/reply`, "POST", { reply: "reject" })
    await reply
    assert.equal(rpcCalls.length, beforeRejected)
    log("PASS nested MCP permission rejection prevented the remote operation")

    const cancelled = await create("MCP_CM_CANCEL")
    const pending = send(cancelled.id, "MCP_CM_CANCEL")
    await wait("blocking MCP call", async () => waitEntered)
    await request(`/session/${cancelled.id}/abort`, "POST")
    await pending
    await wait("cancelled session idle", async () => (await request("/session/status"))[cancelled.id]?.type !== "busy")
    log("PASS stopping the session interrupted the running Code Mode request")

    if (isolated) {
      const project = JSON.stringify(Buffer.from(directory).toString("base64url"))
      await cdp.evaluate(
        `(() => { const el=[...document.querySelectorAll("[data-action=project-switch]")].find(el=>el.getAttribute("data-project")===${project}); if(!el)return; const rect=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,button:2,clientX:rect.x+10,clientY:rect.y+10})); })()`,
      )
      const close = `[...document.querySelectorAll("[data-action=project-close-menu]")].find(el=>el.getAttribute("data-project")===${project})`
      await wait("owned project close menu", () => cdp.evaluate(`!!(${close})`))
      const point = await cdp.evaluate<{ x: number; y: number }>(
        `(() => {const rect=(${close}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`,
      )
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await cdp.call("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: 1,
        })
      }
      await wait("owned project closed", () =>
        cdp.evaluate(
          `![...document.querySelectorAll("[data-action=project-switch]")].some(el=>el.getAttribute("data-project")===${project})`,
        ),
      )
      log(`PASS isolated sidecar scenarios; backend logs=${directory}.sidecar.log`)
      return
    }
    const pick = mcpSelectionID({ scope: "project", directory, name: "codeqa" })
    await navigate(
      `/${Buffer.from(directory).toString("base64url")}/config?section=mcp&pick=${encodeURIComponent(pick)}`,
    )
    const serverRow =
      '[...document.querySelectorAll("[role=button]")].find(el => el.textContent.includes("codeqa") && el.textContent.includes("/mcp"))'
    await wait("MCP editor server row", () => cdp.evaluate(`!!(${serverRow})`))
    await cdp.evaluate(`(${serverRow}).click()`)
    await wait("per-server Code Mode switch", () =>
      cdp.evaluate('!!document.querySelector("[data-slot=mcp-codemode-setting] [role=switch]")'),
    )
    assert.equal(
      await cdp.evaluate(
        'document.querySelector("[data-slot=mcp-codemode-setting] [role=switch]").getAttribute("aria-checked")',
      ),
      "true",
    )
    await cdp.evaluate('document.querySelector("[data-slot=mcp-codemode-setting] [role=switch]").click()')
    await wait("Code Mode save enabled", () =>
      cdp.evaluate('!!document.querySelector("[data-config-save-state=active]:not(:disabled)")'),
    )
    await cdp.evaluate('document.querySelector("[data-config-save-state=active]:not(:disabled)").click()')
    await wait(
      "Code Mode flag persisted",
      async () => JSON.parse(await readFile(configFile, "utf8")).mcp.codeqa.codemode === false,
    )
    direct = true
    const directSession = await create("MCP_CM_DIRECT")
    const directResult = await send(directSession.id, "MCP_CM_DIRECT")
    assert.ok(directResult.parts.some((part: any) => part.text === "MCP_CM_DIRECT_OK"))
    log("PASS config UI persisted codemode=false and the next session used direct MCP tools")

    await cdp.evaluate('document.querySelector("[data-slot=mcp-codemode-setting] [role=switch]").click()')
    await wait("reenable save", () =>
      cdp.evaluate('!!document.querySelector("[data-config-save-state=active]:not(:disabled)")'),
    )
    await cdp.evaluate('document.querySelector("[data-config-save-state=active]:not(:disabled)").click()')
    await wait(
      "Code Mode reenabled",
      async () => JSON.parse(await readFile(configFile, "utf8")).mcp.codeqa.codemode === true,
    )
    log("PASS Code Mode can be reenabled without replacing other server settings")
    await navigate("/")
  })
  assert.deepEqual(fixtureFailures, [], "model fixture assertions failed")
  log("PASS all enabled MCP and query Code Mode scenarios")
} finally {
  if (isolated) {
    const logDir = path.join(directory, "profile/data/opencode/log")
    const names = await readdir(logDir).catch(() => [])
    const logs: string[] = []
    for (const name of names) if (name.endsWith(".log")) logs.push(await readFile(path.join(logDir, name), "utf8"))
    await Bun.write(`${directory}.backend.log`, logs.join("\n"))
  }
  await cleanup?.()
  if (sidecar && sidecar.exitCode === null) {
    sidecar.send("stop")
    await new Promise<void>((resolve) => {
      sidecar.once("exit", () => resolve())
      setTimeout(() => {
        sidecar.kill("SIGTERM")
        resolve()
      }, 5000).unref()
    })
  }
  output?.end()
  fixture.stop(true)
  await rm(directory, { recursive: true, force: true })
}

type PermissionRules = Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>
