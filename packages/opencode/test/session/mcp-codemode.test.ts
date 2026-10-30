import { expect } from "bun:test"
import { dynamicTool, jsonSchema, type Tool as AITool } from "ai"
import { Effect, Layer, Schema } from "effect"
import { MCP } from "@/mcp"
import { McpCodeMode } from "@/mcp/codemode"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionTools } from "@/session/tools"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Instruction } from "@/session/instruction"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "http://localhost/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Test",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100000, output: 10000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Provider.Model

const fixture = Effect.fn("test.mcpCodeMode.fixture")(function* (
  options: {
    codemode?: boolean
    rules?: Permission.Rule[]
    userTools?: Record<string, boolean>
    deny?: string
    builtins?: Tool.Def[]
    noMcp?: boolean
    before?: (tool: string, args: Record<string, unknown>) => void
    call?: (args: unknown, options: Parameters<NonNullable<AITool["execute"]>>[1]) => Promise<unknown>
  } = {},
) {
  const sessionID = SessionID.make("ses_codemode")
  const messageID = MessageID.make("msg_codemode")
  const started: string[] = []
  const permissions: string[] = []
  const hooks: string[] = []
  const requests: unknown[] = []
  const progress: unknown[] = []
  const completed: unknown[] = []
  let part = {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    tool: "execute",
    callID: "outer",
    state: { status: "running", input: {}, time: { start: Date.now() } },
  } as MessageV2.ToolPart
  const mcpTool: MCP.Tool = {
    ...dynamicTool({
      description: "Echo a numeric value",
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      }),
      execute: async (args, opts) => {
        requests.push(args)
        return options.call
          ? options.call(args, opts)
          : {
              content: [{ type: "text", text: "RAW_INTERMEDIATE_MUST_NOT_LEAK" }],
              structuredContent: { value: (args as { value: number }).value },
            }
      },
    }),
    mcp: { server: "demo-server", name: "echo.value", codemode: options.codemode !== false },
  }
  const layers = Layer.mergeAll(
    Layer.mock(MCP.Service, { tools: () => Effect.succeed(options.noMcp ? {} : { demo_server_echo_value: mcpTool }) }),
    Layer.mock(Plugin.Service, {
      trigger: ((_name: string, _input: unknown, output: unknown) =>
        Effect.sync(() => {
          hooks.push(_name)
          if (_name === "tool.execute.before")
            options.before?.((_input as { tool: string }).tool, (output as { args: Record<string, unknown> }).args)
          return output
        })) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Permission.Service, {
      ask: (input) =>
        Effect.gen(function* () {
          permissions.push(input.permission)
          if (input.permission === options.deny) return yield* new Permission.RejectedError()
        }),
    }),
    Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed(options.builtins ?? []) }),
    Layer.mock(Truncate.Service, { output: (text) => Effect.succeed({ content: text, truncated: false as const }) }),
  )
  const user: MessageV2.WithParts = {
    info: {
      role: "user",
      id: MessageID.make("msg_parent"),
      sessionID,
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
      time: { created: Date.now() },
      tools: options.userTools,
    },
    parts: [],
  }
  const tools = yield* SessionTools.resolve({
    agent: {
      name: "build",
      mode: "primary",
      options: {},
      permission: options.rules ?? [{ permission: "*", pattern: "*", action: "allow" }],
    },
    model,
    session: { id: sessionID, permission: [] } as unknown as Session.Info,
    processor: {
      message: { id: messageID } as MessageV2.Assistant,
      startToolCall: (_id, name) =>
        Effect.sync(() => {
          started.push(name)
          return undefined
        }),
      updateToolCall: (_id, update) =>
        Effect.sync(() => {
          part = update(part)
          progress.push(part.state)
          return part
        }),
      completeToolCall: (_id, output) =>
        Effect.sync(() => {
          completed.push(output)
        }),
      failToolCall: () => Effect.succeed(true),
      captureToolFiles: (action, work) => work.pipe(Effect.map((value) => ({ value, files: [] }))),
    },
    bypassAgentCheck: false,
    messages: [user],
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("unused"),
      loop: () => Effect.die("unused"),
    },
  }).pipe(Effect.provide(layers))
  const execute = (code: string, signal = new AbortController().signal) =>
    Effect.promise(
      () =>
        tools.execute.execute!({ code }, { toolCallId: "outer", messages: [], abortSignal: signal }) as Promise<{
          output: string
          metadata: {
            toolCalls: Array<{ tool: string; status: string }>
            codemode: boolean
            codemodeScope?: string
            loaded?: string[]
          }
          attachments: MessageV2.FilePart[]
        }>,
    )
  return { tools, execute, started, permissions, hooks, requests, progress, completed }
})

