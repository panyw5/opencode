import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "math.spawn" })

export type SpawnDetachedInput = {
  argv: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  logFile: string
}

/**
 * Start a process in a new session (Unix `setsid` via `detached: true`).
 * stdin is ignored; stdout/stderr append to logFile. `unref()` so the parent
 * can exit without taking the child with it.
 */
export function spawnDetached(input: SpawnDetachedInput): { pid: number } {
  if (input.argv.length === 0) throw new Error("argv required")
  mkdirSync(path.dirname(input.logFile), { recursive: true })
  const fd = openSync(input.logFile, "a")
  try {
    log.info("detached spawn preparing", {
      executable: input.argv[0],
      argc: input.argv.length,
      cwd: input.cwd,
      logFile: input.logFile,
    })
    const child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    })
    if (child.pid == null) throw new Error(`spawn failed: ${input.argv.join(" ")}`)
    child.once("error", (error) => {
      log.error("detached spawn process error", {
        executable: input.argv[0],
        pid: child.pid,
        error: error.message,
      })
    })
    log.info("detached spawn created", { executable: input.argv[0], pid: child.pid })
    child.unref()
    return { pid: child.pid }
  } finally {
    closeSync(fd)
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  log.info("process group signal start", { pid, pgid: pid, signal })
  try {
    process.kill(-pid, signal)
    log.info("process group signal sent", { pid, pgid: pid, signal, target: "group" })
  } catch (groupError) {
    const groupMessage = groupError instanceof Error ? groupError.message : String(groupError)
    log.warn("process group signal fallback", { pid, pgid: pid, signal, groupError: groupMessage })
    try {
      process.kill(pid, signal)
      log.info("process group signal sent", { pid, pgid: pid, signal, target: "process" })
    } catch (processError) {
      const processMessage = processError instanceof Error ? processError.message : String(processError)
      log.error("process group signal failed", {
        pid,
        pgid: pid,
        signal,
        groupError: groupMessage,
        processError: processMessage,
      })
      throw processError
    }
  }
}

export type SelfArgvRuntime = {
  execPath: string
  argv: string[]
  env: NodeJS.ProcessEnv
  electron: boolean
}

/** Resolve a re-exec command for a source CLI, compiled binary, or Electron sidecar. */
export function resolveSelfArgv(subcommand: string[], runtime: SelfArgvRuntime): string[] {
  const override = runtime.env.OPENCODE_CLI_PATH?.trim()
  if (override) return [override, ...subcommand]

  const exec = runtime.execPath
  const script = runtime.argv[1]
  if (script) {
    const base = path.basename(script)
    if (base === "index.ts" || base === "index.js" || base === "opencode" || script.includes(`${path.sep}src${path.sep}index.`)) {
      return [exec, script, ...subcommand]
    }
  }
  if (runtime.electron) {
    throw new Error("Cannot re-exec OpenCode from Electron without OPENCODE_CLI_PATH")
  }
  return [exec, ...subcommand]
}

/** Re-exec this CLI with extra args. Handles source, binary, and Electron sidecar runtimes. */
export function selfArgv(subcommand: string[]): string[] {
  const result = resolveSelfArgv(subcommand, {
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    electron: "electron" in process.versions,
  })
  log.info("self argv resolved", {
    executable: result[0],
    sourceScript: result.length > subcommand.length + 1 ? result[1] : undefined,
    override: Boolean(process.env.OPENCODE_CLI_PATH),
    electron: "electron" in process.versions,
    subcommand: subcommand.join(" "),
  })
  return result
}

export * as MathSpawn from "./spawn"
