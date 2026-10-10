import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withCdp, type CdpClient } from "./cdp"

type Sidecar = { url: string; username?: string; password: string }
type Result = {
  name: string
  status: "pass" | "fail" | "skipped"
  surface: "backend" | "ui" | "mixed"
  details?: Record<string, string | number | boolean | undefined>
  error?: string
}
type Session = { id: string; directory: string; title: string }
type Job = {
  id: string
  ptyID: string
  sessionID: string
  command?: string
  callID?: string
  status: string
  exitCode?: number
  outputTail?: string
}
type ToolCase = { command: string; description: string; background?: boolean }

const scriptArgs = process.argv.slice(2)
const help = scriptArgs.includes("--help") || scriptArgs.includes("-h")
const reportArg = scriptArgs.indexOf("--report")
const screenshotArg = scriptArgs.indexOf("--screenshots")
const reportPath =
  reportArg >= 0
    ? scriptArgs[reportArg + 1] || "/tmp/opencode-shell-escaping-e2e-report.json"
    : "/tmp/opencode-shell-escaping-e2e-report.json"
const screenshots = screenshotArg >= 0 ? scriptArgs[screenshotArg + 1] : undefined
const appSource = fileURLToPath(new URL("../../app/src/", import.meta.url))
const timeoutMs = 20_000
const dynamicPathEnv = `OPENCODE_SHELL_E2E_PATH_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
const results: Result[] = []
const sessions: Session[] = []
const jobs: Array<{ id: string; directory: string; sessionID: string }> = []
let sidecar: Sidecar | undefined
let cdp: CdpClient | undefined
let modelServer: ReturnType<typeof Bun.serve> | undefined
let fixture: string | undefined
let project: string | undefined
let outside: string | undefined
let previousSession: { directory: string; id: string } | undefined
let uiTarget = false
let fixtureRemoved = false
let backgroundAckCount = 0
let requestCount = 0
let cleanupDone = false

const log = (message: string) => console.log(`[shell-escaping-e2e] ${message}`)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 280)
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = async <T>(label: string, check: () => Promise<T | undefined>, duration = timeoutMs): Promise<T> => {
  const deadline = Date.now() + duration
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}${last ? ` (${errorText(last)})` : ""}`)
}

if (help) {
  console.log(
    [
      "Runs shell escaping, permission, prompt, slash-command, and background-shell acceptance against an already-running OpenCode Dev renderer.",
      "The harness does not launch, stop, or restart any application. It uses a temporary fixture and loopback-only fake model.",
      "",
      "Usage: bun packages/desktop/scripts/shell-escaping-e2e.ts [--report <path>] [--screenshots <directory>]",
      "",
      "Options:",
      "  --report <path>          JSON report path (default /tmp/opencode-shell-escaping-e2e-report.json)",
      "  --screenshots <dir>      Save permission and timeline screenshots",
      "  --help                   Show this help without connecting to CDP",
    ].join("\n"),
  )
  process.exit(0)
}

function record(name: string, surface: Result["surface"], details?: Result["details"]) {
  results.push({ name, surface, status: "pass", details })
  log(`PASS ${surface} ${name}${details?.sessionID ? ` session=${details.sessionID}` : ""}`)
}

async function caseRun(name: string, surface: Result["surface"], fn: () => Promise<Result["details"]>) {
  try {
    const details = await fn()
    if (details?.skipped === true) {
      results.push({ name, surface, status: "skipped", details })
      log(`SKIP ${surface} ${name}`)
    } else {
      record(name, surface, details)
    }
  } catch (error) {
    results.push({ name, surface, status: "fail", error: errorText(error) })
    log(`FAIL ${surface} ${name}: ${errorText(error)}`)
    if ((surface === "ui" || surface === "mixed") && cdp) {
      const diagnosticName = `case-${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60)}`
      await writeUiDiagnostics(diagnosticName).catch((diagnosticError) => {
        log(`UI diagnostic failed case=${diagnosticName}: ${errorText(diagnosticError)}`)
      })
    }
  }
}

function sse(content: string, model = "test-model") {
  const id = `chatcmpl-shell-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

function completion(content: string, model = "test-model") {
  return Response.json({
    id: `chatcmpl-shell-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function toolSse(name: string, args: Record<string, unknown>) {
  const id = `chatcmpl-shell-${crypto.randomUUID()}`
  const toolCallID = `call_shell_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  const created = Math.floor(Date.now() / 1000)
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: toolCallID, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}

function toolCompletion(name: string, args: Record<string, unknown>, model = "test-model") {
  return Response.json({
    id: `chatcmpl-shell-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_shell_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function textResponse(content: string, body: { model?: string; stream?: boolean }) {
  return body.stream ? sse(content, body.model) : completion(content, body.model)
}

function toolResponse(name: string, args: Record<string, unknown>, body: { model?: string; stream?: boolean }) {
  return body.stream ? toolSse(name, args) : toolCompletion(name, args, body.model)
}

const toolCases = new Map<string, ToolCase>()
const modelObservations = new Map<string, { sawText: boolean; sawToolResult: boolean; calls: number }>()
const slashObservations = new Map<string, { sawArguments: boolean; requestCount: number }>()
const slashPromptObservations = new Map<string, string>()

function startFakeModel() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") return new Response("ok")
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: "unsupported fake model route" } }, { status: 404 })
      }
      requestCount++
      const body = (await request.json()) as {
        model?: string
        stream?: boolean
        messages?: Array<{ role?: string; content?: unknown }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const messages = body.messages ?? []
      const text = JSON.stringify(messages)
      const latestUser = [...messages].reverse().find((item) => item.role === "user")
      const latestUserText = JSON.stringify(latestUser?.content ?? "")
      const marker = latestUserText.match(/QA_TOOL_CASE:([A-Za-z0-9_-]+)/)?.[1]
      const recordFor = (key: string) => {
        const prior = modelObservations.get(key) ?? { sawText: false, sawToolResult: false, calls: 0 }
        prior.calls++
        modelObservations.set(key, prior)
        return prior
      }
      if (marker) {
        const observed = recordFor(marker)
        observed.sawText = true
        const hasToolResult = messages.some((item) => item.role === "tool")
        if (hasToolResult) {
          observed.sawToolResult = true
          return textResponse(`QA_TOOL_DONE:${marker}`, body)
        }
        const selected = toolCases.get(marker)
        const toolName = body.tools?.map((item) => item.function?.name).find((name) => name === "bash")
        if (selected && body.tools?.length && toolName) return toolResponse(toolName, selected, body)
      }
      if (
        latestUserText.includes("Background shell completed:") ||
        latestUserText.includes("<background_shell_result>")
      ) {
        backgroundAckCount++
        return textResponse("QA_BACKGROUND_ACK", body)
      }
      const slashMarker = latestUserText.match(/QA_SLASH_CASE:([A-Za-z0-9_-]+)/)?.[1]
      if (slashMarker) {
        const prior = slashObservations.get(slashMarker) ?? { sawArguments: false, requestCount: 0 }
        prior.sawArguments = true
        prior.requestCount++
        slashObservations.set(slashMarker, prior)
        const markerIndex = text.indexOf(`QA_SLASH_CASE:${slashMarker}`)
        slashPromptObservations.set(slashMarker, text.slice(Math.max(0, markerIndex - 200), markerIndex + 2_000))
        return textResponse("QA_SLASH_DONE", body)
      }
      return textResponse("QA_TITLE_OR_TEXT", body)
    },
  })
}

function authHeaders(directory: string) {
  assert(sidecar, "sidecar is not initialized")
  const basic = Buffer.from(`${sidecar.username || "opencode"}:${sidecar.password}`).toString("base64")
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    "x-opencode-directory": encodeURIComponent(directory),
  }
}

