import { spawn } from "node:child_process"
import type { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { serializeCommand, HostProcessError, type HostCommand } from "./protocol.ts"

/** OS root-exit observation, deliberately not a descendant/process-tree proof. */
export type RootExit = { code: number | null; signal: NodeJS.Signals | null }

/** Host-owned transport; messages from a worker can never resolve exited. */
export interface WorkerTransport {
  /** OS pid of the worker root, for diagnostics only — never used as a fence. */
  readonly pid: number | undefined
  /** Capacity errors guarantee no enqueue; all other send failures may have an unknown execution outcome. */
  send(command: HostCommand): void
  subscribe(message: (value: unknown) => void, failure: (error: Error) => void): () => void
  readonly exited: Promise<RootExit>
  /** Force-kill the worker's process group; a successful kill request is not an exit observation. */
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
    failure(new HostProcessError({ code: "protocol", cause }))
  }
  const data = (chunk: Buffer) => {
    if (failed) return
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      if (pending.length + index - start > frameBytes) return fail(new Error("Worker frame exceeds limit"))
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
    if (pending.length + chunk.length - start > frameBytes) return fail(new Error("Worker frame exceeds limit"))
    pending = Buffer.concat([pending, chunk.subarray(start)])
  }
  const end = () => {
    if (pending.length) fail(new Error("Truncated worker frame"))
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
 * @param pipes Control or log streams belonging to this worker only.
 * @param error Listener already installed by the owner, removed after close.
 * @returns Completion of every local handle close, not proof of child or descendant exit.
 */
export async function closeControlPipes(
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
 * SIGKILL the worker's process group so descendants spawned without
 * `host.spawn` are reaped too (design §1.1). Workers start detached on POSIX,
 * making them group leaders; Windows instead relies on `taskkill /T`, matching
 * `runtime/process.ts`. Delivery is best-effort — it never proves exit.
 */
export function killWorkerTree(pid: number, kill: (signal: NodeJS.Signals) => unknown) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    killer.once("error", () => kill("SIGKILL"))
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    kill("SIGKILL")
  }
}

/**
 * Spawn a private worker entrypoint with fd3 commands and fd4 events. No shell is used.
 * @param options Executable, immutable launch arguments, child-only environment and explicit transport budgets.
 * @returns Owned transport. Its disposer terminates and waits for this root, not arbitrary descendants.
 */
export async function spawnWorkerTransport(options: {
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
  frameBytes: number
  bufferedFrames: number
  exitMs: number
  log: (stream: "stdout" | "stderr", text: string) => void
}): Promise<WorkerTransport & AsyncDisposable> {
  for (const value of [options.frameBytes, options.bufferedFrames, options.exitMs]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError("Worker transport budgets must be positive safe integers")
  }
  if (!Number.isSafeInteger(options.frameBytes * options.bufferedFrames))
    throw new RangeError("Worker queue byte budget overflows")
  let stage = "spawn"
  const diagnostic = (error?: unknown) => {
    const value = error as { code?: unknown; path?: unknown; cause?: { code?: unknown } } | undefined
    options.log(
      "stderr",
      `extension.transport pid=${process.pid} stage=${stage} code=${String(value?.code ?? "none")} path=${String(value?.path ?? "none")} cause=${String(value?.cause?.code ?? "none")}\n`,
    )
  }
  let child: ReturnType<typeof spawn> | undefined
  let bunChild: Awaited<ReturnType<typeof import("./transport-bun.ts").spawnBunWorker>> | undefined
  try {
    if (process.versions.bun) {
      const { spawnBunWorker } = await import("./transport-bun.ts")
      bunChild = await spawnBunWorker(options)
    } else {
      child = spawn(options.executable, options.args, {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        env: options.env,
        // Group leader so terminate() can SIGKILL the whole tree; skipped on
        // Windows where detached would allocate a console and taskkill /T
        // already walks the tree (same convention as runtime/process.ts).
        detached: process.platform !== "win32",
        windowsHide: true,
      })
    }
  } catch (cause) {
    diagnostic(cause)
    throw new HostProcessError({ code: "transport", cause })
  }
  const pid = bunChild?.pid ?? child!.pid
  const terminate = () => {
    if (bunChild) bunChild.terminate()
    else if (!outcome && pid) killWorkerTree(pid, (signal) => child!.kill(signal))
    else if (!outcome) throw new HostProcessError({ code: "transport" })
  }
  let outcome: RootExit | undefined
  const exited = bunChild
    ? bunChild.exited.then((exit) => {
        outcome = exit
        return exit
      })
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
    // Termination failure must not suppress the original channel failure.
    try {
      if (!outcome && pid) terminate()
    } catch (cause) {
      diagnostic(cause)
    }
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
      // Duplicates share the socket connection with native-owned originals.
      // Half-close commands explicitly so release still delivers EOF to a live worker.
      try {
        if (bunChild && !outcome) bunChild.shutdown()
      } finally {
        try {
          await closeControlPipes(pipes, fail)
        } finally {
          bunChild?.close()
        }
      }
    })())
  try {
    stage = `stdio child=${pid ?? "none"}`
    const stdio = bunChild ? [null, ...bunChild.logs, bunChild.output, bunChild.input] : child!.stdio
    for (const pipe of stdio)
      if (pipe) {
        pipes.push(pipe)
        pipe.on("error", fail)
      }
    if (bunChild?.failure) throw bunChild.failure
    if (failure) throw failure
    if (!(stdio[4] instanceof Readable) || !(stdio[3] instanceof Writable)) throw new HostProcessError({ code: "transport" })
    input = stdio[4]
    output = stdio[3]
    stage = `control child=${pid ?? "none"}`
    removeFrames = readControlFrames(
      input,
      options.frameBytes,
      (value) => {
        if (receive) return receive(value)
        if (queued.length >= options.bufferedFrames) return fail(new HostProcessError({ code: "capacity" }))
        queued.push(value)
      },
      fail,
    )
    const [stdout, stderr] = bunChild?.logs ?? [child!.stdout, child!.stderr]
    stdout?.on("data", (bytes: Buffer) => options.log("stdout", bytes.toString()))
    stderr?.on("data", (bytes: Buffer) => options.log("stderr", bytes.toString()))
    if (child)
      await new Promise<void>((resolve, reject) => {
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
    throw new HostProcessError({ code: "transport", cause })
  }
  return {
    pid,
    exited,
    subscribe(message, onFailure) {
      if (receive) throw new HostProcessError({ code: "transport" })
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
      if (outcome || released || failure || !output) throw new HostProcessError({ code: "transport", cause: failure })
      const frame = serializeCommand(command)
      const bytes = Buffer.byteLength(frame) + 1
      if (bytes - 1 > options.frameBytes || output.writableLength + bytes > options.frameBytes * options.bufferedFrames)
        throw new HostProcessError({ code: "capacity" })
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
            timer = setTimeout(() => reject(new HostProcessError({ code: "deadline" })), options.exitMs)
            timer.unref?.()
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      await release()
    },
  }
}

export * as HostProcessTransport from "./transport.ts"
