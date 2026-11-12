import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Readable, Writable } from "node:stream"

/**
 * Handler for a single extension RPC method. Input validation is the
 * extension's responsibility; `ctx.signal` aborts when the requesting client
 * disconnects.
 */
export type RpcHandler = (input: unknown, ctx: { directory?: string; signal: AbortSignal }) => Promise<unknown>

/** stdio mode for one child stream; `"pipe"` exposes it on the ManagedProcess. */
export type ExtensionProcessStdio = "pipe" | "ignore" | "inherit"

export type ExtensionSpawnOptions = {
  /** Extra environment merged over the host process environment. */
  env?: Record<string, string | undefined>
  cwd?: string
  /** Per-stream behavior for [stdin, stdout, stderr]; defaults to `["ignore", "pipe", "pipe"]`. */
  stdio?: readonly [ExtensionProcessStdio, ExtensionProcessStdio, ExtensionProcessStdio]
}

/**
 * A child process spawned through {@link ExtensionHost.spawn}. It runs in its
 * own process group, so `kill` and generation teardown reap the whole tree —
 * grandchildren included. `onExit` is the only reliable completion signal;
 * a process that merely "should be dead" may still be running.
 */
export type ManagedProcess = {
  readonly pid: number | undefined
  /** Null unless the matching stdio entry is `"pipe"`. */
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /** Exit code once observed; null while running or when stopped by a signal. */
  readonly exitCode: number | null
  /** Signal that terminated the child, if any. */
  readonly exitSignal: string | null
  /** True once the child's exit has been observed (also true for failed spawns). */
  readonly exited: boolean
  /** True once termination was requested; the child may still be exiting. */
  readonly killed: boolean
  onExit(listener: (code: number | null, signal: string | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  /**
   * Signals the child's whole process group — SIGTERM/SIGKILL on POSIX,
   * `taskkill /T` on Windows. Fire-and-forget; observe `onExit` for the exit.
   */
  kill(signal?: "TERM" | "KILL"): void
}

/**
 * Process-level state returned by `activate()`. Lives for as long as the
 * extension is enabled; `dispose()` is called on disable, uninstall or server
 * exit.
 */
export type ExtensionService = {
  rpc?: Record<string, RpcHandler>
  dispose?: () => Promise<void>
}

/**
 * Process-level host services handed to `activate()`.
 */
export type ExtensionHost = {
  readonly id: string
  readonly version: string
  readonly dataDir: string
  readonly cacheDir: string
  readonly serverUrl: URL
  readonly settings: {
    get(): Record<string, unknown>
    onDidChange(listener: (next: Record<string, unknown>) => void): () => void
  }
  /** Generation-owned timers; returned promises are drained during quiesce. */
  setTimeout(callback: () => void | Promise<void>, delayMs: number): { dispose(): void }
  /** Repeats until disposed or the callback fails; async invocations may overlap. */
  setInterval(callback: () => void | Promise<void>, delayMs: number): { dispose(): void }
  /**
   * Spawns a child process owned by this host's generation. The child runs in
   * its own process group and is reaped automatically — SIGTERM, a grace
   * period, then SIGKILL — when the owning service or instance is disposed,
   * so extension children never outlive the extension. Throws when the host
   * is already disposed.
   */
  spawn(command: string, args?: string[], options?: ExtensionSpawnOptions): ManagedProcess
  emit(name: string, data: unknown, options?: { directory?: string }): void
  readonly log: Record<
    "debug" | "info" | "warn" | "error",
    (message: string, extra?: Record<string, string | number | boolean>) => void
  >
}

/**
 * Input for the instance-level `server()` hook. `input.extension.service` is
 * the process-level service once `activate()` has completed.
 */
export type ExtensionPluginInput = PluginInput & {
  extension: ExtensionHost & { service: ExtensionService | undefined }
}

/**
 * Instance-level hooks. Everything from the plugin `Hooks` contract plus the
 * fixed extension RPC channel.
 */
export type ExtensionHooks = Hooks & {
  rpc?: Record<string, RpcHandler>
}

/**
 * The default export shape of an extension server entry.
 */
export type ServerExtension = {
  id: string
  activate?: (host: ExtensionHost) => Promise<ExtensionService | void>
  server?: (input: ExtensionPluginInput, options?: PluginOptions) => Promise<ExtensionHooks>
}

/**
 * Identity helper for authoring extension server entries. It only pins types;
 * it is safe to bundle into the published server entry.
 */
export function defineServerExtension(extension: ServerExtension): ServerExtension {
  return extension
}