async function api<T>(directory: string, endpoint: string, method = "GET", body?: unknown): Promise<T> {
  assert(sidecar, "sidecar is not initialized")
  const response = await fetch(`${sidecar.url}${endpoint}`, {
    method,
    headers: authHeaders(directory),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${method} ${endpoint}`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function expectRejected(directory: string, endpoint: string, method: string, body: unknown) {
  assert(sidecar, "sidecar is not initialized")
  const response = await fetch(`${sidecar.url}${endpoint}`, {
    method,
    headers: authHeaders(directory),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.ok) throw new Error(`Expected rejection from ${method} ${endpoint}, received HTTP ${response.status}`)
  if ([401, 403, 404, 405].includes(response.status)) {
    throw new Error(`Unexpected HTTP ${response.status} while testing rejection for ${method} ${endpoint}`)
  }
  return response.status
}

async function makeSession(directory: string, title: string, permission?: unknown): Promise<Session> {
  const value = await api<{ id: string }>(directory, "/session", "POST", {
    title,
    model: { providerID: "qa", id: "test-model" },
    ...(permission ? { permission } : {}),
  })
  const session = { id: value.id, directory, title }
  sessions.push(session)
  return session
}

async function messages(session: Session) {
  return api<any[]>(session.directory, `/session/${session.id}/message`)
}

async function toolParts(session: Session) {
  const rows = await messages(session)
  return rows.flatMap((row) => row.parts ?? []).filter((part) => part.type === "tool")
}

async function waitTool(session: Session, marker: string) {
  return wait(`tool completion ${marker}`, async () => {
    const parts = await toolParts(session)
    const part = parts.find((item) => item.state?.status === "completed" || item.state?.status === "error")
    if (!part) return
    const output = String(part.state?.output ?? part.state?.error?.message ?? "")
    if (!output && part.state?.status === "completed") return
    return { part, output }
  })
}

async function waitAssistant(session: Session, text: string) {
  return wait(`assistant result ${text}`, async () => {
    const rows = await messages(session)
    const row = rows.find(
      (item) =>
        item.info?.role === "assistant" &&
        (item.parts ?? []).some((part: any) => part.type === "text" && part.text?.includes(text)),
    )
    return row
  })
}

async function createBackground(session: Session, command: string, extra: Record<string, unknown> = {}) {
  const callID = `shell-e2e-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
  const info = await api<Job>(session.directory, "/background-shell", "POST", {
    sessionID: session.id,
    callID,
    command,
    cwd: project,
    description: "shell escaping acceptance job",
    background: true,
    ...extra,
  })
  jobs.push({ id: info.id, directory: session.directory, sessionID: session.id })
  return info
}

async function listJobs(session: Session) {
  return api<Job[]>(session.directory, `/background-shell?sessionID=${encodeURIComponent(session.id)}`)
}

async function waitJob(session: Session, id: string, statuses: string[]) {
  return wait(`background job ${id} status`, async () => {
    const rows = await listJobs(session)
    const found = rows.find((item) => item.id === id)
    return found && statuses.includes(found.status) ? found : undefined
  })
}

function ptyExpected(text: string) {
  return text.replace(/\n/g, "\r\n")
}

function shellQuote(text: string) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function visibleSessionExpression(sessionID: string) {
  return `(() => {
    const visible=node=>node.getClientRects().length>0;
    const page=[...document.querySelectorAll('[data-component="session-page"][data-session-id]')].some(node=>visible(node)&&node.getAttribute('data-session-id')===${JSON.stringify(sessionID)});
    if(!page)return false;
    const scope=[...document.querySelectorAll('[data-prompt-scope]')].filter(visible)
      .some(node=>{try{return JSON.parse(node.getAttribute('data-prompt-scope')||'null')?.[1]===${JSON.stringify(sessionID)}}catch{return false}});
    const tab=[...document.querySelectorAll('[data-component="session-tab"][data-session-id]')].filter(visible)
      .some(node=>node.getAttribute('data-session-id')===${JSON.stringify(sessionID)}&&node.getAttribute('data-active')==='true');
    return scope||tab;
  })()`
}

async function navigate(directory: string, sessionID: string) {
  assert(cdp, "CDP client is not connected")
  const route = `/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`
  const source = `/@fs${appSource}utils/notification-click.ts`
  log(`UI navigation requested session=${sessionID}`)
  await cdp.evaluate(`(() => { void import(${JSON.stringify(source)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)})); return true })()`)
  try {
    await wait(`visible prompt scope ${sessionID}`, () =>
      cdp!.evaluate<boolean>(visibleSessionExpression(sessionID))
        .then((yes) => yes || undefined),
    )
    log(`UI navigation ready session=${sessionID}`)
  } catch (error) {
    await writeUiDiagnostics(`navigate-${sessionID}`)
    throw error
  }
}

async function openFixtureProjectViaHomeUI(directory: string) {
  assert(cdp, "CDP client is not connected")
  await wait("home project path input becomes visible", () =>
    cdp!
      .evaluate<boolean>(`(() => { const input=document.querySelector('[data-component="home-path-input"] input[role="combobox"]'); return !!input&&input.getClientRects().length>0 })()`)
      .then((visible) => visible || undefined),
  )
  const focused = await cdp.evaluate<boolean>(`(() => {
    const input=document.querySelector('[data-component="home-path-input"] input[role="combobox"]');
    if(!(input instanceof HTMLInputElement)||input.getClientRects().length===0)return false;
    input.focus();input.setRangeText('',0,input.value.length,'start');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'}));
    return document.activeElement===input;
  })()`)
  assert(focused, "home project path input was not visible")
  await cdp.call("Input.insertText", { text: directory })
  await wait("home launcher has exact fixture path and enabled Open button", () =>
    cdp!
      .evaluate<boolean>(`(() => {
        const root=document.querySelector('[data-component="home-path-input"]');
        const input=root?.querySelector('input[role="combobox"]');
        const button=root?.querySelector('button[data-variant="primary"]');
        return input instanceof HTMLInputElement&&input.value===${JSON.stringify(directory)}&&
          button instanceof HTMLButtonElement&&!button.disabled&&button.getClientRects().length>0;
      })()`)
      .then((ready) => ready || undefined),
  )
  log(`UI fixture project open requested pathLength=${directory.length}`)
  const clicked = await cdp.evaluate<boolean>(`(() => {
    const root=document.querySelector('[data-component="home-path-input"]');
    const input=root?.querySelector('input[role="combobox"]');
    const button=root?.querySelector('button[data-variant="primary"]');
    if(!(input instanceof HTMLInputElement)||input.value!==${JSON.stringify(directory)}||!(button instanceof HTMLButtonElement)||button.disabled)return false;
    button.click();return true;
  })()`)
  assert(clicked, "home launcher did not submit the exact fixture path")
  try {
    await wait("fixture project opened from home UI", () =>
      cdp!.evaluate<boolean>(`(() => [...document.querySelectorAll('[data-prompt-scope]')]
        .filter(node=>node.getClientRects().length>0)
        .some(node=>{try{return JSON.parse(node.getAttribute('data-prompt-scope')||'null')?.[0]===${JSON.stringify(directory)}}catch{return false}}))()`)
        .then((yes) => yes || undefined),
    )
    log("UI fixture project opened from home launcher")
  } catch (error) {
    await writeUiDiagnostics("fixture-project-open", directory)
    throw error
  }
}

async function waitPermission(session: Session, permission = "external_directory") {
  return wait(`permission ${permission} for ${session.id}`, async () => {
    const requests = await api<any[]>(session.directory, "/permission")
    return requests.find((item) => item.sessionID === session.id && item.permission === permission)
  })
}

async function permissionDock(request: { id: string; sessionID: string; patterns?: string[] }) {
  assert(cdp, "CDP client is not connected")
  log(`UI permission dock wait request=${request.id} session=${request.sessionID} patterns=${request.patterns?.length ?? 0}`)
  try {
    return await wait(`UI permission dock ${request.id}`, () =>
      cdp!
        .evaluate<boolean>(
        `(() => {
      const visible=node=>node.getClientRects().length>0;
      const current=${visibleSessionExpression(request.sessionID)};
      if(!current)return false;
      const page=document.querySelector('[data-component="session-page"][data-session-id="${request.sessionID}"]');
      const docks=[...(page?.querySelectorAll('[data-component="dock-prompt"][data-kind="permission"]')||[])].filter(visible);
      const dock=docks.find(node=>node.querySelector('[data-slot="permission-footer-actions"]'));
      if(!dock)return false;
      const panel=dock.querySelector('[data-slot="question-collapse"]');
      if(panel&&panel.getAttribute('aria-expanded')==='false'){panel.click();return false;}
      if(!dock.querySelector('[data-slot="permission-footer-actions"]'))return false;
      const text=dock.textContent||'';
      const patterns=${JSON.stringify(request.patterns ?? [])};
      return patterns.every(pattern=>text.includes(pattern));
    })()`,
        )
        .then((yes) => yes || undefined),
    )
  } catch (error) {
    await writeUiDiagnostics(`permission-dock-${request.id}`)
    throw error
  }
}

async function clickPermissionAction(action: "allow" | "deny", request: { sessionID: string; patterns?: string[] }) {
  assert(cdp, "CDP client is not connected")
  log(`UI permission action requested action=${action} session=${request.sessionID} patterns=${request.patterns?.length ?? 0}`)
  const clicked = await cdp.evaluate<{ ok: boolean; label?: string }>(`(() => {
    const expected=${JSON.stringify(request.patterns ?? [])};
    const visible=node=>node.getClientRects().length>0;
    if(!${visibleSessionExpression(request.sessionID)})return {ok:false};
    const page=document.querySelector('[data-component="session-page"][data-session-id="${request.sessionID}"]');
    const docks=[...(page?.querySelectorAll('[data-component="dock-prompt"][data-kind="permission"]')||[])].filter(visible);
    const dock=docks.find(node=>node.querySelector('[data-slot="permission-footer-actions"]'));
    if(!dock) return {ok:false};
    const expand=dock.querySelector('[data-slot="question-collapse"][aria-expanded="false"]');
    if(expand){expand.click();return {ok:false};}
    if(!expected.every(pattern=>(dock.textContent||'').includes(pattern)))return {ok:false};
    const buttons=[...dock.querySelectorAll('button')].filter(button=>button.getClientRects().length>0);
    const label=button=>(button.innerText||button.getAttribute('aria-label')||'').trim();
    const match=${JSON.stringify(action)}==='allow'
      ? buttons.find(button=>/allow once/i.test(label(button)))||buttons.at(-1)
      : buttons.find(button=>/deny|reject/i.test(label(button)))||buttons[0];
    if(!match) return {ok:false};
    const text=label(match);match.click();return {ok:true,label:text};
  })()`)
  assert(clicked.ok, `Permission ${action} button was not visible`)
  log(`UI permission action dispatched action=${action} session=${request.sessionID} label=${clicked.label ?? action}`)
  return clicked.label ?? action
}

async function answerPermission(session: Session, request: any, reply: "once" | "reject") {
  return api<boolean>(session.directory, `/permission/${request.id}/reply`, "POST", { reply })
}

async function startToolCase(session: Session, marker: string) {
  return api<void>(session.directory, `/session/${session.id}/prompt_async`, "POST", {
    agent: "build",
    model: { providerID: "qa", modelID: "test-model" },
    parts: [{ type: "text", text: `Run the requested isolated QA tool case exactly once. QA_TOOL_CASE:${marker}` }],
  })
}

async function uiScreenshot(name: string) {
  if (!cdp) return
  const directory = screenshots ?? "/tmp/opencode-shell-escaping-e2e-diagnostics"
  if (!screenshots && !name.startsWith("diagnostic-")) return
  await mkdir(directory, { recursive: true })
  const captured = await cdp.call<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  })
  await writeFile(path.join(directory, `${name}.png`), Buffer.from(captured.data, "base64"))
  log(`UI screenshot captured name=${name}`)
}

