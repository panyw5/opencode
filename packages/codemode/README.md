# @opencode/codemode

This fork vendors the interpreter from anomalyco/opencode at `4ba064f653` (2.2.0),
adapted to the repository's Effect 4 beta and Bun 1.3 runtime. The host integration
exposes MCP tools and an explicit read-only built-in query allowlist. The interpreter
has no direct filesystem or network access; each host tool retains its permissions.

## Host Integration In This Fork

Connected MCP servers use Code Mode by default. The model receives one `execute`
tool and can discover MCP signatures with `search`, compose calls, and return only
the fields needed by the conversation. Direct built-in calls remain available.
Each nested MCP call still validates its arguments and
enforces the original tool's permissions and plugin hooks.

The MCP editor has a per-server **Code Mode** switch. To keep a server's tools
directly exposed instead, set `codemode: false` on its existing `mcp` entry in
`opencode.json`. This works for both local and remote servers. If `execute` is
disabled or a custom tool already uses that name, MCP tools fall back to direct
exposure rather than replacing the custom tool.

### Catalog Instructions And Durable Snapshots

`execute.description` contains invariant runtime rules only. The dynamic catalog
is supplied as a separate system instruction baseline, using the upstream
`4ba064f653` catalog-selection and semantic-delta algorithms. It retains every
top-level namespace, shares a soft 2,000 estimated-token budget round-robin across
namespaces, keeps pinned listings, and clips inline descriptions to their first
120 characters. Omitted tools and full descriptions remain discoverable with
synchronous `search` inside `execute`.

The host stores canonical catalog hashes, summaries, and rendered instruction
text in `code_mode_instruction`, anchored to the assistant message for that model
request. Unchanged catalogs do not append records. Changed catalogs generate
chronological instruction notifications (add/change/remove, or full replacement
when safer or shorter) without rewriting the epoch's system baseline. Historical
notifications are reconstructed for model requests rather than inserted as
ordinary chat turns. Direct built-in tools remain callable through their own
schemas, independently of the Code Mode tool paths.

This persistence is adapted to this fork's message schema, not a replacement of
the entire upstream instruction framework. Forks copy and remap snapshot anchors;
committed revert cleanup and session deletion cascade through foreign keys. A
successful compaction establishes a fresh baseline from the current catalog and
ignores pre-summary snapshots, including retained tail messages. Existing sessions
without snapshots initialize on their next Code Mode-capable request. The additive
database migration is applied on backend startup.

Read-only built-ins also appear in the Code Mode catalog when enabled for the
current model/agent: `glob`, `grep`, `read`, `lsp`, `websearch`, `webfetch`,
`task_list`, `task_transcript`, `session_transcript`, `browser_read`, and
`browser_console`. Their usual path is `tools.builtin.<name>`; `search` reports
the exact path if an MCP server already occupies that namespace. Disabled tools,
unmarked custom overrides, and tools hidden by existing feature flags are not
added. Disabling or overriding `execute` leaves their direct calls intact.

Built-in results expose `{ output, metadata, data? }`. Structured `data` includes
file paths from glob, bounded matches from grep, numbered lines from read, LSP
results, transcript pages, and browser snapshot/console entries. `webfetch`
provides parsed data for valid JSON responses; other content and web searches
remain available in `output`. Calls retain normal path/URL permissions, transcript
access boundaries, pagination, and truncation markers. Reading a file also
forwards any newly loaded project instructions to the conversation even if the
script discards the file result; these instructions are tracked for deduplication.

No shell, write/edit, browser action, subagent launch, or unrestricted `fetch`
is added to this catalog. Browser actions still require direct tools and fresh
observations. Built-in direct tool exposure is intentionally retained as a fallback.

Execution is limited to 120 seconds, 64 tool calls, and 50 KiB of textual results
(newly loaded project instructions are forwarded separately).
Stopping a session interrupts pending requests, but already completed remote side
effects cannot be rolled back. The UI retains the script and bounded per-call
audit details; raw textual intermediate results stay out of model context unless
the script returns them. Image/blob attachments are preserved separately.

