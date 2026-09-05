import { spawn } from "node:child_process"

export type SshTarget = {
  /** Raw target string as configured by the user. */
  raw: string
  user: string | null
  host: string
  port: number | null
}

export type SshCommandLine = {
  stream: "stdout" | "stderr"
  text: string
}

export type SshCommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type RunSshOptions = {
  signal?: AbortSignal
  /**
   * Ceiling on how long we wait for the ssh process to exit. Every invocation
   * must be bounded: an unreachable host with BatchMode=yes fails fast, but a
   * half-open connection can otherwise hang startup flows forever. Default is
   * 20s; callers can override for long-running jobs (installs).
   */
  timeoutMs?: number
}

const DEFAULT_SSH_TIMEOUT_MS = 20_000
const DEFAULT_SSH_INSTALL_TIMEOUT_MS = 15 * 60_000
const SSH_CONNECT_TIMEOUT_SECONDS = 8

export function parseSshTarget(raw: string): SshTarget | null {
  const value = (raw ?? "").trim()
  if (!value || /\s/.test(value)) return null

  // "user@host:2222"
  const userHostPort = value.match(/^([^@\s]+)@([^@\s:]+):(\d+)$/)
  if (userHostPort) {
    return { raw: value, user: userHostPort[1], host: userHostPort[2], port: Number.parseInt(userHostPort[3], 10) }
  }

  // "user@host"
  const userHost = value.match(/^([^@\s]+)@([^@\s]+)$/)
  if (userHost) {
    return { raw: value, user: userHost[1], host: userHost[2], port: null }
  }

  // "host:2222"
  const hostPort = value.match(/^([^@\s:]+):(\d+)$/)
  if (hostPort) {
    return { raw: value, user: null, host: hostPort[1], port: Number.parseInt(hostPort[2], 10) }
  }

  // "host" or a bare ~/.ssh/config alias — passed through as-is.
  return { raw: value, user: null, host: value, port: null }
}

export function sshDestination(target: SshTarget) {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/**
 * Build the local argv for an ssh invocation. The remote script is passed as a
 * single argv element; ssh hands it to the remote shell, so every value
 * interpolated into it must go through shellEscape. Nothing here is ever run
 * through a local shell.
 */
export function sshArgs(target: SshTarget, remoteScript?: string | null, extraArgs: string[] = []) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    ...extraArgs,
    ...(target.port ? ["-p", String(target.port)] : []),
    "--",
    sshDestination(target),
    ...(remoteScript ? [remoteScript] : []),
  ]
}

export function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Remote shell path that keeps `~` and `$HOME` expansion working: single
 * quotes suppress tilde expansion, so a leading `~` must stay unquoted and
 * only the remainder is escaped.
 */
export function remotePath(path: string) {
  if (path === "~") return "$HOME"
  if (path.startsWith("~/")) return `$HOME/${shellEscape(path.slice(2))}`
  return shellEscape(path)
}

export function runSsh(
  target: SshTarget,
  remoteScript: string | null,
  opts: RunSshOptions & { extraArgs?: string[] } = {},
): Promise<SshCommandResult> {
  return runCommand("ssh", sshArgs(target, remoteScript, opts.extraArgs ?? []), opts)
}

function runCommand(command: string, args: string[], opts: RunSshOptions): Promise<SshCommandResult> {
  return new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    })

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.once("error", (error) => {
      clearTimeout(timeoutId)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeoutId)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

export function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

export async function probeSshHost(target: SshTarget, opts?: RunSshOptions): Promise<{ reachable: boolean; error: string | null }> {
  const result = await runSsh(target, "true && printf ok", opts).catch((error) => ({
    code: 1,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }))
  if (result.code === 0 && result.stdout.includes("ok")) {
    return { reachable: true, error: null }
  }
  return {
    reachable: false,
    error: summarize(result.stderr || result.stdout) || `Cannot connect to ${target.raw}`,
  }
}

const OPENCODE_LOOKUP_SCRIPT = `
for candidate in "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" "/usr/local/bin/opencode" "/opt/homebrew/bin/opencode"; do
  if [ -x "$candidate" ]; then
    printf "%s\\n" "$candidate"
    exit 0
  fi
done
if command -v opencode >/dev/null 2>&1; then
  command -v opencode
  exit 0
fi
exit 1
`.trim()

export async function resolveRemoteOpencode(target: SshTarget, opts?: RunSshOptions): Promise<string | null> {
  const result = await runSsh(target, OPENCODE_LOOKUP_SCRIPT, opts)
  return result.code === 0 ? firstLine(result.stdout) : null
}

export async function readRemoteOpencodeVersion(target: SshTarget, path: string, opts?: RunSshOptions) {
  const result = await runSsh(target, `${shellEscape(path)} --version 2>/dev/null || true`, opts)
  return firstLine(result.stdout)
}

export function installRemoteOpencode(target: SshTarget, version: string, opts?: RunSshOptions) {
  const script = `curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}`
  return runSsh(target, script, withTimeout(opts, DEFAULT_SSH_INSTALL_TIMEOUT_MS))
}

const LIST_DIRECTORY_SCRIPT_PREFIX = "ls -1Ap -- "

export async function listRemoteDirectory(
  target: SshTarget,
  path: string,
  opts?: RunSshOptions,
): Promise<Array<{ name: string; path: string; kind: "directory" | "file" }>> {
  const result = await runSsh(target, `${LIST_DIRECTORY_SCRIPT_PREFIX}${remotePath(path)}`, opts)
  if (result.code !== 0) {
    throw new Error(summarize(result.stderr) || `Failed to list ${path} on ${target.raw}`)
  }
  return parseDirectoryListing(result.stdout, path)
}

export function parseDirectoryListing(stdout: string, basePath: string) {
  const base = basePath.replace(/\/+$/, "")
  return stdout
    .split(/\r?\n/g)
    .map((line) => {
      const isDirectory = line.endsWith("/")
      return { name: line.replace(/\/+$/, ""), isDirectory }
    })
    .filter(({ name }) => name.length > 0 && name !== "." && name !== "..")
    .map(({ name, isDirectory }) => {
      // `ls -1Ap` may render a leading path for odd entries; names only.
      const leaf = name.split("/").pop() ?? name
      return {
        name: leaf,
        path: `${base}/${leaf}`,
        kind: isDirectory ? ("directory" as const) : ("file" as const),
      }
    })
}

const DIRECTORY_NOT_FOUND_CODE = 3

export async function validateRemoteDirectory(target: SshTarget, path: string, opts?: RunSshOptions): Promise<string | null> {
  const escaped = remotePath(path)
  const script = `if [ -d ${escaped} ]; then cd ${escaped} && pwd -P; else exit ${DIRECTORY_NOT_FOUND_CODE}; fi`
  const result = await runSsh(target, script, opts)
  if (result.code === 0) {
    const canonical = firstLine(result.stdout)
    return canonical || null
  }
  if (result.code === DIRECTORY_NOT_FOUND_CODE) return null
  throw new Error(summarize(result.stderr) || `Failed to inspect ${path} on ${target.raw}`)
}

function firstLine(value: string) {
  return (
    value
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

function withTimeout(opts: RunSshOptions | undefined, timeoutMs: number): RunSshOptions {
  return {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? timeoutMs,
  }
}
