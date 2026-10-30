import { CodeMode, Tool as CodeTool } from "@opencode/codemode"
import { Context, Effect, Schema } from "effect"
import { CodeModeCatalog } from "./code-mode-catalog"

export const MAX_CODE_LENGTH = 20_000
export const DEFAULT_LIMITS = { timeoutMs: 120_000, maxToolCalls: 64, maxOutputBytes: 50 * 1024 }

export type Entry = {
  key: string
  server: string
  name: string
  description: string
  schema: CodeTool.JsonSchema
  source?: "builtin"
  output?: CodeTool.JsonSchema
  pinned?: boolean
}

class Run extends Context.Service<
  Run,
  {
    call: (entry: Entry, args: unknown) => Effect.Effect<unknown, unknown>
  }
>()("@opencode/SessionCodeModeRun") {}

const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

export function make(entries: Entry[], limits: CodeMode.ExecutionLimits = DEFAULT_LIMITS) {
  const tools: Record<string, Record<string, CodeTool.Tool<Run>>> = Object.create(null)
  const namespaces = new Set(
    entries.filter((entry) => entry.source !== "builtin").map((entry) => sanitize(entry.server)),
  )
  let builtinNamespace = "builtin"
  while (namespaces.has(builtinNamespace)) builtinNamespace += "_"
  const namespace = (entry: Entry) => (entry.source === "builtin" ? builtinNamespace : sanitize(entry.server))
  for (const entry of entries) {
    const server = namespace(entry)
    const group = (tools[server] ??= Object.create(null))
    group[sanitize(entry.name)] = CodeTool.make({
      description: entry.description,
      input: entry.schema,
      output: entry.output ?? Schema.Unknown,
      execute: (args) =>
        Effect.gen(function* () {
          return yield* (yield* Run).call(entry, args)
        }),
    })
  }
  const runtime = CodeMode.make({ tools, limits })
  const pinned = new Set(
    entries.filter((entry) => entry.pinned).map((entry) => `${namespace(entry)}.${sanitize(entry.name)}`),
  )
  const summary = CodeModeCatalog.summarize({
    tools: [...Map.groupBy(runtime.catalog, (item) => item.path.split(".")[0])].map(([name, items]) => ({
      type: "namespace",
      name,
      tools: items.map((item) => ({
        type: "tool",
        name: item.path.slice(name.length + 1),
        signature: item.signature,
        description: item.description,
        pinned: pinned.has(item.path),
      })),
    })),
  })
  const description = [
    "Run JavaScript in a confined Code Mode interpreter to compose catalogued MCP and read-only query tools and process their results.",
    "Only tools explicitly listed in the Code Mode catalog instructions or returned by search are callable here. Shell, writes, browser actions, imports, direct filesystem access, fetch and timers are NOT available. Tools shown outside that catalog may only be called directly, not inside execute.",
    'Use search({ namespace: "server" }) or search({ query: "term" }) to discover exact paths and full typed signatures. search is synchronous and supports limit/offset pagination. Never invent or normalize tool names; preserve bracket notation from the catalog. Prefer an explicit return; otherwise the last top-level expression is the result.',
    "Await every operation that must finish. Independent calls may use Promise.all or Promise.allSettled; unawaited work is interrupted when the program ends.",
    "MCP calls return their full result (content, structuredContent, isError). Return only the fields needed by the conversation instead of dumping all intermediate responses. Each call still enforces its own permissions.",
    "Read-only built-ins, when present, return { output, metadata, data? }. Use their exact paths from the Code Mode catalog instructions. Prefer data for filtering and joining; output is the human-readable fallback. Their direct tools remain available. read may also load project instructions, which are forwarded to the conversation even when the script filters its result. Browser snapshots are observations, not permission to invent element IDs or run blind actions.",
    `Limits: ${MAX_CODE_LENGTH} source characters, ${limits.maxToolCalls ?? "unlimited"} tool calls, ${limits.timeoutMs ?? "unlimited"} ms, ${limits.maxOutputBytes ?? "unlimited"} output bytes. Execution is NOT transactional; already completed side effects are not rolled back on failure or cancellation.`,
  ].join("\n\n")

  return {
    description,
    catalog: runtime.catalog,
    summary,
    execute: (code: string, call: Context.Service.Shape<typeof Run>["call"]) =>
      runtime.execute(code).pipe(Effect.provideService(Run, { call })),
  }
}

export function withAbort<A, E, R>(operation: Effect.Effect<A, E, R>, signal?: AbortSignal) {
  if (!signal) return operation
  return operation.pipe(
    Effect.raceFirst(
      Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        return Effect.sync(() => signal.removeEventListener("abort", abort))
      }),
    ),
  )
}

export * as SessionCodeMode from "./code-mode"