const queryParameters = Schema.Struct({ filePath: Schema.String })
const queryTool = (
  execute: Tool.Def<typeof queryParameters>["execute"],
  id = "read",
): Tool.Def<typeof queryParameters> => ({
  id,
  codemode: "readonly",
  description: "Read fixture data",
  parameters: queryParameters,
  execute,
})

it.instance("Code Mode composes read-only queries with MCP and retains direct query tools", () =>
  Effect.gen(function* () {
    const read = queryTool((args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "read", patterns: [args.filePath], always: ["*"], metadata: {} })
        yield* ctx.metadata({ title: "Nested read", metadata: { secret: "DO_NOT_PERSIST_RAW_METADATA" } })
        return {
          title: "fixture",
          output: "RAW_READ_SHOULD_NOT_LEAK",
          data: { value: 7 },
          metadata: { truncated: false },
        }
      }),
    )
    const test = yield* fixture({ builtins: [read] })
    expect(Object.keys(test.tools)).toEqual(["read", "execute"])
    const result = yield* test.execute(
      'const row = await tools.builtin.read({filePath:"src/a.ts"}); const remote = await tools["demo-server"].echo_value({value:row.data.value}); return remote.structuredContent.value',
    )
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, value: 7 })
    expect(result.metadata.codemodeScope).toBe("query")
    expect(test.permissions).toEqual(["execute", "read", "demo_server_echo_value"])
    expect(result.output).not.toContain("RAW_READ")
    expect(JSON.stringify(test.progress)).not.toContain("DO_NOT_PERSIST_RAW_METADATA")
    expect(test.started).toEqual(["execute"])
    expect(test.completed).toHaveLength(1)
  }),
)

it.instance("Code Mode works without MCP and omits disabled and unmarked custom tools", () =>
  Effect.gen(function* () {
    const read = queryTool(() => Effect.succeed({ title: "read", output: "ok", metadata: {} }))
    const test = yield* fixture({ noMcp: true, builtins: [read] })
    expect(
      JSON.parse((yield* test.execute('return (await tools.builtin.read({filePath:"a"})).output')).output),
    ).toMatchObject({ ok: true, value: "ok" })
    for (const options of [
      { userTools: { read: false } },
      { userTools: { execute: false } },
      { rules: [{ permission: "read", pattern: "*", action: "deny" as const }] },
      { rules: [{ permission: "execute", pattern: "*", action: "deny" as const }] },
    ]) {
      const hidden = yield* fixture({ noMcp: true, builtins: [read], ...options })
      expect(Object.keys(hidden.tools)).toEqual(["read"])
    }
    const custom = yield* fixture({ noMcp: true, builtins: [{ ...read, codemode: undefined }] })
    expect(Object.keys(custom.tools)).toEqual(["read"])
    const execute = yield* fixture({ builtins: [{ ...read, id: "execute", codemode: undefined }] })
    expect(Object.keys(execute.tools)).toEqual(["execute", "demo_server_echo_value"])
  }),
)

it.instance("Code Mode rejects invalid and plugin-mutated query arguments before execution", () =>
  Effect.gen(function* () {
    let calls = 0
    const read = queryTool(() =>
      Effect.sync(() => {
        calls++
        return { title: "", output: "", metadata: {} }
      }),
    )
    const invalid = yield* fixture({ noMcp: true, builtins: [read] })
    expect(JSON.parse((yield* invalid.execute("return await tools.builtin.read({filePath:123})")).output).ok).toBe(
      false,
    )
    const mutated = yield* fixture({
      noMcp: true,
      builtins: [read],
      before: (tool, args) => {
        if (tool === "read") args.filePath = 123
      },
    })
    expect(JSON.parse((yield* mutated.execute('return await tools.builtin.read({filePath:"a"})')).output).ok).toBe(
      false,
    )
    expect(calls).toBe(0)
  }),
)

