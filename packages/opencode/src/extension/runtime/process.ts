import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import * as Log from "@opencode-ai/core/util/log"
import type {
  ExtensionProcessStdio,
  ExtensionSpawnOptions,
  ManagedProcess,
} from "@opencode-ai/extension-kit/server"

const log = Log.create({ service: "extension" })

/**
 * Last-resort wait for an exit event after SIGKILL. SIGKILL cannot be
 * handled, so an exit should arrive promptly; the backstop only keeps an
 * unkillable child (kernel D-state, un-reaped zombie) from blocking teardown
 * forever. Timing out is logged — it never stands in for the exit event.
 */
const KILL_BACKSTOP_MS = 5_000

const DEFAULT_STDIO: readonly [ExtensionProcessStdio, ExtensionProcessStdio, ExtensionProcessStdio] = [
  "ignore",
  "pipe",
  "pipe",
]

type Managed = Omit<ManagedProcess, "exitCode" | "exitSignal" | "exited" | "killed"> & {
  child: ChildProcess
  exitCode: number | null
  exitSignal: string | null
  exited: boolean
  killed: boolean
}

type ProcessScopeOptions = {
  extension: string
  gen: number
  epoch: number
  started: number
  available(): boolean
  killGraceMs(): number
}

/**
 * Child processes owned by one host generation, mirroring the timers scope.
 * Implemented on `node:child_process` — not `Bun.spawn` — so the runtime
 * behaves identically inside Bun and in plain Node processes that import
 * these sources (the leases.test.ts precedent). Children always run detached
 * as their own process group on POSIX, so teardown can signal the whole tree
 * with `process.kill(-pid)`; Windows instead reaps via `taskkill /T`.
 */
export function makeProcessScope(options: ProcessScopeOptions) {
  const children = new Set<Managed>()
  let closed = false

  const detail = (child: ChildProcess) => ({
    extension: options.extension,
    phase: "process",
    gen: options.gen,
    epoch: options.epoch,
    pid: child.pid ?? -1,
    elapsedMs: Date.now() - options.started,
  })

  function signalGroup(child: ChildProcess, force: boolean) {
    const pid = child.pid
    if (!pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === "win32") {
      // Windows has no POSIX process groups. taskkill /T walks the tree; /F
      // forces it. Without /F taskkill only delivers a close request that
      // console children can ignore — mirroring the TERM/KILL escalation.
      const killer = spawnChild("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("error", () => child.kill("SIGKILL"))
      return
    }
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM")
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM")
      } catch {
        /* already gone */
      }
    }
  }

  function terminate(child: Managed): Promise<void> {
    if (child.exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = () => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        resolve()
      }
      child.killed = true
      // Resolves on the observed exit event, not on a fixed wait.
      child.onExit(finish)
      log.info("extension process kill", { ...detail(child.child), signal: "SIGTERM" })
      signalGroup(child.child, false)
      const grace = setTimeout(() => {
        if (child.exited) return finish()
        log.warn("extension process kill escalated", { ...detail(child.child), signal: "SIGKILL" })
        signalGroup(child.child, true)
        const backstop = setTimeout(() => {
          if (!child.exited) log.error("extension process kill timed out", detail(child.child))
          finish()
        }, KILL_BACKSTOP_MS)
        backstop.unref?.()
        timers.push(backstop)
      }, options.killGraceMs())
      grace.unref?.()
      timers.push(grace)
    })
  }

  function makeManaged(child: ChildProcess): Managed {
    const exits = new Set<(code: number | null, signal: string | null) => void>()
    const errors = new Set<(error: Error) => void>()
    const settle = (code: number | null, signal: string | null) => {
      if (managed.exited) return
      managed.exited = true
      managed.exitCode = code
      managed.exitSignal = signal
      children.delete(managed)
      for (const listener of exits) listener(code, signal)
    }
    const managed: Managed = {
      child,
      get pid() {
        return child.pid
      },
      get stdin() {
        return child.stdin
      },
      get stdout() {
        return child.stdout
      },
      get stderr() {
        return child.stderr
      },
      exitCode: null,
      exitSignal: null,
      exited: false,
      killed: false,
      onExit(listener) {
        exits.add(listener)
        return () => exits.delete(listener)
      },
      onError(listener) {
        errors.add(listener)
        return () => errors.delete(listener)
      },
      kill(signal = "TERM") {
        managed.killed = true
        signalGroup(child, signal === "KILL")
      },
    }
    child.once("exit", (code, signal) => {
      log.info("extension process exit", { ...detail(child), code: code ?? -1, signal: signal ?? "" })
      settle(code, signal)
    })
    child.once("error", (error) => {
      log.error("extension process error", { ...detail(child), error: String(error) })
      for (const listener of errors) listener(error)
      // A failed spawn reports 'error' without a guaranteed 'exit'. Treat it
      // as terminal so scoped teardown never waits on an exit that cannot
      // arrive.
      if (child.pid === undefined) settle(null, null)
    })
    return managed
  }

  return {
    spawn(command: string, args: string[] = [], spawnOptions: ExtensionSpawnOptions = {}): ManagedProcess {
      if (closed || !options.available()) {
        throw new Error(`Extension host is disposed and cannot spawn: ${options.extension}`)
      }
      const stdio = spawnOptions.stdio ?? DEFAULT_STDIO
      const child = spawnChild(command, args, {
        cwd: spawnOptions.cwd,
        env: { ...process.env, ...spawnOptions.env },
        stdio: [stdio[0] ?? "ignore", stdio[1] ?? "pipe", stdio[2] ?? "pipe"],
        // detached gives the child its own process group on POSIX so
        // process.kill(-pid) reaps the tree. It is skipped on Windows, where
        // detached would instead allocate a new console window and taskkill
        // /T already walks the tree regardless of grouping.
        detached: process.platform !== "win32",
        windowsHide: true,
      })
      const managed = makeManaged(child)
      children.add(managed)
      log.info("extension process spawn", { ...detail(child), command })
      return managed
    },
    /**
     * SIGTERM every surviving child, escalate to SIGKILL after the grace
     * period, then resolve once each exit was observed. Never rejects.
     */
    dispose(): Promise<void> | undefined {
      if (closed) return
      closed = true
      const pending = [...children].map((child) => terminate(child))
      if (!pending.length) return
      return Promise.allSettled(pending).then(() => undefined)
    },
  }
}
