import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

const log = (message: string) => console.log(`[external-handoff-e2e] ${message}`)
const root = await mkdtemp("/tmp/opencode-external-handoff-")
const workspace = path.join(root, "workspace")
const bin = path.join(root, "bin")
const advisor = process.env.EXTERNAL_TEST_ADVISOR ?? "codex"
assert.ok(["codex", "claude", "dsh", "grok"].includes(advisor))
const expectedTurns = advisor === "grok" ? 7 : 4
const legacy = process.env.EXTERNAL_TEST_LEGACY === "1"
const home = path.join(root, "configured home")
const audit = path.join(root, "invocations.jsonl")
const gate = path.join(root, "release-initial-turn")
await mkdir(workspace)
await mkdir(bin)
await mkdir(home)
await writeFile(
  path.join(home, ".credentials.yaml"),
  "version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-key\nrecords: {}\n",
)
const cli = path.join(bin, "configured-advisor.mjs")
// Exercise the real consult process/JSONL path without external network calls.
await writeFile(
  cli,
  `#!/usr/bin/env node
import { access, appendFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const advisor = process.env.EXTERNAL_TEST_ADVISOR;
const legacy = process.env.EXTERNAL_TEST_LEGACY === '1';
const emit = value => console.log(JSON.stringify(value));
if (process.argv.includes('--help')) {
  console.log(legacy ? 'Usage: dsh [task]' : 'Options: --json emit events\\n --session-id <id> resume\\n --permission-mode <preset>\\n --approval-policy <policy>\\n --add-dir <path>');
  process.exit(0);
}
const prompt = advisor === 'grok' ? process.argv[process.argv.indexOf('--single')+1] : process.argv.at(-1);
const initial = legacy ? !prompt.includes('Prior consultation transcript:')
  : !process.argv.some(arg => ['resume', '--resume', '--session-id'].includes(arg));
const activePrompt = legacy ? prompt.split('New user message:\\n').at(-1) : prompt;
const homeEnv = advisor === 'codex' ? 'CODEX_HOME' : advisor === 'claude' ? 'CLAUDE_CONFIG_DIR' : advisor === 'grok' ? 'GROK_HOME' : 'DSH_HOME';
assert.equal(process.env[homeEnv], process.env.EXTERNAL_TEST_HOME);
if (advisor === 'grok') assert.equal(process.env.GROK_DISABLE_AUTOUPDATER, '1');
if (advisor === 'dsh') assert.equal(process.env.DEEPSEEK_API_KEY, 'fixture-key');
await appendFile(process.env.EXTERNAL_TEST_AUDIT, JSON.stringify({advisor,initial,args:process.argv.slice(2),home:process.env[homeEnv]})+'\\n');
if (advisor === 'codex') emit({type:'thread.started',thread_id:'thread-handoff-test'});
if (advisor === 'claude') emit({type:'system',subtype:'init',session_id:'session-handoff-test'});
if (advisor === 'dsh' && !legacy) emit({type:'session',sessionId:'session-handoff-test'});
if (initial) {
  const deadline = Date.now() + 20000;
  while (true) {
    try { await access(process.env.EXTERNAL_HANDOFF_GATE); break; } catch {}
    if (Date.now() > deadline) throw new Error('Initial turn gate timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const text = initial ? 'INITIAL_NEWS_RESULT_9281 https://example.test/news'
  : activePrompt.includes('SCIENCE_FOLLOWUP') ? 'SCIENCE_RESULT_7315 https://example.test/science'
  : 'LATEST_SMALLTALK_RESULT_1948';
if (activePrompt.includes('FAIL_INITIAL')) {
  if (advisor === 'codex') emit({type:'error',message:'FIXTURE_INITIAL_FAILURE'});
  else if (advisor === 'claude') emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['FIXTURE_INITIAL_FAILURE']});
  else if (legacy) console.error('dsh: FIXTURE_INITIAL_FAILURE');
  else emit({type:'error',message:'FIXTURE_INITIAL_FAILURE'});
  process.exit(1);
}
if (activePrompt.includes('FAIL_FOLLOWUP')) {
  if (advisor === 'codex') emit({type:'turn.failed',error:{message:'FIXTURE_FOLLOWUP_FAILURE'}});
  else if (advisor === 'claude') emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['FIXTURE_FOLLOWUP_FAILURE']});
  else if (advisor === 'grok') {
    emit({type:'text',data:'PARTIAL_FAILED_REPLY'});
    emit({type:'error',message:'FIXTURE_FOLLOWUP_FAILURE'});
    emit({type:'end',stopReason:'end_turn',sessionId:'session-handoff-test'});
  }
  else if (legacy) console.error('dsh: FIXTURE_FOLLOWUP_FAILURE');
  else { emit({type:'status',phase:'turn_end',reason:{kind:'error',error:{message:'FIXTURE_FOLLOWUP_FAILURE'}}}); emit({type:'final',text:''}); }
  await writeFile(process.env.EXTERNAL_TEST_FAILED, 'finished');
  process.exit(1);
}
if (advisor === 'grok' && ['CANCEL_FOLLOWUP','LIMIT_FOLLOWUP','INCOMPLETE_FOLLOWUP'].some(value=>activePrompt.includes(value))) {
  emit({type:'text',data:'PARTIAL_INTERRUPTED_REPLY'});
  if (!activePrompt.includes('INCOMPLETE_FOLLOWUP')) emit({
    type:'end',stopReason:activePrompt.includes('CANCEL_FOLLOWUP')?'cancelled':'max_turn_requests',sessionId:'session-handoff-test',
  });
  process.exit(0);
}
if (advisor === 'codex') {
  emit({type:'item.completed',item:{id:'reply',type:'agent_message',text}});
  emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}});
} else if (advisor === 'claude') {
  emit({type:'assistant',message:{id:'reply',content:[{type:'text',text}]}});
  emit({type:'result',subtype:'success',is_error:false,result:text,session_id:'session-handoff-test'});
} else if (advisor === 'grok') {
  emit({type:'text',data:text});
  process.stdout.write(JSON.stringify({type:'end',stopReason:'end_turn',sessionId:'session-handoff-test'}));
} else if (legacy) console.log(text);
else {
  emit({type:'status',phase:'turn_end',reason:{kind:'completed'}});
  process.stdout.write(JSON.stringify({type:'final',text}));
}
`,
)
await chmod(cli, 0o755)

