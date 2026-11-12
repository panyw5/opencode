import { connect } from "node:net"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

export type OwnedExecutionChild = {
  readonly pid: number
  readonly input: Readable
  readonly output: ReturnType<typeof connect>
  readonly logs: readonly [Readable, Readable]
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
}

/** Bun's compatibility child_process shares extra fds with the native finalizer.
 * Give every socket a CLOEXEC duplicate instead; the subprocess owns originals. */
export async function spawnBunExecution(options: { executable: string; args: string[]; env?: NodeJS.ProcessEnv }): Promise<OwnedExecutionChild> {
  if (process.platform !== "darwin") throw new Error("Bun execution descriptors require a validated platform adapter")
  const { cc } = await import("bun:ffi")
  // Darwin arm64 passes fcntl's variadic argument on the stack. A fixed FFI
  // signature is not ABI-compatible; compile a tiny fixed-argument C wrapper.
  const library = cc({
    source: fileURLToPath(new URL("./execution-fd.c", import.meta.url)),
    symbols: {
      duplicate_control_fd: { args: ["i32"], returns: "i32" },
      close_control_fd: { args: ["i32"], returns: "i32" },
      control_fd_errno: { args: [], returns: "i32" },
    },
  })
  const sockets: ReturnType<typeof connect>[] = []
  const unclaimed = new Set<number>()
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined
  try {
    child = Bun.spawn([options.executable, ...options.args], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      env: options.env,
    })
    for (const index of [4, 3]) {
      const original = child.stdio[index]
      if (typeof original !== "number" || original < 0) throw new Error("Missing execution control descriptor")
      // Darwin F_DUPFD_CLOEXEC=67: atomically prevent inheritance by other spawns.
      const duplicate = library.symbols.duplicate_control_fd(original)
      if (duplicate < 0) throw new Error(`Execution control descriptor duplication failed fd=${original} errno=${library.symbols.control_fd_errno()}`)
      unclaimed.add(duplicate)
      const socket = connect({ fd: duplicate })
      sockets.push(socket)
      unclaimed.delete(duplicate)
      // Install an observer before callers can attach the protocol failure path.
      socket.on("error", () => {})
    }
    const native = child
    const exited = native.exited.then((code) => ({ code: native.signalCode ? null : code, signal: native.signalCode ?? null }))
    return {
      pid: native.pid,
      input: sockets[0]!,
      output: sockets[1]!,
      logs: [Readable.fromWeb(native.stdout as ReadableStream<Uint8Array>), Readable.fromWeb(native.stderr as ReadableStream<Uint8Array>)],
      exited,
      terminate() { if (native.exitCode === null) native.kill("SIGKILL") },
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    for (const fd of unclaimed) library.symbols.close_control_fd(fd)
    if (child) {
      child.kill("SIGKILL")
      await child.exited
      await Promise.allSettled([child.stdout.cancel(), child.stderr.cancel()])
    }
    throw error
  } finally {
    library.close()
  }
}
