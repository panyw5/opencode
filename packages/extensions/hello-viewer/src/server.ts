import {
  defineServerExtension,
  type ExtensionHooks,
  type ExtensionHost,
  type ExtensionService,
  type RpcHandler,
} from "@opencode-ai/extension-kit/server"
import { spawn, type ChildProcess } from "node:child_process"
import { tool } from "@opencode-ai/plugin/tool"
import { resolveChildRuntime } from "./child-runtime"

const EXTENSION_ID = "example.hello-viewer"
const GREETING_EVENT = `${EXTENSION_ID}/greeting`
const CHILD_PREFIX = "hello-viewer-child:"
const CHILD_PING_TIMEOUT_MS = 5_000

/**
 * Tiny line-echo child. Spawning is deliberately lazy: the process only
 * exists while the example's child RPC methods are being exercised, and it is
 * killed by `dispose()` (or `child.stop`) so nothing outlives the extension.
 */
const CHILD_SCRIPT = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    process.stdout.write(${JSON.stringify(CHILD_PREFIX)} + buffer.slice(0, index) + "\\n");
    buffer = buffer.slice(index + 1);
  }
});
process.stdin.resume();
`

type ChildState = {
  child?: ChildProcess
}

function isRunning(child: ChildProcess | undefined): child is ChildProcess {
  return child !== undefined && child.exitCode === null && !child.killed
}

function startChild(state: ChildState, host: ExtensionHost): ChildProcess {
  if (isRunning(state.child)) return state.child
  const runtime = resolveChildRuntime({ execPath: process.execPath, env: process.env })
  const child = spawn(runtime, ["-e", CHILD_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.on("error", (error) => {
    if (state.child === child) state.child = undefined
    host.log.error("hello-viewer child failed", { error: String(error) })
  })
  child.on("exit", () => {
    if (state.child === child) state.child = undefined
  })
  state.child = child
  host.log.info("hello-viewer child spawned", { pid: child.pid ?? -1 })
  return child
}

async function stopChild(state: ChildState): Promise<boolean> {
  const child = state.child
  if (!child) return false
  state.child = undefined
  if (child.exitCode !== null) return true
  child.kill("SIGTERM")
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once("exit", () => resolve())
    setTimeout(resolve, 1_000).unref?.()
  })
  return true
}

const childPings = new WeakMap<ChildProcess, Promise<void>>()

function pingChild(child: ChildProcess, text: string): Promise<string> {
  const pending = childPings.get(child) ?? Promise.resolve()
  const reply = pending.then(() => pingChildOnce(child, text))
  const settled = reply.then(
    () => {},
    () => {},
  )
  childPings.set(child, settled)
  void settled.then(() => {
    if (childPings.get(child) === settled) childPings.delete(child)
  })
  return reply
}

/** Writes one line to the child and waits for the echoed line back. */
function pingChildOnce(child: ChildProcess, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout
    const stdin = child.stdin
    if (!stdout || !stdin || child.exitCode !== null) {
      reject(new Error("hello-viewer child is not running"))
      return
    }
    let buffer = ""
    const timer = setTimeout(
      () => finish(new Error(`child ping timed out after ${CHILD_PING_TIMEOUT_MS}ms`)),
      CHILD_PING_TIMEOUT_MS,
    )
    const cleanup = () => {
      clearTimeout(timer)
      stdout.off("data", onData)
      stdout.off("error", onError)
      stdin.off("error", onError)
    }
    const finish = (error: Error | null, echoed?: string) => {
      cleanup()
      if (error) reject(error)
      else resolve(echoed ?? "")
    }
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.startsWith(CHILD_PREFIX)) continue
        finish(null, line.slice(CHILD_PREFIX.length))
        return
      }
    }
    const onError = (error: Error) => finish(error)
    stdout.on("data", onData)
    stdout.once("error", onError)
    stdin.once("error", onError)
    stdin.write(`${text}\n`)
  })
}

const extension = defineServerExtension({
  id: EXTENSION_ID,

  /**
   * Process-level service: RPC `echo` plus an event round-trip demo. The
   * child process is NOT started here — activation stays cheap and the child
   * only exists while someone explicitly exercises the demo.
   */
  async activate(host) {
    host.log.info("activating hello-viewer server part")
    const state: ChildState = {}

    const service: ExtensionService = {
      rpc: {
        echo: async (input) => {
          const message =
            typeof (input as { message?: unknown } | null | undefined)?.message === "string"
              ? (input as { message: string }).message
              : ""
          return {
            echo: message,
            extension: EXTENSION_ID,
            at: new Date().toISOString(),
          }
        },

        /**
         * Event demo: turns an RPC call into a server-pushed event so the
         * web part can exercise `ctx.rpc` and `ctx.events` together.
         */
        greet: async (input, ctx) => {
          const message =
            typeof (input as { message?: unknown } | null | undefined)?.message === "string"
              ? (input as { message: string }).message
              : "hello from the server part"
          const payload = { message, from: EXTENSION_ID, at: new Date().toISOString() }
          host.emit(GREETING_EVENT, payload, { directory: ctx.directory })
          return payload
        },

        /** Explicitly spawns the demo child; cheap and lazy by design. */
        "child.start": async () => {
          const child = startChild(state, host)
          return { running: true, pid: child.pid ?? -1 }
        },

        "child.ping": async (input) => {
          if (!isRunning(state.child)) {
            throw new Error("child is not running; call child.start first")
          }
          const text =
            typeof (input as { text?: unknown } | null | undefined)?.text === "string"
              ? (input as { text: string }).text
              : "ping"
          const echoed = await pingChild(state.child, text)
          return { echoed }
        },

        "child.stop": async () => {
          const stopped = await stopChild(state)
          return { stopped }
        },
      },

      dispose: async () => {
        await stopChild(state)
        host.log.info("hello-viewer server part disposed")
      },
    }

    return service
  },

  /**
   * Instance-level hooks: exactly one LLM tool. It also emits the greeting
   * event so a tool call is visible in the web part's event log.
   */
  async server(input) {
    const hooks: ExtensionHooks = {
      tool: {
        greet: tool({
          description:
            "Greet someone through the hello-viewer example extension. Use it to demonstrate extension-provided tools.",
          args: {
            name: tool.schema.string().describe("Who or what to greet"),
          },
          execute: async (args, ctx) => {
            const greeting = `Hello, ${args.name}! (from ${EXTENSION_ID})`
            try {
              input.extension.emit(GREETING_EVENT, {
                source: "tool",
                message: greeting,
                sessionID: ctx.sessionID,
                at: new Date().toISOString(),
              })
            } catch (error) {
              ctx.metadata({ metadata: { emitError: String(error) } })
            }
            return greeting
          },
        }),
      },
    }
    return hooks
  },
})

export default extension
