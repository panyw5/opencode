import { spawn } from "node:child_process"
import type { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { decodeExecutionCommand, ExecutionError, type ExecutionCommand } from "./execution-protocol.ts"

/** OS root-exit observation, deliberately not a descendant/process-tree proof. */
export type RootExit = { code: number | null; signal: NodeJS.Signals | null }
/** Host-owned transport; messages from a worker can never resolve exited. */
export interface ExecutionTransport {
  /** Capacity errors guarantee no enqueue; all other send failures may have an unknown execution outcome. */
  send(command: ExecutionCommand): void
  subscribe(message: (value: unknown) => void, failure: (error: Error) => void): () => void
  readonly exited: Promise<RootExit>
  terminate(): void
  release(): Promise<void>
}

/**
 * Frame JSON on a dedicated pipe; application stdout is not a control channel.
 * @param input Owned readable control pipe.
 * @param frameBytes Maximum bytes in one frame, excluding the newline.
 * @param message Receives parsed JSON; schema validation belongs to the receiving endpoint.
 * @param failure Receives malformed/oversized frames or I/O failure.
 * @returns Disposer that removes every installed listener without owning the pipe itself.
 */
export function readControlFrames(
  input: Readable,
  frameBytes: number,
  message: (value: unknown) => void,
  failure: (error: Error) => void,
): () => void {
  let pending = Buffer.alloc(0)
  let failed = false
  const fail = (cause: unknown) => {
    if (failed) return
    failed = true
    failure(new ExecutionError("protocol", { cause }))
  }
  const data = (chunk: Buffer) => {
    if (failed) return
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      if (pending.length + index - start > frameBytes) return fail(new Error("Execution frame exceeds limit"))
      const frame = Buffer.concat([pending, chunk.subarray(start, index)])
      pending = Buffer.alloc(0)
      start = index + 1
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame))
      } catch (cause) {
        return fail(cause)
      }
      message(value)
      if (failed) return
    }
    if (pending.length + chunk.length - start > frameBytes) return fail(new Error("Execution frame exceeds limit"))
    pending = Buffer.concat([pending, chunk.subarray(start)])
  }
  const end = () => {
    if (pending.length) fail(new Error("Truncated execution frame"))
  }
  input.on("data", data)
  input.on("error", fail)
  input.on("end", end)
  return () => {
    input.off("data", data)
    input.off("error", fail)
    input.off("end", end)
  }
}

/**
 * Close owned pipes while retaining an error listener until each close completes.
 * @param pipes Control or log streams belonging to this execution only.
 * @param error Listener already installed by the owner, removed after close.
 * @returns Completion of every local handle close, not proof of child or descendant exit.
 */
export async function closeExecutionPipes(
  pipes: readonly (Readable | Writable)[],
  error: (cause: Error) => void,
): Promise<void> {
  await Promise.all(
    pipes.map(
      (pipe) =>
        new Promise<void>((resolve) => {
          const events: EventEmitter = pipe
          if (pipe.closed) {
            events.off("error", error)
            return resolve()
          }
          events.once("close", () => {
            events.off("error", error)
            resolve()
          })
          pipe.destroy()
        }),
    ),
  )
}

/**
 * Spawn a private execution entrypoint with fd3 commands and fd4 events. No shell or detached process is used.
 * @param options Executable, immutable launch arguments, child-only environment and explicit transport budgets.
 * @returns Owned transport. Its disposer terminates and waits for this root, not arbitrary descendants.
 */
