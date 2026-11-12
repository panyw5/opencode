import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const Message = z.object({
  type: z.string(),
  pid: z.number().int().positive(),
  descendants: z.array(z.number().int().positive()).optional(),
  runtime: z.enum(["node", "bun", "electron"]).optional(),
  exitCode: z.number().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  requestId: z.string().optional(),
  pending: z.number().optional(),
  ticks: z.number().optional(),
})
type Message = z.infer<typeof Message>
type Outcome = { code: number | null; signal: NodeJS.Signals | null }
const fixture = fileURLToPath(new URL("./fixtures/lifecycle-process.mjs", import.meta.url))

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Lifecycle fixture timed out: ${label}`)), 10_000)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Spawn the private fixture, not a production extension supervisor.
 * @param executable Node or Bun executable used for the whole fixture tree.
 * @param options Process depth and controlled failure behavior.
 * @returns Command/event handle whose async disposer terminates and awaits its owned processes.
 */
export function lifecycleProcess(
  executable: string,
  options: { depth?: number; behavior?: "cooperative" | "throw" | "hang" | "ignore-term" } = {},
) {
  if (process.platform === "win32" && options.depth) {
    throw new Error("Process-group prototype requires POSIX; Windows needs a Job Object implementation")
  }
  return fixtureProcess(executable, [fixture, String(options.depth ?? 0), options.behavior ?? "cooperative"])
}

/**
 * Start an isolated probe and retain its streams until it closes.
 * @param executable Runtime executable for the private test probe.
 * @param args Probe entrypoint and arguments, never application/user extension input.
 * @param env Optional child-only environment, without mutating the runner's environment.
 * @returns A JSON-event/command handle with quiescent process cleanup.
 */
export function fixtureProcess(executable: string, args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(executable, args, {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env,
  })
  const messages: Message[] = []
  const waiters = new Set<() => void>()
  let failure: Error | undefined
  let outcome: Outcome | undefined
  let stderr = ""
  const notify = () => {
    for (const listener of waiters) listener()
  }
  const exit = new Promise<Outcome>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }))
  })
  const close = new Promise<Outcome>((resolve) => {
    child.once("close", (code, signal) => {
      // Bun omits signal on spawn failure; expose Node's explicit null in the fixture result.
      outcome = { code, signal: signal ?? null }
      notify()
      resolve(outcome)
    })
  })
  // A spawn failure can arrive before the test starts waiting for ready.
  const failed = (error: Error) => {
    failure = error
    notify()
  }
  child.once("error", failed)
  void exit.catch(failed)
  void close.catch(failed)
  child.stdin.on("error", failed)
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-8192)
  })
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    let input: unknown
    try {
      input = JSON.parse(line)
    } catch (error) {
      failure = new Error("Lifecycle fixture emitted invalid JSON", { cause: error })
      notify()
      return
    }
    const parsed = Message.safeParse(input)
    if (parsed.success) messages.push(parsed.data)
    else failure ??= new Error(`Lifecycle fixture emitted an invalid event: ${parsed.error.message}`)
    notify()
  })

  async function wait(type: Message["type"]): Promise<Message> {
    let listener: () => void = () => {}
    try {
      return await bounded(
        new Promise<Message>((resolve, reject) => {
          listener = () => {
            if (failure) return reject(failure)
            const index = messages.findIndex((message) => message.type === type)
            if (index !== -1) return resolve(messages.splice(index, 1)[0]!)
            const error = messages.find((message) => message.type === "error")
            if (error) return reject(new Error(`Fixture failed before ${type}: ${error.code} ${error.message}`))
            if (outcome) reject(new Error(`Fixture closed before ${type}: ${JSON.stringify(outcome)} ${stderr}`))
          }
          waiters.add(listener)
          listener()
        }),
        type,
      )
    } finally {
      waiters.delete(listener)
    }
  }

  function signal(signal: NodeJS.Signals, group = false) {
    if (!child.pid) throw new Error("Fixture has no process identity")
    if (outcome) throw new Error("Fixture has already closed")
    if (group && process.platform === "win32") throw new Error("Windows process groups are not implemented")
    process.kill(group ? -child.pid : child.pid, signal)
  }

  return {
    wait,
    send(command: {
      type: "request" | "cancel" | "inspect" | "dispose" | "exit" | "acquire" | "release" | "assert" | "crash" | "touch"
      requestId?: string
    }) {
      child.stdin.write(`${JSON.stringify(command)}\n`)
    },
    signal,
    diagnostics: () => stderr,
    disconnect: () => child.stdin.end(),
    exited: () => bounded(exit, "root exit"),
    closed: () => bounded(close, "tree stdio close"),
    async [Symbol.asyncDispose]() {
      try {
        if (outcome) return
        if (child.pid) {
          try {
            signal("SIGKILL", process.platform !== "win32")
          } catch (error) {
            // ESRCH means this exact owned group exited before the signal; still await close.
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
          }
        }
        await bounded(close, "fixture cleanup")
      } finally {
        lines.close()
        child.stdin.destroy()
      }
    },
  }
}