async function writeUiDiagnostics(name: string, expectedHomePath?: string) {
  if (!cdp) return
  const diagnostics = await cdp.evaluate<Record<string, unknown>>(`(() => {
    const visible=node=>node.getClientRects().length>0;
    const scopes=[...document.querySelectorAll('[data-prompt-scope]')].filter(visible).map(node=>{try{const value=JSON.parse(node.getAttribute('data-prompt-scope')||'null');return {directory:String(value?.[0]||'').split('/').at(-1),sessionID:value?.[1]}}catch{return {invalid:true}}});
    const tabs=[...document.querySelectorAll('[data-component="session-tab"][data-session-id]')].filter(visible).map(node=>({sessionID:node.getAttribute('data-session-id'),active:node.getAttribute('data-active')}));
    const tools=[...document.querySelectorAll('[data-component="tool-part-wrapper"][data-tool]')].filter(visible).map(node=>({sessionID:node.getAttribute('data-session-id'),tool:node.getAttribute('data-tool')}));
    const docks=[...document.querySelectorAll('[data-component="dock-prompt"][data-kind="permission"]')].map(node=>({visible:visible(node),sessionID:node.getAttribute('data-session-id'),expanded:node.querySelector('[data-slot="question-collapse"]')?.getAttribute('aria-expanded')}));
    const root=document.querySelector('[data-component="home-path-input"]');
    const input=root?.querySelector('input[role="combobox"]');
    const button=root?.querySelector('button[data-variant="primary"]');
    const homeLauncher={visible:!!root&&visible(root),inputLength:input instanceof HTMLInputElement?input.value.length:0,exactMatch:input instanceof HTMLInputElement&&input.value===${JSON.stringify(expectedHomePath ?? "")},buttonEnabled:button instanceof HTMLButtonElement&&!button.disabled};
    return {url:location.href,scopes,tabs,tools,docks,homeLauncher};
  })()`)
  let permissions: unknown = []
  if (project) {
    try {
      permissions = (await api<any[]>(project, "/permission")).map((item) => ({
        id: item.id,
        sessionID: item.sessionID,
        permission: item.permission,
        patternCount: item.patterns?.length ?? 0,
      }))
    } catch (error) {
      permissions = { error: errorText(error) }
    }
  }
  await mkdir("/tmp/opencode-shell-escaping-e2e-diagnostics", { recursive: true })
  await writeFile(
    path.join("/tmp/opencode-shell-escaping-e2e-diagnostics", `${name}.json`),
    JSON.stringify({ diagnostics, permissions }, null, 2),
  )
  await uiScreenshot(`diagnostic-${name}`)
}

async function renderedBashOutput(sessionID: string, expectedOutput: string, inputMarker?: string) {
  assert(cdp, "CDP client is not connected")
  try {
    log(`UI Bash output inspection requested session=${sessionID}`)
    const hydrationPoint = await wait(`deferred Bash part visible ${sessionID}`, () =>
      cdp!.evaluate<{ x: number; y: number } | { hydrated: true } | undefined>(`(() => {
        const page=document.querySelector('[data-component="session-page"][data-session-id="${sessionID}"]');
        if(!page)return undefined;
        let expanded=false;
        for(const group of page.querySelectorAll('[data-component="collapsible"].tool-activity-group')){
          const trigger=group.querySelector('[data-slot="collapsible-trigger"]');
          if(trigger?.getAttribute('aria-expanded')!=='true'){trigger?.click();expanded=true;}
        }
        if(expanded)return undefined;
        const wrappers=[...page.querySelectorAll('[data-component="tool-part-wrapper"][data-tool="bash"][data-session-id="${sessionID}"]')];
        if(wrappers.length)return {hydrated:true};
        const placeholder=[...page.querySelectorAll('[data-slot="deferred-tool-part"]')]
          .find(node=>node.getClientRects().length>0);
        if(!placeholder)return undefined;
        const rect=placeholder.getBoundingClientRect();
        return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
      })()`).then((value) => value),
    )
    if ("x" in hydrationPoint) {
      log(`UI deferred tool hydration pointer session=${sessionID}`)
      await cdp.call("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: hydrationPoint.x,
        y: hydrationPoint.y,
        button: "left",
        clickCount: 1,
      })
      await cdp.call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: hydrationPoint.x,
        y: hydrationPoint.y,
        button: "left",
        clickCount: 1,
      })
    }
    return await wait(`rendered Bash output ${sessionID}`, () =>
      cdp!.evaluate<string | undefined>(`(() => {
        const page=document.querySelector('[data-component="session-page"][data-session-id="${sessionID}"]');
        if(!page)return undefined;
        const wrappers=[...(page?.querySelectorAll('[data-component="tool-part-wrapper"][data-tool="bash"][data-session-id="${sessionID}"]')||[])];
        const wrapper=${inputMarker ? `wrappers.find(node=>(node.querySelector('[data-slot="collapsible-trigger"]')?.textContent||'').includes(${JSON.stringify(inputMarker)}))` : "wrappers.at(-1)"};
        const trigger=wrapper?.querySelector('[data-slot="collapsible-trigger"]');
        if(!trigger)return undefined;
        if(trigger.getAttribute('aria-expanded')!=='true'){trigger.click();return undefined;}
        const code=wrapper.querySelector('[data-component="bash-output"] [data-slot="bash-pre"] code');
        if(!code)return undefined;
        const body=code.textContent||'';const separator=body.indexOf('\\n\\n');
        if(separator<0)return undefined;
        const output=body.slice(separator+2);
        return output.includes(${JSON.stringify(expectedOutput)})?output:undefined;
      })()`).then((value) => value || undefined),
    )
  } catch (error) {
    await writeUiDiagnostics(`bash-output-${sessionID}`)
    throw error
  }
}

async function waitIdle(session: Session) {
  return wait(`session idle ${session.id}`, async () => {
    const statuses = await api<Record<string, { type: string }>>(session.directory, "/session/status")
    return !statuses[session.id] || statuses[session.id]?.type === "idle" ? true : undefined
  })
}

async function routePermissionCase(input: {
  session: Session
  marker: string
  permissionName?: string
  navigateUI?: boolean
  uiAction?: "allow" | "deny"
  reply?: "once" | "reject"
}) {
  if (input.navigateUI) await navigate(input.session.directory, input.session.id)
  else if (input.uiAction) throw new Error("UI permission actions require navigation to the owned session")
  await startToolCase(input.session, input.marker)
  const permission = await waitPermission(input.session, input.permissionName)
  log(`permission request observed id=${permission.id} session=${input.session.id} permission=${permission.permission} patterns=${permission.patterns?.length ?? 0}`)
  if (input.uiAction) {
    await navigate(input.session.directory, input.session.id)
    await permissionDock({ ...permission, sessionID: input.session.id })
    await uiScreenshot(`permission-${input.uiAction}-${input.marker}`)
    await clickPermissionAction(input.uiAction, { sessionID: input.session.id, patterns: permission.patterns ?? [] })
  } else {
    await answerPermission(input.session, permission, input.reply ?? "once")
  }
  await wait(`permission request ${permission.id} dismissed`, async () => {
    const requests = await api<any[]>(input.session.directory, "/permission")
    return requests.some((item) => item.id === permission.id) ? undefined : true
  })
  const tool = await waitTool(input.session, input.marker)
  const denied = input.reply === "reject" || input.uiAction === "deny"
  const final = denied ? undefined : await waitAssistant(input.session, `QA_TOOL_DONE:${input.marker}`)
  if (denied) {
    assert(tool.part.state.status === "error", `denied tool case ${input.marker} did not error`)
    await waitIdle(input.session)
  }
  return { permission, final, tool, uiAction: input.uiAction }
}

