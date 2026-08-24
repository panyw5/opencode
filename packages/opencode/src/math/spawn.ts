import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"

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
    const child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    })
    if (child.pid == null) throw new Error(`spawn failed: ${input.argv.join(" ")}`)
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
  try {
    process.kill(-pid, signal)
  } catch {
    process.kill(pid, signal)
  }
}

/** Re-exec this CLI with extra args. Handles `bun src/index.ts` and a compiled binary. */
export function selfArgv(subcommand: string[]): string[] {
  const exec = process.execPath
  const script = process.argv[1]
  if (script) {
    const base = path.basename(script)
    if (base === "index.ts" || base === "index.js" || base === "opencode" || script.includes(`${path.sep}src${path.sep}index.`)) {
      return [exec, script, ...subcommand]
    }
  }
  return [exec, ...subcommand]
}

export * as MathSpawn from "./spawn"
