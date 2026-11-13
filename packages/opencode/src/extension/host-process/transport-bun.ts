import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { getSystemErrorName } from "node:util"
import { killWorkerTree } from "./transport.ts"
// The C source travels inside the binary: `with { type: "text" }` is inlined
// by Bun at bundle time, so the compiled sidecar can still feed `cc` a real
// file (bunfs paths like `/$bunfs/root/…` are not visible to the compiler).
import controlFdSource from "./control-fd.c" with { type: "text" }

export type OwnedWorkerChild = {
  readonly pid: number
  readonly input: Readable
  readonly output: ReturnType<typeof connect>
  readonly logs: readonly [Readable, Readable]
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly failure: Error | undefined
  shutdown(): void
  close(): void
  terminate(): void
}

/**
 * Bun's compatibility child_process shares extra fds with the native finalizer
 * (specs/extensions/prototypes README: a GC'd Subprocess closes an fd number a
 * later spawn may already own). Give every control socket a CLOEXEC duplicate
 * instead; the subprocess keeps the originals. Bun-only module — the host
 * transport loads it dynamically and never on other runtimes.
 */
/**
 * Write the embedded `control-fd.c` to a content-addressed real path that
 * `cc` can open. In a compiled binary `import.meta.url` resolves inside
 * `/$bunfs/` — `existsSync` sees it through Bun's patched fs, but the FFI
 * compiler cannot (verified T5.4), so the source must be materialized.
 * Same-content writes race harmlessly through a unique tmp file + rename.
 */
export function controlFdSourceFile(): string {
  const digest = createHash("sha256").update(controlFdSource).digest("hex").slice(0, 16)
  const dir = path.join(tmpdir(), "opencode-extension-host")
  const file = path.join(dir, `control-fd-${digest}.c`)
  if (existsSync(file) && readFileSync(file, "utf8") === controlFdSource) return file
  mkdirSync(dir, { recursive: true })
  const staging = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(staging, controlFdSource)
  try {
    renameSync(staging, file)
  } catch {
    try {
      writeFileSync(file, controlFdSource)
    } catch {
      // Another writer owns the file; the digest already guarantees content.
    }
  }
  return file
}

export async function spawnBunWorker(options: {
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
}): Promise<OwnedWorkerChild> {
  // Validated on macOS and Linux; Windows has no fd-based extra-stdio channel.
  if (process.platform === "win32")
    throw new Error("Bun host-process control descriptors are unsupported on Windows")
  const { cc } = await import("bun:ffi")
  // Darwin arm64 passes fcntl's variadic argument on the stack. A fixed FFI
  // signature is not ABI-compatible; compile a tiny fixed-argument C wrapper.
  const library = cc({
    source: controlFdSourceFile(),
    symbols: {
      duplicate_control_fd: { args: ["i32"], returns: "i32" },
      close_control_fd: { args: ["i32"], returns: "i32" },
      control_fd_errno: { args: [], returns: "i32" },
      shutdown_control_fd: { args: ["i32"], returns: "i32" },
    },
  })
  const sockets: ReturnType<typeof connect>[] = []
  const logs: Readable[] = []
  const unclaimed = new Set<number>()
  let outputFd = -1
  let transferred = false
  let earlyFailure: Error | undefined
  let libraryClosed = false
  const closeLibrary = () => {
    if (!libraryClosed) {
      libraryClosed = true
      library.close()
    }
  }
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined
  try {
    child = Bun.spawn([options.executable, ...options.args], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      // Bun.spawn does not inherit the host environment (verified 1.3.x);
      // the worker contract is a full env clone unless the caller narrows it.
      env: options.env ?? process.env,
      // Independent process group so a forced stop can reap descendants that
      // bypassed host.spawn, matching the Node child_process detached path.
      // Windows is rejected above, so detached is unconditional here.
      detached: true,
      windowsHide: true,
    })
    for (const index of [4, 3]) {
      const original = child.stdio[index]
      if (typeof original !== "number" || original < 0) throw new Error("Missing worker control descriptor")
      // F_DUPFD_CLOEXEC resolves in the C wrapper: atomically prevent
      // inheritance by other spawns.
      const duplicate = library.symbols.duplicate_control_fd(original)
      if (duplicate < 0)
        throw new Error(
          `Worker control descriptor duplication failed fd=${original} errno=${library.symbols.control_fd_errno()}`,
        )
      unclaimed.add(duplicate)
      if (index === 3) outputFd = duplicate
      // Bun supports adopting an existing connected fd through connect; Node's
      // declaration only describes path/port connects. This module is Bun-only.
      const adopt = connect as unknown as (options: { fd: number }) => ReturnType<typeof connect>
      const socket = adopt({ fd: duplicate })
      sockets.push(socket)
      unclaimed.delete(duplicate)
      // Remember construction-time errors until the protocol owner attaches.
      socket.on("error", (error) => {
        earlyFailure ??= error
      })
    }
    const native = child
    const exited = native.exited.then((code) => ({
      code: native.signalCode ? null : code,
      signal: native.signalCode ?? null,
    }))
    for (const source of [native.stdout, native.stderr]) {
      logs.push(Readable.fromWeb(source as unknown as Parameters<typeof Readable.fromWeb>[0]))
    }
    for (const stream of logs)
      stream.on("error", (error) => {
        earlyFailure ??= error
      })
    transferred = true
    return {
      pid: native.pid,
      input: sockets[0]!,
      output: sockets[1]!,
      logs: [logs[0]!, logs[1]!],
      get failure() {
        return earlyFailure
      },
      exited,
      shutdown() {
        if (sockets[1]!.destroyed) return
        if (library.symbols.shutdown_control_fd(outputFd) !== 0) {
          const errno = library.symbols.control_fd_errno()
          // The peer can finish between the caller's exit check and shutdown.
          if (getSystemErrorName(-errno) !== "ENOTCONN") {
            throw new Error(`Worker control shutdown failed errno=${errno}`)
          }
        }
      },
      close: closeLibrary,
      terminate() {
        if (native.exitCode === null) killWorkerTree(native.pid, () => native.kill())
      },
    }
  } catch (error) {
    const closing = [...sockets, ...logs].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.closed) return resolve()
          stream.once("close", resolve)
          stream.destroy()
        }),
    )
    for (const fd of unclaimed) library.symbols.close_control_fd(fd)
    if (child) {
      child.kill("SIGKILL")
      await child.exited
      await Promise.allSettled([
        child.stdout.locked ? undefined : child.stdout.cancel(),
        child.stderr.locked ? undefined : child.stderr.cancel(),
      ])
    }
    await Promise.all(closing)
    throw error
  } finally {
    if (!transferred) closeLibrary()
  }
}