function createModelConfig(baseURL: string) {
  return {
    model: "qa/test-model",
    formatter: false,
    lsp: false,
    provider: {
      qa: {
        name: "Shell Escape QA",
        id: "qa",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Shell Escape QA Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "loopback-test-key", baseURL },
      },
    },
    shell: process.platform === "win32" ? "powershell" : "zsh",
    command: {
      trusted: {
        template:
          "Trusted output: !`printf '%s' 'TRUSTED_SHELL_OK' > trusted-shell.txt; printf '%s' 'TRUSTED_SHELL_OK'`\nUser arguments: $ARGUMENTS",
      },
      placeholder: { template: "User prose: $ARGUMENTS" },
      append: { template: "Append-only trusted node: !`printf '%s' 'APPEND_SHELL_OK'`" },
      numeric: { template: `QA_SLASH_CASE:numeric Numeric argument: !\`printf '<%s>' "$1"\`` },
      generated: {
        template:
          "QA_SLASH_CASE:generated Generated output: !`printf '%b' 'GENERATED_LITERAL !\\0140touch GENERATED_MARKER\\0140 \\0044ARGUMENTS'`",
      },
      "nul-probe": { template: "!`printf '%s' 'NUL_SHOULD_NOT_RUN' > NUL_ARGUMENT_MARKER`" },
      heredoc: {
        template: "!`printf '%s' 'SHOULD_NOT_RUN' > HEREDOC_MARKER`\n!`cat <<'EOF'\n$1\nEOF`",
      },
    },
  }
}

