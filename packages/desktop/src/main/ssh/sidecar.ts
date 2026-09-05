import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { checkHealth } from "../server"
import { startWithPortRetry } from "../startup-retry"
import { type SshCommandLine, type SshTarget, parseSshTarget, resolveRemoteOpencode, runSsh, shellEscape, sshArgs, summarize } from "./exec"

export type SshSidecar = {
  listener: {
    stop: () => void
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string | null
  password: string
}

export type SpawnSshSidecarOptions = {
  onLine?: (line: SshCommandLine) => void
  healthTimeoutMs?: number
}

export async function spawnSshSidecar(target: string, opts: SpawnSshSidecarOptions = {}): Promise<SshSidecar> {
  const parsed = parseSshTarget(target)
  if (!parsed) throw new Error(`Invalid SSH target: ${target}`)

  return startWithPortRetry({
    component: `SSH sidecar for ${target}`,
    allocatePort,
    start: (port) => spawnSshSidecarOnPort(parsed, port, opts),
  })
}

async function spawnSshSidecarOnPort(
  target: SshTarget,
  port: number,
  opts: SpawnSshSidecarOptions,
): Promise<SshSidecar> {
  const opencode = await resolveRemoteOpencode(target)
  if (!opencode) {
    throw new Error(`OpenCode is not installed on ${target.raw}; install it from the SSH servers settings`)
  }

  const password = randomUUID()
  const username = "opencode"
  // The remote shell owns the serve process: when the ssh session tears down
  // (graceful stop, client crash, network drop), the trap kills serve so no
  // orphans linger on the remote host. A pkill by exact port on stop covers
  // the residual cases where even the shell is SIGKILLed remotely.
  const serveScript = [
    `export OPENCODE_SERVER_USERNAME=${shellEscape(username)}`,
    `export OPENCODE_SERVER_PASSWORD=${shellEscape(password)}`,
    "export OPENCODE_CLIENT=desktop",
    'export XDG_STATE_HOME="$HOME/.local/state"',
    // The remote server binds loopback only; all traffic flows through the
    // local forward below.
    `${shellEscape(opencode)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 127.0.0.1 --port ${port} &`,
    "SERVE_PID=$!",
    "trap 'kill $SERVE_PID 2>/dev/null' INT TERM HUP EXIT",
    "wait $SERVE_PID",
  ].join("\n")

  const serve = spawn("ssh", sshArgs(target, serveScript), {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const forward = spawn(
    "ssh",
    sshArgs(target, null, [
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:${port}`,
    ]),
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const recentOutput: string[] = []
  const emit = (line: SshCommandLine, source: string) => {
    if (!line.text.trim()) return
    recentOutput.push(`[${source}/${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }
  forwardLines(serve.stdout, "stdout", (line) => emit(line, "serve"))
  forwardLines(serve.stderr, "stderr", (line) => emit(line, "serve"))
  forwardLines(forward.stdout, "stdout", (line) => emit(line, "forward"))
  forwardLines(forward.stderr, "stderr", (line) => emit(line, "forward"))

  let exitNotified = false
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  const onFirstExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exitNotified) return
    exitNotified = true
    for (const listener of exitListeners) listener(code, signal)
  }
  serve.once("exit", (code, signal) => onFirstExit(code, signal))
  forward.once("exit", (code, signal) => onFirstExit(code, signal))

  const killAll = () => {
    for (const child of [forward, serve]) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  // Best-effort remote cleanup, scoped to this sidecar's exact serve port so
  // it can never match an unrelated opencode process. Covers the case where
  // the remote shell was SIGKILLed and the trap never ran.
  const cleanupRemote = () => {
    void runSsh(target, `pkill -f ${shellEscape(`serve --hostname 127.0.0.1 --port ${port}`)} 2>/dev/null || true`, {
      timeoutMs: 10_000,
    }).catch(() => undefined)
  }

  const startupFailure = (code: number | null, signal: NodeJS.Signals | null) => {
    const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
    return new Error(
      `SSH sidecar for ${target.raw} exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`,
    )
  }

  const exit = new Promise<never>((_, reject) => {
    exitListeners.add((code, signal) => reject(startupFailure(code, signal)))
  })

  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const healthTimeoutMs = opts.healthTimeoutMs ?? 30_000
  const timeout = setTimeout(() => {
    const message = `SSH sidecar for ${target.raw} health check timed out after ${healthTimeoutMs}ms`
    recentOutput.push(`[health] ${message}`)
    onFirstExit(null, null)
  }, healthTimeoutMs)

  try {
    await Promise.race([
      pollHealth(() => checkHealth(url, password), startup.signal),
      exit,
    ])
  } catch (error) {
    clearTimeout(timeout)
    startup.abort()
    killAll()
    // A remote port collision surfaces as a serve exit; classify it so
    // startWithPortRetry allocates a fresh port and tries again.
    const message = error instanceof Error ? error.message : String(error)
    if (/address already in use|eaddrinuse/i.test(message)) {
      throw new Error(`SSH sidecar for ${target.raw}: ${summarize(message)}`)
    }
    if (/administratively prohibited/i.test(message)) {
      throw new Error(
        `${message}\nRemote sshd refuses TCP forwarding (AllowTcpForwarding) — enable it for this host`,
      )
    }
    throw error
  }
  clearTimeout(timeout)
  startup.abort()

  return {
    listener: {
      stop: () => {
        killAll()
        cleanupRemote()
      },
      onExit: (cb) => exitListeners.add(cb),
    },
    url,
    username,
    password,
  }
}

export async function probeSshConnectivity(target: string, timeoutMs = 15_000) {
  const parsed = parseSshTarget(target)
  if (!parsed) throw new Error(`Invalid SSH target: ${target}`)
  const result = await runSsh(parsed, "true && printf ok", { timeoutMs })
  if (result.code === 0 && result.stdout.includes("ok")) return
  throw new Error(summarize(result.stderr || result.stdout) || `Cannot connect to ${target}`)
}

export async function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function pollHealth(check: () => Promise<boolean>, signal: AbortSignal, interval = 100) {
  while (!signal.aborted) {
    if (await check()) return
    await abortableDelay(interval, signal)
  }
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timeout = setTimeout(done, duration)
    signal.addEventListener("abort", done, { once: true })
  })
}

function forwardLines(stream: NodeJS.ReadableStream, source: SshCommandLine["stream"], onLine: (line: SshCommandLine) => void) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    lines.forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}