This is our take on code mode: a lightweight, pure interpreter for a JavaScript-like language built around calling
tools. It supports familiar JavaScript syntax with a few key differences and limitations. See the
[interpreter support checklist](./interpreter-support.md) for more details.

Rather than trying to sandbox arbitrary JavaScript, CodeMode only runs the language features we implement. Programs
cannot directly access the network, filesystem, processes, or application APIs. They can interact with the outside
world only through tools provided by the host, which can also limit execution time, tool calls, output size, and data.

The idea of code mode was originally introduced by Cloudflare. See
[their post](https://blog.cloudflare.com/code-mode/) to learn more about the concept and their isolate-based approach.

## How it differs from JavaScript

- **Only supported APIs are available.** Programs can use the provided tools, supported JavaScript built-ins, and the
  globals the host adds through extensions. Timers, `process`, filesystem access, imports, and modules are unavailable.
- **Unfinished work is interrupted.** Tool calls and async functions start when called. When the program finishes,
  anything still running is interrupted. Unhandled rejections from un-awaited promises are returned as warnings.
- **REPL-style results.** Without an explicit `return`, the final top-level expression becomes the result. `undefined`
  becomes `null`.

Unsupported syntax returns an `UnsupportedSyntax` diagnostic with a source location. Current gaps are tracked in the
[interpreter support checklist](./interpreter-support.md).

## Quick Start

```ts
import { CodeMode, Namespace, Tool } from "@opencode/codemode"
import { Effect, Schema } from "effect"

const lookupOrder = Tool.make({
  description: "Look up an order by ID",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  execute: ({ id }) => Effect.succeed({ id, status: "open" }),
})

const runtime = CodeMode.make({
  tools: { orders: { lookup: lookupOrder } },
})

const result = await Effect.runPromise(
  runtime.execute(`
    const order = await tools.orders.lookup({ id: "order_42" })
    return { id: order.id, needsAttention: order.status !== "complete" }
  `),
)
```

`result` is always a [`CodeMode.Result`](#results).

## API

### `Tool.make`

`input` and `output` accept either an Effect Schema or a render-only JSON Schema document. Effect Schema input is
decoded before `execute`; Effect Schema output is decoded and safely copied before the program sees it. JSON Schemas
only shape the model-visible signature. Without `output`, the signature uses `Promise<void>`.

Descriptions and schemas are model-visible contracts. Authorization belongs in `execute`.

Nested records are the shorthand for ordinary namespaces. Use `Namespace.make` when a namespace needs a description:

```ts
const runtime = CodeMode.make({
  tools: {
    orders: Namespace.make({
      description: "Purchases, fulfillment, and shipment tracking",
      tools: { lookup: lookupOrder },
    }),
  },
})
```

Namespace descriptions are optional and participate in search matching for every descendant tool. Names still come
from record keys, so the wrapper does not repeat `orders`. Dots in keys create nested paths; other characters use
bracket notation, such as `tools.context7["resolve-library-id"](...)`.

### `CodeMode.execute` and `CodeMode.make`

`CodeMode.execute({ ...options, code })` runs once. `CodeMode.make(options)` creates a reusable runtime:

```ts
const runtime = CodeMode.make({ tools, limits: { timeoutMs: 30_000 } })

runtime.catalog() // structured tool descriptions
runtime.execute(source) // Effect<CodeMode.Result, never, ToolServices>
```

The Effect environment is inferred from the supplied tools. `hooks` surround every call the program makes into the
host: `tool.before`/`tool.after` receive `{ name, input }` with decoded input, `extension.before`/`extension.after`
receive `{ extension, name, args }`. An `after` hook also receives how the call ended (`success` with its value,
`failure` with its error, or `interrupted`). A failing `before` hook denies the call, and the program catches the
failure as a thrown error.

### `Extension.make`

Extensions are host functions a program calls directly as globals, such as `fetch`. Unlike tools they are not in the
catalog, not counted against `maxToolCalls`, and not described to the model; the host decides what they mean.

```ts
const web = Extension.make({ name: "web", globals: { fetch: (url: string) => globalThis.fetch(url) } })
const runtime = CodeMode.make({ tools, extensions: [web] })
```

Every value crossing in either direction is converted, never shared: arguments come in as copies, results go out as
copies, and a function inside a result is callable the same way. A global that shadows a built-in or another
extension throws at `CodeMode.make`.

### OpenAPI tools

`OpenAPI.fromSpec` converts an OpenAPI 3.x document into one tool per supported operation. Dotted `operationId` values
create namespaces:

```ts
const api = OpenAPI.fromSpec({ spec, auth: { resolve } })
const runtime = CodeMode.make({ tools: { opencode: api.tools } })
```

The synchronous result is `{ tools, skipped }`. Operations with unsupported parameter encodings, request bodies
without JSON content, WebSocket or SSE semantics, or binary responses are reported in `skipped`.

Authentication is resolved by the host and never shown to the model. Generated tools require `HttpClient.HttpClient`.
Request signatures omit `readOnly` properties; response signatures omit `writeOnly` properties. These JSON Schemas
shape model-visible signatures but do not filter runtime values: nested JSON body properties and decoded server
responses pass through unchanged. See `src/openapi/types.ts` for option details.

## Results

Every execution returns:

```ts
type Result =
  | {
      readonly ok: true
      readonly value: CodeMode.DataValue
      readonly warnings?: ReadonlyArray<CodeMode.Diagnostic>
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
  | {
      readonly ok: false
      readonly error: CodeMode.Diagnostic
      readonly logs?: ReadonlyArray<string>
      readonly truncated?: boolean
      readonly toolCalls: ReadonlyArray<CodeMode.ToolCall>
    }
```

`value` is JSON-safe. `warnings` are non-fatal diagnostics, `logs` contain program console output, and `truncated`
indicates that retained output was cut by `maxOutputBytes`. `toolCalls` retains admitted calls in order, including after
failure.

Diagnostic kinds:

| Kind                    | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `ParseError`            | Source is empty or cannot be parsed.                                                           |
| `UnsupportedSyntax`     | Parsed JavaScript is outside the supported subset.                                             |
| `UnknownTool`           | The program referenced an unavailable tool.                                                    |
| `InvalidToolInput`      | Tool input failed schema decoding or safe-data copying.                                        |
| `InvalidToolOutput`     | Tool output failed schema decoding or safe-data copying.                                       |
| `InvalidDataValue`      | Program data violated the plain-data contract.                                                 |
| `ToolCallLimitExceeded` | The program exceeded `maxToolCalls`.                                                           |
| `TimeoutExceeded`       | Execution timed out; as a warning, background work was interrupted after the program returned. |
| `ToolFailure`           | A tool refused or failed.                                                                      |
| `ExecutionFailure`      | The program threw or another execution error occurred.                                         |
| `Truncated`             | Warning only: additional warnings were omitted by `maxOutputBytes`.                            |

Host failures and defects report their messages and underlying causes. Invalid outputs include the validation or
copying error. Interruption propagates without becoming an error diagnostic.

## Discovery

`runtime.catalog()` returns structured descriptors — exact path, description, and generated TypeScript signature — for
every visible tool. Hosts render their own model-facing instructions from these descriptors; `CodeMode.searchSignature`
and `CodeMode.toolExpression(path)` supply the exact callable forms.

The synchronous `search(...)` built-in is always available. It supports exact-path lookup, namespace-scoped search,
empty-query browsing, and pagination, and returns callable paths with full signatures. Search counts toward
`maxToolCalls`. Search also matches descriptions from enclosing `Namespace` values.

## Execution Limits

| Limit            | Default   | Controls                        |
| ---------------- | --------- | ------------------------------- |
| `timeoutMs`      | unlimited | Total execution time.           |
| `maxToolCalls`   | unlimited | Admitted tool calls.            |
| `maxOutputBytes` | unlimited | Retained result value and logs. |

Execution limits have no default values.

Invalid limit configuration throws `RangeError`. Warnings receive a separate budget equal to `maxOutputBytes`.
Truncation does not fail execution; an oversized value becomes a string with an in-band marker. Timeouts interrupt
tool calls and busy loops, while a result returned before cleanup times out remains successful with a
`TimeoutExceeded` warning. Tool-call concurrency is unrestricted. Boundary data is limited to 32 nested levels.