async function setupFixture(baseURL: string) {
  fixture = await mkdtemp(path.join(tmpdir(), "opencode-shell-escape-e2e-"))
  project = path.join(fixture, "project with $ and ' quote")
  outside = path.join(fixture, "outside")
  const testHome = path.join(fixture, "home")
  const testZdotDir = path.join(fixture, "zdotdir")
  await mkdir(project, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(testHome, { recursive: true })
  await mkdir(testZdotDir, { recursive: true })
  project = await realpath(project)
  outside = await realpath(outside)
  await mkdir(path.join(project, "work dir $ and ' quote"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "skills", "skill-e2e"), { recursive: true })
  await mkdir(path.join(project, ".opencode", "plugins"), { recursive: true })
  await writeFile(path.join(project, "inside.txt"), "INSIDE_CONTROLLED\n")
  await writeFile(path.join(outside, "readme.txt"), "OUTSIDE_CONTROLLED_READ\n")
  await writeFile(
    path.join(project, ".opencode", "skills", "skill-e2e", "SKILL.md"),
    [
      "---",
      "name: skill-e2e",
      "description: shell escaping QA skill",
      "---",
      "",
      "Trusted skill output: !`printf '%s' 'SKILL_TRUSTED_OK'`",
    ].join("\n"),
  )
  const pluginEnvValue = `plugin-quote' "double"; touch QA_ENV_MARKER; printf 'ran`
  await writeFile(
    path.join(project, ".opencode", "plugins", "shell-env-e2e.js"),
    `export default async () => ({ "shell.env": async (_input, output) => { output.env.QA_HOSTILE = ${JSON.stringify(pluginEnvValue)}; output.env.HOME = ${JSON.stringify(testHome)}; output.env.ZDOTDIR = ${JSON.stringify(testZdotDir)}; output.env[${JSON.stringify(dynamicPathEnv)}] = ${JSON.stringify(path.join(outside, "readme.txt"))} } })\n`,
  )
  await writeFile(path.join(project, "opencode.json"), JSON.stringify(createModelConfig(baseURL), null, 2))
}

async function runDirectBackgroundCases(session: Session) {
  assert(project && outside, "fixture paths are missing")
  const cases: Array<{ name: string; command: string; expected?: string; env?: Record<string, string>; cwd?: string }> =
    [
      {
        name: "raw multiline",
        command: "printf 'MULTILINE_ONE\\n'\nprintf 'MULTILINE_TWO\\n'",
        expected: ptyExpected("MULTILINE_ONE\nMULTILINE_TWO\n"),
      },
      {
        name: "quoted LF tab CR",
        command: "printf 'CONTROL_A\\nCONTROL_B\\tCONTROL_C\\rCONTROL_D'",
        expected: ptyExpected("CONTROL_A\nCONTROL_B\tCONTROL_C\rCONTROL_D"),
      },
      {
        name: "raw LF tab CR inside quotes",
        command: "printf '%s' 'RAW_LF\nRAW_TAB\tRAW_CR\rRAW_END'",
        expected: ptyExpected("RAW_LF\nRAW_TAB\tRAW_CR\rRAW_END"),
      },
      {
        name: "heredoc",
        command: "cat <<'EOF'\nHEREDOC_LINE_ONE\nHEREDOC_LINE_TWO\nEOF",
        expected: ptyExpected("HEREDOC_LINE_ONE\nHEREDOC_LINE_TWO\n"),
      },
      { name: "backslash newline continuation", command: "printf '<%s>' hello\\\nworld", expected: "<helloworld>" },
      {
        name: "literal substitutions",
        command: `printf '%s' "\\$HOME|\\$(touch QA_LITERAL_MARKER)|\\\`touch QA_LITERAL_MARKER\\\`"`,
        expected: "$HOME|$(touch QA_LITERAL_MARKER)|`touch QA_LITERAL_MARKER`",
      },
      {
        name: "assignment then expansion",
        command: "QA_ASSIGN=assignment-value\nprintf '%s' \"$QA_ASSIGN\"",
        expected: "assignment-value",
      },
      {
        name: "background PID expansion",
        command: 'sleep 10 & pid=$!; kill "$pid"; wait "$pid" 2>/dev/null; printf \'PID:%s\' "$pid"',
        expected: "PID:",
      },
      {
        name: "hostile environment stays data",
        command: "printf '%s' \"$QA_HOSTILE_DIRECT\"",
        env: { QA_HOSTILE_DIRECT: `quote' "double"; touch '${path.join(outside, "hostile-marker")}'; printf 'ran` },
        expected: `quote' "double"; touch '${path.join(outside, "hostile-marker")}'; printf 'ran`,
      },
      {
        name: "unicode and backslashes",
        command: "printf '%s' '雪 ☃ C:\\tmp\\folder'",
        expected: "雪 ☃ C:\\tmp\\folder",
      },
      {
        name: "special workdir",
        command: "pwd",
        cwd: path.join(project, "work dir $ and ' quote"),
        expected: ptyExpected(`${path.join(project, "work dir $ and ' quote")}\n`),
      },
    ]
  for (const item of cases) {
    await caseRun(`direct background ${item.name}`, "backend", async () => {
      const job = await createBackground(session, item.command, {
        ...(item.env ? { env: item.env } : {}),
        ...(item.cwd ? { cwd: item.cwd } : {}),
      })
      const final = await waitJob(session, job.id, ["completed", "error"])
      const output = final.outputTail ?? ""
      if (item.name === "background PID expansion") assert(/PID:\d+/.test(output), "background PID was not captured")
      else assert(output === item.expected, `output mismatch for ${item.name}`)
      assert(
        final.status === "completed" && (final.exitCode === undefined || final.exitCode === 0),
        "expected successful completion",
      )
      return {
        sessionID: session.id,
        callID: final.callID,
        jobID: final.id,
        ptyID: final.ptyID,
        status: final.status,
        exitCode: final.exitCode,
      }
    })
  }
  assert(!(await Bun.file(path.join(outside, "hostile-marker")).exists()), "hostile environment created a marker file")

  await caseRun("direct background preserves exit 7", "backend", async () => {
    const job = await createBackground(session, "printf EXIT_SEVEN; exit 7")
    const final = await waitJob(session, job.id, ["error"])
    assert(final.exitCode === 7, `expected exit code 7, got ${final.exitCode}`)
    return {
      sessionID: session.id,
      callID: final.callID,
      jobID: final.id,
      ptyID: final.ptyID,
      exitCode: final.exitCode,
    }
  })

  await caseRun("direct background rejects NUL before spawn", "backend", async () => {
    const before = await listJobs(session)
    const status = await expectRejected(session.directory, "/background-shell", "POST", {
      sessionID: session.id,
      command: "printf before\u0000printf after",
      cwd: project,
      description: "NUL rejection probe",
    })
    const after = await listJobs(session)
    assert(after.length === before.length, "NUL command created a monitored job")
    return { sessionID: session.id, rejectedStatus: status, jobsUnchanged: true }
  })

  await caseRun("direct background stop records stopped state", "backend", async () => {
    const job = await createBackground(session, "printf STOP_READY; sleep 60")
    await wait(`long-running output ${job.id}`, async () => {
      const current = (await listJobs(session)).find((item) => item.id === job.id)
      return current?.outputTail?.includes("STOP_READY") ? current : undefined
    })
    await api<boolean>(session.directory, `/background-shell/${job.id}`, "DELETE")
    const final = await waitJob(session, job.id, ["stopped"])
    return { sessionID: session.id, callID: final.callID, jobID: final.id, ptyID: final.ptyID, status: final.status }
  })
}

async function runAgentToolCases(session: Session) {
  assert(project && outside, "fixture paths are missing")
  const literalMarker = path.join(project, "QA_LITERAL_MARKER")
  const entries = [
    {
      marker: "agent-multiline",
      command:
        "printf 'AGENT_LINE_ONE\\nAGENT_LINE_TWO\\n'\nprintf '%s\\n' '$HOME|$(touch QA_LITERAL_MARKER)|`touch QA_LITERAL_MARKER`'",
      expected: "AGENT_LINE_ONE",
    },
    {
      marker: "agent-hostile-env",
      command: "printf '%s' \"$QA_HOSTILE\"",
      expected: `plugin-quote' "double"; touch QA_ENV_MARKER; printf 'ran`,
    },
    {
      marker: "agent-background",
      command: "printf AGENT_BACKGROUND_READY; sleep 0.2",
      description: "Start monitored shell task",
      background: true,
      expected: "AGENT_BACKGROUND_READY",
    },
  ]
  for (const item of entries) {
    toolCases.set(item.marker, {
      command: item.command,
      description: item.description ?? `Run ${item.marker}`,
      background: item.background,
    })
    const markerSession = await makeSession(project, `Shell QA ${item.marker}`, [
      { permission: "bash", pattern: "*", action: "allow" },
    ])
    await caseRun(
      `agent bash tool ${item.marker}`,
      item.marker === "agent-multiline" ? "mixed" : "backend",
      async () => {
        const response = await api<any>(markerSession.directory, `/session/${markerSession.id}/message`, "POST", {
          agent: "build",
          model: { providerID: "qa", modelID: "test-model" },
          parts: [{ type: "text", text: `QA_TOOL_CASE:${item.marker} Execute the one provided command.` }],
        })
        const finalReply = await waitAssistant(markerSession, `QA_TOOL_DONE:${item.marker}`)
        const promptRows = await messages(markerSession)
        assert(
          promptRows.some(
            (row) =>
              row.info?.role === "user" && JSON.stringify(row.parts ?? []).includes(`QA_TOOL_CASE:${item.marker}`),
          ),
          "agent tool prompt was not retained in the session API",
        )
        const completed = await waitTool(markerSession, item.marker)
        if (item.background) {
          const job = await wait(`agent background job ${item.marker}`, async () => {
            const rows = await listJobs(markerSession)
            return rows.find((row) => row.command === item.command)
          })
          const final = await waitJob(markerSession, job.id, ["completed"])
          assert(final.outputTail?.includes(item.expected ?? ""), "background bash output not retained")
          return {
            sessionID: markerSession.id,
            messageID: finalReply.info?.id ?? response.info?.id,
            callID: completed.part.callID,
            jobID: final.id,
            ptyID: final.ptyID,
            status: final.status,
          }
        }
        assert(completed.output.includes(item.expected ?? ""), "tool output not retained in session messages")
        if (item.marker === "agent-multiline") {
          await navigate(markerSession.directory, markerSession.id)
          await renderedBashOutput(markerSession.id, "AGENT_LINE_TWO")
        }
        return {
          sessionID: markerSession.id,
          messageID: finalReply.info?.id ?? response.info?.id,
          callID: completed.part.callID,
          toolStatus: completed.part.state.status,
          ...(item.marker === "agent-multiline" ? { outputRenderedInUI: true } : {}),
        }
      },
    )
  }
  assert(!(await Bun.file(literalMarker).exists()), "literal command substitution created a marker file")
  assert(!(await Bun.file(path.join(project, "QA_LITERAL_MARKER")).exists()), "literal substitution marker was created")
  assert(!(await Bun.file(path.join(project, "QA_ENV_MARKER")).exists()), "shell.env data executed as command syntax")
}

async function runPermissionCases() {
  assert(project && outside, "fixture paths are missing")
  const outsideRead = path.join(outside, "readme.txt")
  const relativeRead = path.relative(project, outsideRead)
  const deniedMarker = path.join(outside, "denied-redirection-marker")
  const relativeDenied = path.relative(project, deniedMarker)
  const permissions = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
  ]
  const uiRead = await makeSession(project, "Shell QA UI external read approval", permissions)
  toolCases.set("permission-ui-allow", {
    command: `${shellQuote("cat")} ${shellQuote(relativeRead)}`,
    description: "Read owned external fixture",
  })
  await caseRun("permission dock approves quoted cat and returns fixture content", "mixed", async () => {
    const result = await routePermissionCase({
      session: uiRead,
      marker: "permission-ui-allow",
      navigateUI: true,
      uiAction: "allow",
    })
    assert(result.tool.output.includes("OUTSIDE_CONTROLLED_READ"), "approved read did not return fixture content")
    assert(result.permission.permission === "external_directory", "UI approval was not an external-directory request")
    assert(result.permission.patterns?.length > 0, "permission request had no path patterns")
    return {
      sessionID: uiRead.id,
      permissionID: result.permission.id,
      callID: result.tool.part.callID,
      uiAction: "allow once",
      toolStatus: result.tool.part.state.status,
    }
  })

  const bashAllow = await makeSession(project, "Shell QA Bash permission allow", [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ])
  toolCases.set("permission-bash-allow", {
    command: "> QA_BASH_ALLOWED_MARKER < inside.txt",
    description: "Create Bash-approved in-project marker",
  })
  await caseRun("permission dock allows Bash before an in-project redirect", "mixed", async () => {
    const result = await routePermissionCase({
      session: bashAllow,
      marker: "permission-bash-allow",
      permissionName: "bash",
      navigateUI: true,
      uiAction: "allow",
    })
    assert(result.permission.permission === "bash", "UI approved the wrong permission class")
    const markerPath = path.join(project!, "QA_BASH_ALLOWED_MARKER")
    assert(await Bun.file(markerPath).exists(), "approved Bash redirect did not run")
    assert((await readFile(markerPath, "utf8")) === "INSIDE_CONTROLLED\n", "approved redirect did not consume owned stdin")
    return {
      sessionID: bashAllow.id,
      permissionID: result.permission.id,
      callID: result.tool.part.callID,
      markerPresent: true,
    }
  })

  const uiDeny = await makeSession(project, "Shell QA UI deny", permissions)
  assert(!(await Bun.file(deniedMarker).exists()), "denial marker unexpectedly existed before test")
  toolCases.set("permission-ui-deny", {
    command: `> ${shellQuote(relativeDenied)}`,
    description: "Create denied fixture marker",
  })
  await caseRun("permission dock denies redirect-only write without mutation", "mixed", async () => {
    const result = await routePermissionCase({
      session: uiDeny,
      marker: "permission-ui-deny",
      navigateUI: true,
      uiAction: "deny",
    })
    assert(!(await Bun.file(deniedMarker).exists()), "denied redirect created a file")
    assert(result.permission.permission === "external_directory", "wrong permission was shown in dock")
    return {
      sessionID: uiDeny.id,
      permissionID: result.permission.id,
      callID: result.tool.part.callID,
      uiAction: "deny",
      markerAbsent: true,
    }
  })

  const bashDeny = await makeSession(project, "Shell QA Bash permission deny", [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ])
  toolCases.set("permission-bash-deny", {
    command: "> QA_BASH_DENIED_MARKER",
    description: "Create Bash-denied in-project marker",
  })
  await caseRun("permission dock denies Bash before an in-project redirect", "mixed", async () => {
    assert(!(await Bun.file(path.join(project!, "QA_BASH_DENIED_MARKER")).exists()), "Bash marker existed before denial")
    const result = await routePermissionCase({
      session: bashDeny,
      marker: "permission-bash-deny",
      permissionName: "bash",
      navigateUI: true,
      uiAction: "deny",
    })
    assert(result.permission.permission === "bash", "UI denied the wrong permission class")
    assert(
      !(await Bun.file(path.join(project!, "QA_BASH_DENIED_MARKER")).exists()),
      "denied Bash redirect created a file",
    )
    return {
      sessionID: bashDeny.id,
      permissionID: result.permission.id,
      callID: result.tool.part.callID,
      markerAbsent: true,
    }
  })

  const dynamic = await makeSession(project, "Shell QA dynamic path denied", permissions)
  const dynamicCase = "permission-dynamic-path"
  toolCases.set(dynamicCase, {
    command: `cat "$${dynamicPathEnv}"`,
    description: "Deny dynamic external path before execution",
  })
  await caseRun("API denies dynamic path fallback before reading outside fixture", "backend", async () => {
    const result = await routePermissionCase({ session: dynamic, marker: dynamicCase, reply: "reject" })
    assert(
      result.permission.permission === "external_directory",
      "dynamic path did not request external-directory approval",
    )
    assert(result.tool.part.state.status === "error", "denied dynamic path was not blocked")
    assert(
      result.permission.patterns?.some((pattern: string) => pattern.includes("**") || pattern === "*"),
      "dynamic fallback was not broad",
    )
    return {
      sessionID: dynamic.id,
      permissionID: result.permission.id,
      callID: result.tool.part.callID,
      apiReply: "reject",
      executed: false,
    }
  })

  const apiCases: Array<{ marker: string; command: string; verify?: (output: string) => void }> = [
    {
      marker: "permission-escaped-parent",
      command: `cat \\${relativeRead}`,
      verify: (output) => assert(output.includes("OUTSIDE_CONTROLLED_READ"), "escaped path not read"),
    },
    {
      marker: "permission-input-redirection",
      command: `cat < ${shellQuote(relativeRead)}`,
      verify: (output) => assert(output.includes("OUTSIDE_CONTROLLED_READ"), "input redirection not read"),
    },
    {
      marker: "permission-append-redirection",
      command: `printf APPEND_SAFE >> ${shellQuote(path.relative(project, path.join(outside, "append.txt")))}`,
    },
    {
      marker: "permission-brace-expansion",
      command: `cat {${relativeRead},inside.txt}`,
      verify: (output) => assert(output.includes("OUTSIDE_CONTROLLED_READ"), "brace path not read"),
    },
    {
      marker: "permission-process-substitution",
      command: `cat <(cat ${shellQuote(relativeRead)})`,
      verify: (output) => assert(output.includes("OUTSIDE_CONTROLLED_READ"), "process-substitution path not read"),
    },
    {
      marker: "permission-cwd-ambiguous",
      command: `cd ..; cat '${path.relative(path.dirname(project), outside)}/readme.txt'`,
      verify: (output) => assert(output.includes("OUTSIDE_CONTROLLED_READ"), "cwd-changing path not read"),
    },
  ]
  for (const item of apiCases) {
    const session = await makeSession(project, `Shell QA ${item.marker}`, permissions)
    toolCases.set(item.marker, { command: item.command, description: `Permission scan ${item.marker}` })
    await caseRun(`API permission ${item.marker} once`, "backend", async () => {
      const result = await routePermissionCase({ session, marker: item.marker, reply: "once" })
      item.verify?.(result.tool.output)
      assert(result.permission.permission === "external_directory", "missing external-directory permission")
      return {
        sessionID: session.id,
        permissionID: result.permission.id,
        callID: result.tool.part.callID,
        toolStatus: result.tool.part.state.status,
        apiReply: "once",
      }
    })
  }
  await caseRun("API append redirection modified only the owned fixture", "backend", async () => {
    const content = await readFile(path.join(outside!, "append.txt"), "utf8")
    assert(content === "APPEND_SAFE", "append redirection content differed")
    return { fixtureDirectory: true, appendFileOwned: true }
  })

  const numeric = await makeSession(project, "Shell QA numeric redirect", permissions)
  toolCases.set("permission-numeric-redirection", {
    command: "> 123 < inside.txt",
    description: "Create numeric filename from owned input",
  })
  await caseRun("numeric redirection is treated as an in-project filename", "backend", async () => {
    await startToolCase(numeric, "permission-numeric-redirection")
    const external = await wait(`numeric redirect tool completion ${numeric.id}`, async () => {
      const requests = await api<any[]>(numeric.directory, "/permission")
      if (requests.some((item) => item.sessionID === numeric.id && item.permission === "external_directory"))
        return "external"
      const parts = await toolParts(numeric)
      if (parts.some((item) => item.state?.status === "completed" || item.state?.status === "error")) return "complete"
      return undefined
    })
    assert(external === "complete", "numeric destination incorrectly requested external-directory approval")
    await waitAssistant(numeric, "QA_TOOL_DONE:permission-numeric-redirection")
    const target = path.join(project!, "123")
    assert(await Bun.file(target).exists(), "numeric target file was not created")
    assert((await readFile(target, "utf8")) === "INSIDE_CONTROLLED\n", "numeric redirect did not consume owned stdin")
    return { sessionID: numeric.id, target: "123", externalPermission: false }
  })
}