it.instance("Code Mode preserves nested permission rejection and scopes non-asking query permissions", () =>
  Effect.gen(function* () {
    let calls = 0
    const read = queryTool((args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "read", patterns: [args.filePath], always: ["*"], metadata: {} })
        calls++
        return { title: "", output: "", metadata: {} }
      }),
    )
    const test = yield* fixture({ noMcp: true, builtins: [read], deny: "read" })
    expect(
      JSON.parse((yield* test.execute('return await tools.builtin.read({filePath:"secret.env"})')).output).ok,
    ).toBe(false)
    const tasks = yield* fixture({
      noMcp: true,
      builtins: [
        queryTool(
          () =>
            Effect.sync(() => {
              calls++
              return { title: "", output: "", metadata: {} }
            }),
          "task_list",
        ),
      ],
      deny: "task_list",
    })
    expect(JSON.parse((yield* tasks.execute('return await tools.builtin.task_list({filePath:"a"})')).output).ok).toBe(
      false,
    )
    expect(calls).toBe(0)
  }),
)

it.instance("Code Mode forwards loaded instructions and attachments even when read results are filtered", () =>
  Effect.gen(function* () {
    const read = queryTool(() =>
      Effect.succeed({
        title: "fixture",
        output: "RAW_FILE_CONTENT",
        metadata: {},
        instructions: [{ filepath: "/project/src/AGENTS.md", content: "MANDATORY_PROJECT_INSTRUCTION" }],
        attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" }],
      }),
    )
    const test = yield* fixture({ noMcp: true, builtins: [read] })
    const result = yield* test.execute('await tools.builtin.read({filePath:"a"}); return "selected"')
    expect(result.output).toContain("MANDATORY_PROJECT_INSTRUCTION")
    expect(result.output).not.toContain("RAW_FILE_CONTENT")
    expect(result.metadata.loaded).toEqual(["/project/src/AGENTS.md"])
    expect(result.attachments).toHaveLength(1)
    expect(
      Instruction.loaded([
        {
          info: {} as MessageV2.Assistant,
          parts: [
            {
              type: "tool",
              tool: "execute",
              state: { status: "completed", metadata: result.metadata, time: {} },
            } as MessageV2.ToolPart,
          ],
        },
      ]),
    ).toEqual(new Set(["/project/src/AGENTS.md"]))
  }),
)

it.instance("Code Mode cancellation interrupts read-only query effects and their abort signals", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const read = queryTool((_args, ctx) =>
      Effect.gen(function* () {
        signal = ctx.abort
        controller.abort()
        return yield* Effect.never
      }),
    )
    const test = yield* fixture({ noMcp: true, builtins: [read] })
    const exit = yield* test
      .execute('return await tools.builtin.read({filePath:"a"})', controller.signal)
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(signal?.aborted).toBe(true)
    expect(test.completed).toHaveLength(0)
  }),
)

it.live("Code Mode separates builtin and MCP namespaces even when a server is named builtin", () =>
  Effect.gen(function* () {
    const runtime = McpCodeMode.make([
      {
        key: "read",
        name: "read",
        source: "builtin",
        server: "builtin",
        description: "local",
        schema: { type: "object" },
      },
      { key: "builtin_read", name: "read", server: "builtin", description: "remote", schema: { type: "object" } },
    ])
    expect(
      yield* runtime.execute("return await Promise.all([tools.builtin_.read({}), tools.builtin.read({})])", (entry) =>
        Effect.succeed(entry.source ?? "mcp"),
      ),
    ).toMatchObject({ ok: true, value: ["builtin", "mcp"] })
  }),
)

it.instance("MCP Code Mode composes calls and keeps intermediate results out of model output", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    expect(Object.keys(test.tools)).toEqual(["execute"])
    const result = yield* test.execute(
      'const rows = await Promise.all([1,2,3].map(value => tools["demo-server"].echo_value({value}))); return rows.map(row => row.structuredContent.value)',
    )
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, value: [1, 2, 3] })
    expect(result.output).not.toContain("RAW_INTERMEDIATE_MUST_NOT_LEAK")
    expect(result.metadata.toolCalls.map((call) => call.status)).toEqual(["completed", "completed", "completed"])
    expect(test.permissions).toEqual([
      "execute",
      "demo_server_echo_value",
      "demo_server_echo_value",
      "demo_server_echo_value",
    ])
    expect(test.started).toEqual(["execute"])
    expect(test.completed).toHaveLength(1)
    expect(test.progress.length).toBeGreaterThan(3)
    expect(test.hooks.filter((hook) => hook === "tool.execute.before")).toHaveLength(4)
  }),
)

it.instance("MCP Code Mode preserves explicit direct exposure and execute-denied fallback", () =>
  Effect.gen(function* () {
    const direct = yield* fixture({ codemode: false })
    expect(Object.keys(direct.tools)).toEqual(["demo_server_echo_value"])
    const denied = yield* fixture({
      rules: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "execute", pattern: "*", action: "deny" },
      ],
    })
    expect(Object.keys(denied.tools)).toEqual(["demo_server_echo_value"])
    const disabled = yield* fixture({ userTools: { execute: false } })
    expect(Object.keys(disabled.tools)).toEqual(["demo_server_echo_value"])
  }),
)