export async function spawnExecutionProcess(options: {
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
  frameBytes: number
  bufferedFrames: number
  exitMs: number
  log: (stream: "stdout" | "stderr", text: string) => void
}): Promise<ExecutionTransport & AsyncDisposable> {
  for (const value of [options.frameBytes, options.bufferedFrames, options.exitMs]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError("Execution transport budgets must be positive safe integers")
  }
  if (!Number.isSafeInteger(options.frameBytes * options.bufferedFrames))
    throw new RangeError("Execution queue byte budget overflows")
  let stage = "spawn"
  const diagnostic = (error?: unknown) => {
    const value = error as { code?: unknown; path?: unknown; cause?: { code?: unknown } } | undefined
    options.log(
      "stderr",
      `extension.transport pid=${process.pid} stage=${stage} code=${String(value?.code ?? "none")} path=${String(value?.path ?? "none")} cause=${String(value?.cause?.code ?? "none")}\n`,
    )
  }
  let child: ReturnType<typeof spawn> | undefined
  let bunChild: Awaited<ReturnType<typeof import("./execution-process-bun.ts").spawnBunExecution>> | undefined
  try {
    if (process.versions.bun) {
      const { spawnBunExecution } = await import("./execution-process-bun.ts")
      bunChild = await spawnBunExecution(options)
    } else {
      child = spawn(options.executable, options.args, {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        env: options.env,
      })
    }
  } catch (cause) {
    diagnostic(cause)
    throw new ExecutionError("transport", { cause })
  }
  const pid = bunChild?.pid ?? child!.pid
  const terminate = () => {
    if (bunChild) bunChild.terminate()
    else if (!outcome && !child!.kill("SIGKILL")) throw new ExecutionError("transport")
  }
  let outcome: RootExit | undefined
  const exited = bunChild
    ? bunChild.exited.then((exit) => { outcome = exit; return exit })
    : new Promise<RootExit>((resolve) => {
        child!.once("exit", (code, signal) => {
          outcome = { code, signal: signal ?? null }
          resolve(outcome)
        })
        child!.once("error", () => {
          if (!child!.pid) {
            outcome = { code: null, signal: null }
            resolve(outcome)
          }
        })
      })
  let receive: ((value: unknown) => void) | undefined
  let failed: ((error: Error) => void) | undefined
  let failure: Error | undefined
  const queued: unknown[] = []
  const fail = (error: Error) => {
    if (failure) return
    failure = error
    diagnostic(error)
    // A broken control channel cannot leave a loader alive behind a missing hello barrier.
    if (!outcome && pid) terminate()
    failed?.(error)
  }
  child?.on("error", fail)
  let input: Readable | undefined
  let output: Writable | undefined
  const pipes: (Readable | Writable)[] = []
  let released: Promise<void> | undefined
  let removeFrames: (() => void) | undefined
  const release = () =>
    (released ??= (async () => {
      removeFrames?.()
      receive = undefined
      failed = undefined
      queued.length = 0
      await closeExecutionPipes(pipes, fail)
    })())
  try {
    stage = `stdio child=${pid ?? "none"}`
    const stdio = bunChild ? [null, ...bunChild.logs, bunChild.output, bunChild.input] : child!.stdio
    for (const pipe of stdio)
      if (pipe) {
        pipes.push(pipe)
        pipe.on("error", fail)
      }
    if (failure) throw failure
    if (!(stdio[4] instanceof Readable) || !(stdio[3] instanceof Writable)) throw new ExecutionError("transport")
    input = stdio[4]
    output = stdio[3]
    stage = `control child=${pid ?? "none"}`
    removeFrames = readControlFrames(
      input,
      options.frameBytes,
      (value) => {
        if (receive) return receive(value)
        if (queued.length >= options.bufferedFrames) return fail(new ExecutionError("capacity"))
        queued.push(value)
      },
      fail,
    )
    const [stdout, stderr] = bunChild?.logs ?? [child!.stdout, child!.stderr]
    stdout?.on("data", (bytes: Buffer) => options.log("stdout", bytes.toString()))
    stderr?.on("data", (bytes: Buffer) => options.log("stderr", bytes.toString()))
    if (child) await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    if (failure) throw failure
    diagnostic()
  } catch (cause) {
    diagnostic(cause)
    if (!outcome && pid) terminate()
    await exited
    await release()
    throw new ExecutionError("transport", { cause })
  }
  return {
    exited,
    subscribe(message, onFailure) {
      if (receive) throw new ExecutionError("transport")
      receive = message
      failed = onFailure
      if (failure) onFailure(failure)
      else for (const value of queued.splice(0)) message(value)
      return () => {
        receive = undefined
        failed = undefined
      }
    },
    send(command) {
      if (outcome || released || failure || !output) throw new ExecutionError("transport", { cause: failure })
      const frame = JSON.stringify(decodeExecutionCommand(command))
      const bytes = Buffer.byteLength(frame) + 1
      if (bytes - 1 > options.frameBytes || output.writableLength + bytes > options.frameBytes * options.bufferedFrames)
        throw new ExecutionError("capacity")
      output.write(`${frame}\n`)
    },
    terminate,
    release,
    async [Symbol.asyncDispose]() {
      if (!outcome) terminate()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ExecutionError("deadline")), options.exitMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      await release()
    },
  }
}

export * as ExecutionProcess from "./execution-process.ts"