async function runManualShell(session: Session) {
  assert(project && cdp, "fixture or CDP is unavailable")
  const marker = "QA_MANUAL_SHELL_VISIBLE"
  await navigate(session.directory, session.id)
  await caseRun("manual session shell is visible in actual timeline", "mixed", async () => {
    const message = await api<any>(session.directory, `/session/${session.id}/shell`, "POST", {
      agent: "build",
      model: { providerID: "qa", modelID: "test-model" },
      command: `printf '%s\\n' '${marker}'\nprintf '%s' '$HOME|$(touch QA_MANUAL_LITERAL_MARKER)'`,
    })
    const shellPart = message.parts?.find((part: any) => part.type === "tool")
    assert(shellPart?.state?.status === "completed", "manual shell part did not complete")
    assert(String(shellPart.state.output ?? "").includes(marker), "manual shell backend output missing")
    await renderedBashOutput(session.id, marker)
    assert(!(await Bun.file(path.join(project!, "QA_MANUAL_LITERAL_MARKER")).exists()), "manual shell literal executed")
    await uiScreenshot("manual-shell-timeline")
    return {
      sessionID: session.id,
      messageID: message.info?.id,
      callID: shellPart.callID,
      renderedOutputVerified: true,
    }
  })
  await caseRun("composer shell mode submits multiline text through the visible UI", "ui", async () => {
    assert(cdp, "CDP client is not connected")
    const settings = await cdp.evaluate<string | undefined>(
      "window.api.storeGet('default.dat','settings.v3').then(value=>value)",
    )
    const overrides = settings ? (JSON.parse(settings) as { keybinds?: Record<string, string> }).keybinds : undefined
    const binding = overrides?.["prompt.mode.shell"] ?? "mod+shift+x"
    if (binding === "none") {
      return { sessionID: session.id, keybind: "none", skipped: true, reason: "prompt.mode.shell is unbound" }
    }
    const platform = await cdp.evaluate<string>("navigator.platform")
    const parts = binding.split(",")[0]!.toLowerCase().split("+")
    const key = parts.at(-1)!
    let modifiers = 0
    for (const part of parts.slice(0, -1)) {
      if (part === "shift") modifiers |= 8
      else if (part === "alt" || part === "option") modifiers |= 1
      else if (part === "ctrl" || part === "control") modifiers |= 2
      else if (part === "meta" || part === "cmd" || (part === "mod" && /mac|iphone|ipad/i.test(platform)))
        modifiers |= 4
      else if (part === "mod") modifiers |= 2
    }
    const code = key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key
    const keyName =
      key.length === 1 ? (parts.includes("shift") ? key.toUpperCase() : key) : key[0]!.toUpperCase() + key.slice(1)
    const virtualKey = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
    log(`UI composer mode keybind dispatch session=${session.id} binding=${binding}`)
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await cdp.call("Input.dispatchKeyEvent", {
        type,
        key: keyName,
        code,
        modifiers,
        windowsVirtualKeyCode: virtualKey,
        nativeVirtualKeyCode: virtualKey,
      })
    }
    await wait("composer entered shell mode using the effective configured keybind", () =>
      cdp!
        .evaluate<boolean>(
          `(() => {
        const attach=document.querySelector('[data-action="prompt-attach"]');
        return !!attach && attach.hasAttribute('disabled');
      })()`,
        )
        .then((yes) => yes || undefined),
    )
    const editor = await cdp.evaluate<boolean>(`(() => {
      const page=document.querySelector('[data-component="session-page"][data-session-id="${session.id}"]');
      const node=page?.querySelector('[data-component="prompt-input"][contenteditable="true"]');
      if(!(node instanceof HTMLElement))return false;node.focus();return document.activeElement===node;
    })()`)
    assert(editor, "current session composer editor was not focusable")
    const composerMarker = "QA_COMPOSER_SHELL_VISIBLE"
    log(`UI composer shell text insertion requested session=${session.id} marker=${composerMarker}`)
    await cdp.call("Input.insertText", {
      text: `printf '%s\\n' '${composerMarker}'\nprintf '%s' '$HOME|$(touch QA_COMPOSER_MARKER)'`,
    })
    await wait("composer contains the multiline shell command", () =>
      cdp!
        .evaluate<boolean>(`(() => {
          const page=document.querySelector('[data-component="session-page"][data-session-id="${session.id}"]');
          const node=page?.querySelector('[data-component="prompt-input"][contenteditable="true"]');
          const text=node?.textContent||'';
          return text.includes(${JSON.stringify(composerMarker)})&&text.includes('$(touch QA_COMPOSER_MARKER)');
        })()`)
        .then((ready) => ready || undefined),
    )
    const focused = await cdp.evaluate<boolean>(`(() => {
      const page=document.querySelector('[data-component="session-page"][data-session-id="${session.id}"]');
      const node=page?.querySelector('[data-component="prompt-input"][contenteditable="true"]');
      if(!(node instanceof HTMLElement))return false;node.focus();return document.activeElement===node;
    })()`)
    assert(focused, "current session shell editor lost focus before Enter")
    const inputLength = await cdp.evaluate<number>(`document.querySelector('[data-component="session-page"][data-session-id="${session.id}"] [data-component="prompt-input"][contenteditable="true"]')?.textContent?.length||0`)
    log(`UI composer shell Enter dispatch session=${session.id} inputLength=${inputLength}`)
    await cdp.call("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    await cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    await wait(`composer shell backend output ${composerMarker}`, async () => {
      const rows = await messages(session)
      const part = rows
        .flatMap((row) => row.parts ?? [])
        .find(
          (item: any) =>
            item.type === "tool" &&
            item.state?.status === "completed" &&
            String(item.state.output ?? "").includes(composerMarker),
        )
      return part ? true : undefined
    })
    await renderedBashOutput(session.id, composerMarker)
    assert(
      !(await Bun.file(path.join(project!, "QA_COMPOSER_MARKER")).exists()),
      "composer literal substitution executed",
    )
    return { sessionID: session.id, keybind: binding, shellModeVerified: true, markerVisibleInDOM: true }
  })
}

