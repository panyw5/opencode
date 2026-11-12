import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

/**
 * Handler for a single extension RPC method. Input validation is the
 * extension's responsibility; `ctx.signal` aborts when the requesting client
 * disconnects.
 */
export type RpcHandler = (input: unknown, ctx: { directory?: string; signal: AbortSignal }) => Promise<unknown>

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
