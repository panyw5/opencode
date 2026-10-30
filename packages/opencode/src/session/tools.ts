import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { SessionCodeMode } from "./code-mode"
import { CodeModeQuery } from "./code-mode-query"
import type { CodeModeCatalog } from "./code-mode-catalog"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaValidator, JsonSchemaType } from "@modelcontextprotocol/sdk/validation"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { toolError } from "@opencode/codemode"
import { Cause, Semaphore } from "effect"

const log = Log.create({ service: "session.tools" })
const catalogs = new WeakMap<Record<string, AITool>, CodeModeCatalog.Summary>()

export const codeModeCatalog = (tools: Record<string, AITool>) => catalogs.get(tools)

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<
    SessionProcessor.Handle,
    "message" | "startToolCall" | "updateToolCall" | "completeToolCall" | "failToolCall" | "captureToolFiles"
  >
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
  const latestUser = input.messages.findLast((message) => message.info.role === "user")?.info
  const userTools = latestUser?.role === "user" ? latestUser.tools : undefined
  const registrations = yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })
  const localTools = [...new Map(registrations.map((item) => [item.id, item])).values()]
  const codeModeEnabled =
    !localTools.some((item) => item.id === "execute") &&
    userTools?.execute !== false &&
    !Permission.disabled(["execute"], ruleset).has("execute")
  const codeModeEntries: SessionCodeMode.Entry[] = []
  const codeModeCalls = new Map<
    string,
    { validate: JsonSchemaValidator<Record<string, unknown>> } & (
      | { kind: "mcp"; execute: NonNullable<MCP.Tool["execute"]> }
      | { kind: "builtin"; tool: Tool.Def }
    )
  >()

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        const now = Date.now()
        const start = match.state.status === "running" ? match.state.time.start : now
        log.debug("tool metadata updated", {
          toolCallID: options.toolCallId,
          status: match.state.status,
          start,
          elapsedMs: now - start,
        })
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of localTools) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* input.processor.startToolCall(options.toolCallId, item.id, args)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const executed = yield* input.processor.captureToolFiles(item.id, item.execute(args, ctx))
            const result = executed.value
            const changedFiles = executed.files
            const output = {
              ...result,
              metadata: {
                ...result.metadata,
                ...(changedFiles.length
                  ? {
                      files: [...(Array.isArray(result.metadata?.files) ? result.metadata.files : []), ...changedFiles],
                    }
                  : {}),
              },
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            // Do not rely solely on AI SDK fullStream replaying a tool-result before finish.
            yield* input.processor.completeToolCall(options.toolCallId, output)
            return output
          }).pipe(
            Effect.tapError((error) => input.processor.failToolCall(options.toolCallId, error).pipe(Effect.ignore)),
          ),
        )
      },
    })
    if (
      codeModeEnabled &&
      item.codemode === "readonly" &&
      userTools?.[item.id] !== false &&
      !Permission.disabled([item.id], ruleset).has(item.id)
    ) {
      const schema = ToolJsonSchema.fromTool(item)
      const validated = yield* Effect.try({
        try: () => new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema as JsonSchemaType),
        catch: (error) => error,
      }).pipe(Effect.result)
      if (validated._tag === "Success") {
        codeModeEntries.push({
          key: item.id,
          server: "builtin",
          name: item.id,
          source: "builtin",
          description: item.description,
          schema: schema as SessionCodeMode.Entry["schema"],
          output: CodeModeQuery.outputSchema(item.id),
        })
        codeModeCalls.set(`builtin:${item.id}`, { kind: "builtin", tool: item, validate: validated.success })
        log.info("Code Mode read-only tool registered", { tool: item.id })
      } else log.warn("Code Mode query schema unavailable, keeping direct tool", { tool: item.id })
    }
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    if (codeModeEnabled && !tools.execute && item.mcp?.codemode) {
      if (userTools?.[key] === false || Permission.disabled([key], ruleset).has(key)) {
        log.info("MCP Code Mode tool hidden by permission", { tool: key })
        continue
      }
      const validated = yield* Effect.try({
        try: () => new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema as JsonSchemaType),
        catch: (error) => error,
      }).pipe(Effect.result)
      if (validated._tag === "Success") {
        codeModeEntries.push({
          key,
          server: item.mcp.server,
          name: item.mcp.name,
          description: item.description ?? "",
          schema: schema as SessionCodeMode.Entry["schema"],
        })
        codeModeCalls.set(`mcp:${key}`, { kind: "mcp", execute, validate: validated.success })
        continue
      }
      log.warn("MCP Code Mode schema unavailable, using direct tool", { tool: key })
    }
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* input.processor.startToolCall(opts.toolCallId, key, args)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          // Do not rely solely on AI SDK fullStream replaying a tool-result before finish.
          yield* input.processor.completeToolCall(opts.toolCallId, output)
          return output
        }).pipe(Effect.tapError((error) => input.processor.failToolCall(opts.toolCallId, error).pipe(Effect.ignore))),
      )
    tools[key] = item
  }

  if (codeModeEntries.length > 0) {
    if (tools.execute) throw new Error("Code Mode execute name collision")
    const runtime = SessionCodeMode.make(codeModeEntries)
    catalogs.set(tools, runtime.summary)
    const scope = codeModeEntries.some((entry) => entry.source === "builtin") ? "query" : "mcp"
    const title = scope === "mcp" ? "MCP Code Mode" : "Code Mode"
    log.info("Code Mode catalog ready", { tools: codeModeEntries.length, direct: Object.keys(tools).length, scope })
    tools.execute = tool({
      description: runtime.description,
      inputSchema: jsonSchema<{ code: string }>({
        type: "object",
        properties: { code: { type: "string", maxLength: SessionCodeMode.MAX_CODE_LENGTH } },
        required: ["code"],
        additionalProperties: false,
      }),
      execute(args, options) {
        return run.promise(
          SessionCodeMode.withAbort(
            Effect.gen(function* () {
              const ctx = context(args, options)
              yield* input.processor.startToolCall(options.toolCallId, "execute", args)
              if (typeof args.code !== "string" || args.code.length > SessionCodeMode.MAX_CODE_LENGTH) {
                return yield* new Tool.InvalidArgumentsError({
                  tool: "execute",
                  detail: `code must be a string of at most ${SessionCodeMode.MAX_CODE_LENGTH} characters`,
                })
              }
              yield* ctx.ask({ permission: "execute", metadata: {}, patterns: ["*"], always: ["*"] })
              yield* plugin.trigger(
                "tool.execute.before",
                { tool: "execute", sessionID: ctx.sessionID, callID: ctx.callID },
                { args },
              )
              const calls: Array<{
                tool: string
                status: "running" | "completed" | "error"
                input: string
                error?: string
              }> = []
              const progress = Semaphore.makeUnsafe(1)
              const publish = () =>
                progress.withPermits(1)(
                  ctx.metadata({
                    title: `${title} (${calls.length} calls)`,
                    metadata: { codemode: true, codemodeScope: scope, toolCalls: calls.map((call) => ({ ...call })) },
                  }),
                )
              const attachments: MessageV2.FilePart[] = []
              const instructions = new Map<string, string>()
              log.info("Code Mode execution started", {
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                tools: codeModeEntries.length,
              })
              const result = yield* runtime.execute(args.code, (entry, value) =>
                Effect.gen(function* () {
                  const registered = codeModeCalls.get(
                    `${entry.source === "builtin" ? "builtin" : "mcp"}:${entry.key}`,
                  )!
                  const validation = registered.validate(value)
                  if (!validation.valid)
                    return yield* Effect.fail(
                      toolError(`Invalid arguments for ${entry.key}: ${validation.errorMessage}`),
                    )
                  const nested = validation.data
                  const call: (typeof calls)[number] = {
                    tool: entry.key,
                    status: "running" as "running" | "completed" | "error",
                    input: JSON.stringify(nested).slice(0, 2048),
                  }
                  calls.push(call)
                  yield* publish()
                  log.info("Code Mode subcall started", {
                    callID: ctx.callID,
                    tool: entry.key,
                    index: calls.length - 1,
                  })
                  return yield* Effect.gen(function* () {
                    yield* plugin.trigger(
                      "tool.execute.before",
                      { tool: entry.key, sessionID: ctx.sessionID, callID: ctx.callID },
                      { args: nested },
                    )
                    const checked = registered.validate(nested)
                    if (!checked.valid)
                      return yield* Effect.fail(
                        toolError(`Invalid arguments for ${entry.key}: ${checked.errorMessage}`),
                      )
                    call.input = JSON.stringify(nested).slice(0, 2048)
                    if (registered.kind === "builtin") {
                      // These query tools do not ask internally; preserve catalog permissions here too.
                      if (["task_list", "task_transcript", "session_transcript"].includes(entry.key)) {
                        yield* ctx.ask({
                          permission: entry.key,
                          patterns: [String(nested.task_id ?? nested.session_id ?? "*")],
                          always: ["*"],
                          metadata: { codemode: true, input: call.input },
                        })
                      }
                      const response = yield* Effect.acquireUseRelease(
                        Effect.sync(() => new AbortController()),
                        (controller) =>
                          registered.tool.execute(nested, {
                            ...ctx,
                            abort: options.abortSignal
                              ? AbortSignal.any([controller.signal, options.abortSignal])
                              : controller.signal,
                            // A subcall must never overwrite the execute part's input or audit metadata.
                            metadata: () => publish(),
                          }),
                        (controller) => Effect.sync(() => controller.abort()),
                      )
                      yield* plugin.trigger(
                        "tool.execute.after",
                        { tool: entry.key, sessionID: ctx.sessionID, callID: ctx.callID, args: nested },
                        response,
                      )
                      for (const instruction of response.instructions ?? [])
                        instructions.set(instruction.filepath, instruction.content)
                      for (const attachment of response.attachments ?? [])
                        attachments.push({
                          ...attachment,
                          id: PartID.ascending(),
                          sessionID: ctx.sessionID,
                          messageID: input.processor.message.id,
                        })
                      return CodeModeQuery.result(response)
                    }
                    yield* ctx.ask({
                      permission: entry.key,
                      metadata: { codemode: true, input: call.input },
                      patterns: ["*"],
                      always: ["*"],
                    })
                    const raw = yield* Effect.tryPromise({
                      try: (signal) =>
                        registered.execute(nested, {
                          ...options,
                          abortSignal: options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal,
                        }),
                      catch: (error) => toolError(`MCP tool ${entry.key} failed`, error),
                    })
                    const response = yield* Effect.try({
                      try: () => CallToolResultSchema.parse(raw),
                      catch: (error) => toolError(`Invalid MCP result from ${entry.key}`, error),
                    })
                    yield* plugin.trigger(
                      "tool.execute.after",
                      { tool: entry.key, sessionID: ctx.sessionID, callID: ctx.callID, args: nested },
                      response,
                    )
                    if (response.isError)
                      return yield* Effect.fail(
                        toolError(
                          `MCP tool ${entry.key} returned an error: ${response.content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("\n")
                            .slice(0, 2048)}`,
                        ),
                      )
                    for (const part of response.content) {
                      if (part.type === "image")
                        attachments.push({
                          id: PartID.ascending(),
                          sessionID: ctx.sessionID,
                          messageID: input.processor.message.id,
                          type: "file",
                          mime: part.mimeType,
                          url: `data:${part.mimeType};base64,${part.data}`,
                        })
                      if (part.type === "resource" && "blob" in part.resource && part.resource.blob)
                        attachments.push({
                          id: PartID.ascending(),
                          sessionID: ctx.sessionID,
                          messageID: input.processor.message.id,
                          type: "file",
                          mime: part.resource.mimeType ?? "application/octet-stream",
                          url: `data:${part.resource.mimeType ?? "application/octet-stream"};base64,${part.resource.blob}`,
                          filename: part.resource.uri,
                        })
                    }
                    return response
                  }).pipe(
                    Effect.onExit((exit) =>
                      Effect.gen(function* () {
                        call.status = exit._tag === "Success" ? "completed" : "error"
                        if (exit._tag === "Failure") {
                          const error = Cause.squash(exit.cause)
                          call.error = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
                        }
                        log.info("Code Mode subcall settled", {
                          callID: ctx.callID,
                          tool: entry.key,
                          status: call.status,
                        })
                        yield* publish()
                      }),
                    ),
                  )
                }),
              )
              const truncated = yield* truncate.output(JSON.stringify(result), {}, input.agent)
              const output = {
                title,
                output:
                  truncated.content +
                  (instructions.size
                    ? `\n\n<system-reminder>\n${[...instructions.values()].join("\n\n")}\n</system-reminder>`
                    : ""),
                metadata: {
                  codemode: true,
                  codemodeScope: scope,
                  loaded: [...instructions.keys()],
                  toolCalls: calls,
                  error: !result.ok,
                  truncated: truncated.truncated,
                  ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
                },
                attachments,
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: "execute", sessionID: ctx.sessionID, callID: ctx.callID, args },
                output,
              )
              yield* input.processor.completeToolCall(options.toolCallId, output)
              log.info("Code Mode execution completed", { callID: ctx.callID, ok: result.ok, calls: calls.length })
              return output
            }).pipe(
              Effect.onError((cause) => input.processor.failToolCall(options.toolCallId, cause).pipe(Effect.ignore)),
            ),
            options.abortSignal,
          ),
        )
      },
    })
  }

  return tools
})

export * as SessionTools from "./tools"