async function runSlashCommands(session: Session) {
  assert(project && outside, "fixture paths are missing")
  const configured = await api<Array<{ name: string }>>(project, "/command")
  const commandNames = new Set(configured.map((item) => item.name))
  for (const name of [
    "trusted",
    "placeholder",
    "append",
    "numeric",
    "generated",
    "heredoc",
    "nul-probe",
    "skill-e2e",
  ]) {
    assert(commandNames.has(name), `fixture command was not registered: ${name}`)
  }
  const trustedMarker = path.join(project, "trusted-shell.txt")
  const arbitraryMarker = path.join(project, "QA_SLASH_MARKER")
  const cases: Array<{ command: string; arguments: string; marker?: string; expected?: string }> = [
    {
      command: "trusted",
      arguments: `QA_SLASH_CASE:trusted literal !\`touch QA_SLASH_MARKER\` $ARGUMENTS $&|$\`|$'`,
      marker: "QA_SLASH_CASE:trusted",
      expected: "TRUSTED_SHELL_OK",
    },
    {
      command: "placeholder",
      arguments: `QA_SLASH_CASE:placeholder user text !\`touch QA_SLASH_MARKER\` $&|$\`|$'`,
      marker: "QA_SLASH_CASE:placeholder",
    },
    {
      command: "append",
      arguments: `QA_SLASH_CASE:append append text !\`touch QA_SLASH_MARKER\``,
      marker: "QA_SLASH_CASE:append",
      expected: "APPEND_SHELL_OK",
    },
    {
      command: "skill-e2e",
      arguments: `QA_SLASH_CASE:skill skill text !\`touch QA_SLASH_MARKER\``,
      marker: "QA_SLASH_CASE:skill",
    },
  ]
  for (const item of cases) {
    await caseRun(`slash command ${item.command} keeps arguments literal`, "backend", async () => {
      const reply = await api<any>(session.directory, `/session/${session.id}/command`, "POST", {
        command: item.command,
        arguments: item.arguments,
        agent: "build",
        model: "qa/test-model",
      })
      const rows = await messages(session)
      const feed = JSON.stringify(rows)
      assert(feed.includes("QA_SLASH_DONE"), "fake provider final reply missing")
      if (item.expected) assert(feed.includes(item.expected), "trusted shell output missing from command prompt")
      assert(feed.includes(item.arguments), "user arguments were not preserved in model prompt")
      assert(!(await Bun.file(arbitraryMarker).exists()), "user shell marker executed")
      if (item.command === "trusted")
        assert(await Bun.file(trustedMarker).exists(), "trusted original shell block did not execute")
      const marker = item.marker!.replace("QA_SLASH_CASE:", "")
      const captured = slashObservations.get(marker)
      assert(captured?.sawArguments, "loopback model did not receive slash-command content")
      return {
        sessionID: session.id,
        messageID: reply.info?.id,
        trustedExecution: item.command === "trusted",
        fakeModelCalls: captured.requestCount,
      }
    })
  }

  const dataArgs = `"space O'Brien ; $(touch QA_SLASH_MARKER)"`
  await caseRun("slash numeric placeholder binds quoted argument as data", "backend", async () => {
    await api(session.directory, `/session/${session.id}/command`, "POST", {
      command: "numeric",
      arguments: dataArgs,
      agent: "build",
      model: "qa/test-model",
    })
    const rows = await messages(session)
    const feed = JSON.stringify(rows)
    assert(feed.includes("<space O'Brien ; $(touch"), "numeric argument was not bound as a single data value")
    assert(!(await Bun.file(arbitraryMarker).exists()), "numeric shell argument executed substitution")
    const captured = slashPromptObservations.get("numeric") ?? ""
    assert(captured.includes("<space O'Brien ; $(touch"), "numeric shell output missing from model prompt")
    return { sessionID: session.id, quotedArgument: true }
  })

  await caseRun("trusted shell output is not rescanned or replaced", "backend", async () => {
    await api(session.directory, `/session/${session.id}/command`, "POST", {
      command: "generated",
      arguments: "REPLACEMENT_MUST_NOT_HAPPEN",
      agent: "build",
      model: "qa/test-model",
    })
    const rows = await messages(session)
    const feed = JSON.stringify(rows)
    assert(feed.includes("GENERATED_LITERAL !`touch GENERATED_MARKER` $ARGUMENTS"), "trusted output was transformed")
    const captured = slashPromptObservations.get("generated") ?? ""
    const expectedOutput = "GENERATED_LITERAL !`touch GENERATED_MARKER` $ARGUMENTS"
    const outputIndex = captured.indexOf("GENERATED_LITERAL")
    assert(
      outputIndex >= 0 && captured.slice(outputIndex, outputIndex + expectedOutput.length) === expectedOutput,
      "generated shell output was transformed in the model prompt",
    )
    assert(
      !(await Bun.file(path.join(project!, "GENERATED_MARKER")).exists()),
      "generated marker output executed as shell",
    )
    return { sessionID: session.id, outputLiteral: true }
  })

  await caseRun("parameterized heredoc is rejected before any template node spawns", "backend", async () => {
    const status = await expectRejected(session.directory, `/session/${session.id}/command`, "POST", {
      command: "heredoc",
      arguments: "would-be-value",
      agent: "build",
      model: "qa/test-model",
    })
    assert([400, 422, 500].includes(status), `unexpected heredoc rejection HTTP ${status}`)
    assert(
      !(await Bun.file(path.join(project!, "HEREDOC_MARKER")).exists()),
      "trusted prefix node ran before heredoc rejection",
    )
    return { sessionID: session.id, rejected: true, prefixMarkerAbsent: true }
  })

  await caseRun("NUL command arguments are rejected before template execution", "backend", async () => {
    const status = await expectRejected(session.directory, `/session/${session.id}/command`, "POST", {
      command: "nul-probe",
      arguments: "\u0000",
      agent: "build",
      model: "qa/test-model",
    })
    assert([400, 422, 500].includes(status), `unexpected NUL rejection HTTP ${status}`)
    assert(
      !(await Bun.file(path.join(project!, "NUL_ARGUMENT_MARKER")).exists()),
      "NUL argument ran a trusted shell node",
    )
    return { sessionID: session.id, rejected: true }
  })
}