let parentSawFullHistory = false
let parentRequestedTranscript = false
let transcriptPageCount = 0
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages?: Array<{ role: string; content: unknown }> }
    const tools = (body.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    const protocolBlock = tools.join("\n").match(/<external_consultation>\n([\s\S]*?)\n<\/external_consultation>/)
    const handoff = protocolBlock ? JSON.parse(protocolBlock[1]!) : undefined
    const pages = handoff ? tools.filter((text) => text.startsWith(`task_id: ${handoff.task_id}\n`)) : []
    const transcript = pages.join("\n")
    transcriptPageCount = Math.max(transcriptPageCount, pages.length)
    if (pages.length) {
      parentSawFullHistory = ["INITIAL_NEWS_RESULT_9281", "SCIENCE_RESULT_7315", "LATEST_SMALLTALK_RESULT_1948"].every(
        (text) => transcript.includes(text),
      )
      log(
        `parent model received task_transcript pages=${pages.length} complete=${parentSawFullHistory} chars=${transcript.length}`,
      )
    }
    const cursor = pages.at(-1)?.match(/^next_cursor:\s*(\S+)/m)?.[1]
    const needsTranscript = handoff?.read_before_summary === true && (!pages.length || !!cursor)
    if (needsTranscript) {
      parentRequestedTranscript = true
      log(`parent model requested task_transcript task=${handoff.task_id}`)
    }
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-handoff",
      object: "chat.completion.chunk",
      created: 0,
      model: "handoff",
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [
        chunk({ role: "assistant" }),
        needsTranscript
          ? chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_handoff_transcript_${pages.length}`,
                  type: "function",
                  function: {
                    name: "task_transcript",
                    arguments: JSON.stringify({
                      ...handoff.read_transcript.arguments,
                      limit: 2,
                      ...(cursor ? { cursor } : {}),
                    }),
                  },
                },
              ],
            })
          : chunk({ content: parentSawFullHistory ? "PARENT_HAS_FULL_HISTORY" : "Handoff fixture" }),
        chunk({}, needsTranscript ? "tool_calls" : "stop"),
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})
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
const runner = `process.parentPort={postMessage:message=>process.send(message),on:(_,listener)=>process.on('message',data=>listener({data}))};await import(process.argv[1]);process.send({type:'booted'});`
const logfile = path.join(root, "sidecar.log")
const output = createWriteStream(logfile)
const child = spawn("node", ["--input-type=module", "--eval", runner, pathToFileURL(bundle).href], {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    EXTERNAL_HANDOFF_GATE: gate,
    EXTERNAL_TEST_ADVISOR: advisor,
    EXTERNAL_TEST_HOME: home,
    EXTERNAL_TEST_AUDIT: audit,
    EXTERNAL_TEST_FAILED: path.join(root, "failed-followup"),
    DEEPSEEK_API_KEY: "",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "handoff/handoff",
      plugin: [],
      mcp: {},
      permission: { "*": "allow" },
      external_agents: {
        [advisor]: {
          enabled: true,
          binaryPath: cli,
          configHome: home,
          ...(advisor === "dsh" && !legacy
            ? {
                defaults: {
                  profile: "review",
                  timeout_ms: 90000,
                  permission_mode: "read-only",
                  approval_policy: "never",
                  additional_writable_roots: [workspace],
                  patch: ["[]"],
                },
              }
            : {}),
        },
      },
      provider: {
        handoff: {
          npm: "@ai-sdk/openai-compatible",
          name: "Handoff fixture",
          options: { apiKey: "test-only", baseURL: `${provider.url}v1` },
          models: { handoff: { name: "Handoff", limit: { context: 200000, output: 2000 } } },
        },
      },
    }),
  },
})
child.stdout!.pipe(output, { end: false })
child.stderr!.pipe(output, { end: false })
const ready = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Startup timed out: ${logfile}`)), 30000)
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
    reject(new Error(`Sidecar exited: ${code}`))
  })
})
const request = async (route: string, body?: unknown): Promise<any> => {
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
  return response.status === 204 ? undefined : response.json()
}
const until = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}; logs=${logfile}`)
}
try {
  await ready
  log(`isolated sidecar ready pid=${child.pid} root=${root}`)
  const parent = await request("/session", { title: "External handoff regression" })
  await request(`/session/${parent.id}/prompt_async`, {
    agent: "build",
    model: { providerID: "handoff", modelID: "handoff" },
    parts: [
      { type: "text", text: "EXTERNAL_HANDOFF_NEWS_REQUEST" },
      { type: "agent", name: advisor },
    ],
  })
  const session = await until(async () => (await request(`/session/${parent.id}/children`))[0], "external child")
  await request(`/session/${session.id}/external-control`, { action: "start" })
  await writeFile(gate, "ready")
  const waitReply = (expected: string) =>
    until(async () => {
      const messages = await request(`/session/${session.id}/message`)
      const received = messages
        .flatMap((message: any) => message.parts)
        .some((part: any) => part.type === "text" && part.text.includes(expected))
      const state = await request(`/session/${session.id}/external-control`, { action: "status" })
      return received && state.waitingForInput ? true : undefined
    }, expected)
  await waitReply("INITIAL_NEWS_RESULT_9281")
  log("received initial news reply")
  await request(`/session/${session.id}/external-control`, {
    action: "message",
    message: "FAIL_FOLLOWUP",
    requestID: "failure",
  })
  await until(async () => {
    const messages = await request(`/session/${session.id}/message`)
    const text = JSON.stringify(messages)
    const state = await request(`/session/${session.id}/external-control`, { action: "status" })
    return text.includes("FIXTURE_FOLLOWUP_FAILURE") && state.waitingForInput ? true : undefined
  }, "failed follow-up is surfaced without completing the consultation")
  log("received failed follow-up diagnostics; testing recovery")
  if (advisor === "grok") {
    for (const [message, reason] of [
      ["CANCEL_FOLLOWUP", "cancelled"],
      ["LIMIT_FOLLOWUP", "max_turn_requests"],
      ["INCOMPLETE_FOLLOWUP", "terminal event"],
    ]) {
      await request("/session/" + session.id + "/external-control", { action: "message", message, requestID: message })
      await until(
        async () => {
          const messages = await request("/session/" + session.id + "/message")
          const state = await request("/session/" + session.id + "/external-control", { action: "status" })
          return JSON.stringify(messages).includes(reason) && state.waitingForInput ? true : undefined
        },
        "Grok does not promote " + reason + " to a successful reply",
      )
      log("received unsuccessful Grok turn reason=" + reason)
    }
  }
  await request(`/session/${session.id}/external-control`, {
    action: "message",
    message: "SCIENCE_FOLLOWUP",
    requestID: "science",
  })
  await waitReply("SCIENCE_RESULT_7315")
  log("received intervened science reply")
  await request(`/session/${session.id}/external-control`, {
    action: "message",
    message: "SMALLTALK_FOLLOWUP",
    requestID: "smalltalk",
  })
  await waitReply("LATEST_SMALLTALK_RESULT_1948")
  log("received intervened small-talk reply")
  await request(`/session/${session.id}/external-control`, { action: "finish" })
  const result = await until(async () => {
    const messages = await request(`/session/${parent.id}/message`)
    return messages
      .flatMap((message: any) => message.parts)
      .find((part: any) => part.tool === advisor + "_consult" && part.state.status === "completed")
  }, "parent tool result")
  const handoff = result.state.metadata.externalHandoff
  assert.equal(handoff.version, 1)
  assert.equal(handoff.task_id, session.id)
  assert.equal(handoff.user_intervened, true)
  assert.equal(handoff.read_before_summary, true)
  assert.equal(handoff.delivery, "reference")
  assert.ok(
    !result.state.output.includes("SCIENCE_RESULT_7315"),
    "Full intermediate answer should be read on demand, not inlined",
  )
  assert.ok(result.state.output.includes("task_transcript"))
  assert.equal(result.state.metadata.interventionTurns, expectedTurns)
  await until(async () => (parentSawFullHistory ? true : undefined), "parent model receiving full history")
  assert.equal(parentRequestedTranscript, true)
  assert.ok(transcriptPageCount >= expectedTurns)
  await until(async () => {
    const messages = await request(`/session/${parent.id}/message`)
    return messages
      .flatMap((message: any) => message.parts)
      .find(
        (part: any) =>
          part.tool === "task_transcript" &&
          part.state.status === "completed" &&
          part.state.input.task_id === session.id,
      )
  }, "persisted parent transcript read")
  await until(async () => {
    const messages = await request(`/session/${parent.id}/message`)
    return messages.some((message: any) => message.parts.some((part: any) => part.text === "PARENT_HAS_FULL_HISTORY"))
      ? true
      : undefined
  }, "parent reply")
  const logs = path.join(root, "data/opencode/log")
  const backend = (
    await Promise.all(
      (await readdir(logs))
        .filter((file) => file.endsWith(".log"))
        .map((file) => readFile(path.join(logs, file), "utf8")),
    )
  ).join("\n")
  assert.ok(
    backend.includes("handoff assembled") && backend.includes("turns=" + expectedTurns),
    "Missing handoff diagnostics",
  )
  const invocations = (await readFile(audit, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(invocations.length, expectedTurns)
  assert.equal(invocations[0].initial, true)
  assert.ok(invocations.slice(1).every((run) => !run.initial && run.home === home))
  if (advisor === "dsh" && !legacy) {
    for (const run of invocations) {
      assert.deepEqual(run.args.slice(0, 2), ["--profile", "review"])
      const mode = run.args.indexOf("--permission-mode")
      assert.deepEqual(run.args.slice(mode, mode + 6), [
        "--permission-mode",
        "read-only",
        "--approval-policy",
        "never",
        "--add-dir",
        workspace,
      ])
      assert.ok(run.args.includes("--patch"))
    }
    assert.ok(invocations.slice(1).every((run) => run.args.includes("--session-id")))
    assert.ok(invocations.slice(1).every((run) => !run.args.at(-1).includes("Prior consultation transcript")))
  }
  assert.ok(!backend.includes("fixture-key"), "Credentials leaked to backend logs")
  const failed = await request("/session", { title: "External failed first turn" })
  await request(`/session/${failed.id}/prompt_async`, {
    agent: "build",
    model: { providerID: "handoff", modelID: "handoff" },
    parts: [
      { type: "text", text: "FAIL_INITIAL" },
      { type: "agent", name: advisor },
    ],
  })
  await until(async () => {
    const messages = await request(`/session/${failed.id}/message`)
    return messages
      .flatMap((message: any) => message.parts)
      .some(
        (part: any) =>
          part.tool === advisor + "_consult" &&
          part.state.status === "error" &&
          part.state.error.includes("FIXTURE_INITIAL_FAILURE"),
      )
      ? true
      : undefined
  }, "initial failure is an error, not a successful raw JSON reply")
  log(
    "PASS configured binary/home, failed initial/follow-up turns, recovery and native/legacy resume advisor=" +
      advisor +
      " legacy=" +
      legacy,
  )
  assert.ok(
    backend.includes("service=tool.task_transcript") && backend.includes("read completed"),
    "Missing transcript read diagnostics",
  )
  log(
    "PASS compact handoff causes real paginated task_transcript calls; the parent then receives all three turns and source links",
  )
  assert.ok(backend.includes("cursor=present") && backend.includes("more=true"), "Missing paginated read diagnostics")
  log(`logs=${root}`)
} finally {
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
