import { Schema } from "effect"
import { loadExtensionApplication } from "./application.ts"
import { RuntimeIdentity } from "./protocol.ts"
import { openWorkerChannel, serveWorker } from "./worker.ts"

/**
 * Worker entrypoint for `opencode extension-host` (T5.2). `src/index.ts`
 * intercepts this subcommand before yargs so the worker never runs the global
 * middleware (Log.init, DB migration — process-isolation-design.md §1.2).
 *
 * The fence identity arrives on argv — it is required before `hello`, which
 * is too early for the init payload. Everything else (extension dir, entry
 * path, settings snapshot) arrives in the `init` command.
 *
 * This file stays free of `@/` aliases and heavyweight imports so a Node
 * type-stripping worker can load it the same way Bun does.
 */

/** Mirrors `DEFAULT_LIMITS.frameBytes` in supervisor.ts; overridable on argv. */
const FRAME_BYTES = 1024 * 1024
/** Mirrors `DEFAULT_LIMITS.maxPending` and `RPC_CONCURRENCY_LIMIT`. */
const MAX_REQUESTS = 32

const usage = `opencode extension-host — internal extension worker entrypoint

This command is launched by the OpenCode sidecar with fd3/fd4 control pipes.
It is not a user-facing command.

Options:
  --identity <json>   runtime fence identity issued by the supervisor (required)
  --identity=<json>   same, equals-sign form
  --frame-bytes <n>   control frame size limit (default ${FRAME_BYTES})
  -h, --help          show this text
`

type ParsedArgs = { identity?: string; frameBytes: number; help: boolean }

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { frameBytes: FRAME_BYTES, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "-h" || arg === "--help") {
      result.help = true
      continue
    }
    if (arg === "--identity") {
      result.identity = argv[++index]
      continue
    }
    if (arg.startsWith("--identity=")) {
      result.identity = arg.slice("--identity=".length)
      continue
    }
    if (arg === "--frame-bytes") {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`extension-host --frame-bytes must be a positive integer: ${argv[index]}`)
      result.frameBytes = value
      continue
    }
    if (arg.startsWith("--frame-bytes=")) {
      const value = Number(arg.slice("--frame-bytes=".length))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`extension-host --frame-bytes must be a positive integer: ${arg}`)
      result.frameBytes = value
      continue
    }
    // A bare positional argument is accepted as the identity JSON so the
    // supervisor's argv builder can stay minimal.
    if (!arg.startsWith("-") && result.identity === undefined) {
      result.identity = arg
      continue
    }
    throw new Error(`extension-host unknown argument: ${arg}`)
  }
  return result
}

/**
 * Run the extension worker on the already-provided fd3/fd4 control pipes.
 * @returns Process exit code: 0 after a clean dispose, 1 otherwise.
 */
export async function runExtensionHost(argv: string[]): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  if (parsed.help) {
    process.stdout.write(usage)
    return 0
  }
  if (!parsed.identity) {
    process.stderr.write("extension-host requires --identity <json>\n")
    return 1
  }
  let identity: RuntimeIdentity
  try {
    identity = Schema.decodeUnknownSync(RuntimeIdentity)(JSON.parse(parsed.identity))
  } catch (cause) {
    process.stderr.write(`extension-host invalid --identity: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  const channel = openWorkerChannel({ frameBytes: parsed.frameBytes })
  const outcome = await serveWorker({
    identity,
    channel,
    maxRequests: MAX_REQUESTS,
    load: (init, host, signal) => loadExtensionApplication(init, host, signal),
    report: (event) => process.stderr.write(`extension-host ${event}\n`),
    // fd3 EOF means the host control channel is gone; exit so a crashed host
    // never leaves an orphan holding extension state (design §1.1).
    disconnect: () => process.exit(1),
  })
  return outcome === "disposed" ? 0 : 1
}

export * as HostProcessEntry from "./entry.ts"