async function runBackgroundNotification(session: Session) {
  assert(project, "fixture path is missing")
  await caseRun("background job completion, nonzero exit, stop, and notification", "backend", async () => {
    // Start SessionPrompt's event subscription before direct background API jobs.
    await api(session.directory, `/session/${session.id}/shell`, "POST", {
      agent: "build",
      model: { providerID: "qa", modelID: "test-model" },
      command: "printf SUBSCRIPTION_READY",
    })
    const completed = await createBackground(session, "printf BACKGROUND_DONE; sleep 0.1", {
      description: "QA completion notification",
    })
    const done = await waitJob(session, completed.id, ["completed"])
    const nonzero = await createBackground(session, "printf BACKGROUND_NONZERO; exit 7")
    const failed = await waitJob(session, nonzero.id, ["error"])
    assert(failed.exitCode === 7, `background nonzero exit was ${failed.exitCode}`)
    const stopped = await createBackground(session, "printf BACKGROUND_STOP_READY; sleep 60")
    await wait(`stop job output ${stopped.id}`, async () => {
      const item = (await listJobs(session)).find((job) => job.id === stopped.id)
      return item?.outputTail?.includes("BACKGROUND_STOP_READY") ? item : undefined
    })
    await api<boolean>(session.directory, `/background-shell/${stopped.id}`, "DELETE")
    const stoppedResult = await waitJob(session, stopped.id, ["stopped"])
    const notification = await wait("background-shell inbox message", async () => {
      const rows = await messages(session)
      return rows.find((row) => JSON.stringify(row).includes(`background_shell_id: ${done.id}`))
    })
    await wait("fake model acknowledged background notification", async () =>
      backgroundAckCount > 0 ? true : undefined,
    )
    return {
      sessionID: session.id,
      completedCallID: done.callID,
      completedJobID: done.id,
      completedPtyID: done.ptyID,
      nonzeroCallID: failed.callID,
      nonzeroJobID: failed.id,
      nonzeroExitCode: failed.exitCode,
      stoppedCallID: stoppedResult.callID,
      stoppedJobID: stoppedResult.id,
      notificationMessageID: notification.info?.id,
      notificationAck: true,
    }
  })
}

async function captureInitialRoute() {
  assert(cdp, "CDP client is not connected")
  return cdp.evaluate<{
    href: string
    pathname: string
    search: string
    hash: string
    sessionID?: string
    directory?: string
  }>(`(() => {
    const href=location.href;const pathname=location.pathname;const search=location.search;const hash=location.hash;
    const visible=node=>node&&node.getClientRects().length>0;
    const page=[...document.querySelectorAll('[data-component="session-page"][data-session-id]')].find(visible);
    const tab=[...document.querySelectorAll('[data-component="session-tab"][data-session-id][data-active="true"]')].find(visible);
    const scope=[...document.querySelectorAll('[data-prompt-scope]')].filter(visible).map(node=>{try{return JSON.parse(node.getAttribute('data-prompt-scope')||'null')}catch{return null}}).find(value=>Array.isArray(value));
    const sessionID=page?.getAttribute('data-session-id')||tab?.getAttribute('data-session-id');
    const directory=(scope?.[0]&&(!sessionID||scope?.[1]===sessionID)?scope[0]:undefined)||tab?.getAttribute('data-directory')||undefined;
    if(sessionID&&directory)return {href,pathname,search,hash,sessionID,directory};
    const match=pathname.match(/^\\/([^/]+)\\/session\\/([^/]+)/);
    if(!match)return {href,pathname,search,hash};
    try{return {href,pathname,search,hash,sessionID:match[2],directory:atob(match[1].replace(/-/g,'+').replace(/_/g,'/'))}}catch{return {href,pathname,search,hash}}
  })()`)
}

async function cleanup() {
  if (cleanupDone) return
  cleanupDone = true
  if (sidecar) {
    for (const job of jobs) {
      try {
        const headers = authHeaders(job.directory)
        const response = await fetch(`${sidecar.url}/background-shell/${job.id}`, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(4_000),
        })
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        results.push({ name: `cleanup job ${job.id}`, surface: "backend", status: "fail", error: errorText(error) })
      }
    }
    for (const session of sessions) {
      try {
        const abortResponse = await fetch(`${sidecar.url}/session/${session.id}/abort`, {
          method: "POST",
          headers: authHeaders(session.directory),
          signal: AbortSignal.timeout(4_000),
        })
        if (!abortResponse.ok && abortResponse.status !== 404) throw new Error(`Abort HTTP ${abortResponse.status}`)
        const response = await fetch(`${sidecar.url}/session/${session.id}`, {
          method: "DELETE",
          headers: authHeaders(session.directory),
          signal: AbortSignal.timeout(4_000),
        })
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        results.push({
          name: `cleanup session ${session.id}`,
          surface: "backend",
          status: "fail",
          error: errorText(error),
        })
      }
    }
  }
  if (cdp && previousSession?.id && previousSession.directory) {
    try {
      await navigate(previousSession.directory, previousSession.id)
      log(`restored prior renderer session=${previousSession.id}`)
    } catch (error) {
      results.push({ name: "restore prior renderer route", surface: "ui", status: "fail", error: errorText(error) })
    }
  } else if (cdp) {
    try {
      const source = `/@fs${appSource}utils/notification-click.ts`
      await cdp.evaluate(`(() => { void import(${JSON.stringify(source)}).then(m=>m.handleNotificationClick('/')); return true })()`)
      await wait("restore renderer Home route", () =>
        cdp!
          .evaluate<boolean>(`(() => { const node=document.querySelector('[data-component="home-shell"]'); return !!node&&node.getClientRects().length>0 })()`)
          .then((yes) => yes || undefined),
      )
      log("restored renderer Home route")
    } catch (error) {
      results.push({ name: "restore prior renderer route", surface: "ui", status: "fail", error: errorText(error) })
    }
  }
  try {
    modelServer?.stop(true)
  } catch (error) {
    results.push({ name: "stop loopback fake model", surface: "backend", status: "fail", error: errorText(error) })
  }
  if (fixture) {
    try {
      await rm(fixture, { recursive: true, force: true })
      fixtureRemoved = true
    } catch (error) {
      results.push({ name: "remove owned fixture", surface: "backend", status: "fail", error: errorText(error) })
    }
  }
}

async function main() {
  let fatal: unknown
  try {
    await withCdp(async (client, target) => {
      cdp = client
      try {
        assert(target.url.includes("localhost:5173"), "Refusing non-development renderer target")
        uiTarget = true
        const initial = await client.evaluate<{ url: string; username: string; password: string }>(
          "window.api.awaitInitialization(()=>{})",
        )
        sidecar = initial
        const initialRoute = await captureInitialRoute()
        previousSession =
          initialRoute.sessionID && initialRoute.directory
            ? { id: initialRoute.sessionID, directory: initialRoute.directory }
            : undefined
        modelServer = startFakeModel()
        await wait("loopback fake model health", async () => {
          const response = await fetch(`http://127.0.0.1:${modelServer!.port}/health`, {
            signal: AbortSignal.timeout(2_000),
          })
          return response.ok ? true : undefined
        })
        await setupFixture(`http://127.0.0.1:${modelServer.port}/v1`)
        assert(project, "temporary project not initialized")
        await openFixtureProjectViaHomeUI(project)

        const direct = await makeSession(project, "Shell escaping direct PTY acceptance", [
          { permission: "bash", pattern: "*", action: "allow" },
        ])
        await runDirectBackgroundCases(direct)

        const agentSession = await makeSession(project, "Shell escaping agent tool acceptance", [
          { permission: "bash", pattern: "*", action: "allow" },
        ])
        await runAgentToolCases(agentSession)

        await runPermissionCases()

        const manual = await makeSession(project, "Shell escaping manual shell acceptance", [
          { permission: "bash", pattern: "*", action: "allow" },
        ])
        await runManualShell(manual)

        const slash = await makeSession(project, "Shell escaping slash command acceptance", [
          { permission: "bash", pattern: "*", action: "allow" },
        ])
        await runSlashCommands(slash)

        const background = await makeSession(project, "Shell escaping background notification acceptance", [
          { permission: "bash", pattern: "*", action: "allow" },
        ])
        await runBackgroundNotification(background)
        await wait("sidecar request activity", async () => (requestCount > 0 ? true : undefined))
        results.push({
          name: "isolated fixture uses loopback fake model",
          surface: "backend",
          status: "pass",
          details: { modelRequests: requestCount, noExternalProviderConfigured: true },
        })
      } finally {
        await cleanup()
      }
    })
  } catch (error) {
    fatal = error
    results.push({
      name: "harness setup or fatal path",
      surface: uiTarget ? "mixed" : "backend",
      status: "fail",
      error: errorText(error),
    })
    log(`FATAL ${errorText(error)}`)
  } finally {
    await cleanup()
    cdp?.close()
    const report = {
      generatedAt: new Date().toISOString(),
      target: uiTarget ? "development renderer on CDP 9222" : "not verified",
      fixture: fixtureRemoved ? "removed after run" : fixture ? "removal failed or incomplete" : "not created",
      model: "loopback OpenAI-compatible fake; no external API calls",
      totals: {
        pass: results.filter((item) => item.status === "pass").length,
        fail: results.filter((item) => item.status === "fail").length,
        skipped: results.filter((item) => item.status === "skipped").length,
      },
      results,
    }
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    log(
      `report=${path.resolve(reportPath)} pass=${report.totals.pass} fail=${report.totals.fail} skipped=${report.totals.skipped}`,
    )
  }
  if (fatal || results.some((item) => item.status === "fail")) process.exitCode = 1
}

await main()