it.instance("MCP Code Mode hides tools denied by agent or per-prompt overrides", () =>
  Effect.gen(function* () {
    const denied = yield* fixture({ rules: [{ permission: "demo_server_echo_value", pattern: "*", action: "deny" }] })
    expect(Object.keys(denied.tools)).toEqual([])
    const disabled = yield* fixture({ userTools: { demo_server_echo_value: false } })
    expect(Object.keys(disabled.tools)).toEqual([])
  }),
)

it.instance("MCP Code Mode cannot bypass an interactive permission rejection", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ deny: "demo_server_echo_value" })
    const result = yield* test.execute('return await tools["demo-server"].echo_value({value: 1})')
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: { kind: "ToolFailure" } })
    expect(test.requests).toHaveLength(0)
    expect(result.metadata.toolCalls[0]?.status).toBe("error")
  }),
)

it.instance("MCP Code Mode validates inputs before contacting the server", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const result = yield* test.execute('return await tools["demo-server"].echo_value({value: "not a number"})')
    expect(JSON.parse(result.output).ok).toBe(false)
    expect(test.requests).toHaveLength(0)
  }),
)

it.instance("MCP Code Mode reports remote isError results instead of pretending they succeeded", () =>
  Effect.gen(function* () {
    const test = yield* fixture({
      call: async () => ({ content: [{ type: "text", text: "remote failed" }], isError: true }),
    })
    const result = yield* test.execute('return await tools["demo-server"].echo_value({value: 1})')
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("remote failed") },
    })
  }),
)

it.instance("MCP Code Mode preserves media attachments independently of the returned fields", () =>
  Effect.gen(function* () {
    const test = yield* fixture({
      call: async () => ({ content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }),
    })
    const result = yield* test.execute('await tools["demo-server"].echo_value({value: 1}); return "image received"')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].url).toBe("data:image/png;base64,aW1hZ2U=")
  }),
)

it.instance("MCP Code Mode cannot access host globals, imports, fetch, or unregistered builtins", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    for (const code of [
      "return process.env",
      'return require("fs")',
      'return await import("fs")',
      'return await fetch("https://example.invalid")',
      'return await tools.bash({command:"true"})',
    ]) {
      expect(JSON.parse((yield* test.execute(code)).output).ok).toBe(false)
    }
    expect(test.requests).toHaveLength(0)
  }),
)

it.instance("MCP Code Mode propagates caller cancellation to the remote request", () =>
  Effect.gen(function* () {
    const controller = new AbortController()
    let aborted = false
    const test = yield* fixture({
      call: (_args, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal!.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new Error("cancelled"))
            },
            { once: true },
          )
          queueMicrotask(() => controller.abort())
        }),
    })
    const exit = yield* test
      .execute('return await tools["demo-server"].echo_value({value: 1})', controller.signal)
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(aborted).toBe(true)
    expect(test.completed).toHaveLength(0)
  }),
)

it.live("MCP Code Mode interrupts unawaited work when the program returns", () =>
  Effect.gen(function* () {
    let interrupted = false
    const runtime = McpCodeMode.make([
      { key: "s_f", server: "s", name: "f", description: "fixture", schema: { type: "object", properties: {} } },
    ])
    const result = yield* runtime.execute('tools.s.f(); return "done"', () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )
    expect(result).toMatchObject({ ok: true, value: "done" })
    expect(interrupted).toBe(true)
  }),
)

it.live("MCP Code Mode bounds CPU loops, tool counts, and output", () =>
  Effect.gen(function* () {
    const runtime = McpCodeMode.make(
      [{ key: "s_f", server: "s", name: "f", description: "fixture", schema: { type: "object", properties: {} } }],
      { timeoutMs: 30, maxToolCalls: 2, maxOutputBytes: 32 },
    )
    const call = () => Effect.succeed({})
    expect(yield* runtime.execute("while(true) {}", call)).toMatchObject({
      ok: false,
      error: { kind: "TimeoutExceeded" },
    })
    expect(yield* runtime.execute("await tools.s.f(); await tools.s.f(); await tools.s.f()", call)).toMatchObject({
      ok: false,
      error: { kind: "ToolCallLimitExceeded" },
    })
    expect(yield* runtime.execute('return "x".repeat(1000)', call)).toMatchObject({ ok: true, truncated: true })
  }),
)
