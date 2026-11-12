import type { ExtensionInfo as SdkExtensionInfo } from "@opencode-ai/sdk/v2/client"
import type { useGlobalSDK } from "@/context/global-sdk"
import { z } from "zod"
import type { ExtensionInfo } from "./types"

export type ExtensionApi = {
  list(): Promise<ExtensionInfo[]>
  // Toggles one extension's persisted `enabled` flag via the SDK and returns
  // the server's authoritative manifest for it. Validation errors (missing or
  // mismatched response fields, cross-origin assets) reject the promise; the
  // caller decides whether a follow-up sync is required.
  setEnabled(input: { id: string; enabled: boolean }): Promise<ExtensionInfo>
  retry(id: string): Promise<ExtensionInfo>
}

// Placeholder the server returns for configured secret values (see
// `packages/opencode/src/extension/registry.ts`). The plaintext never leaves
// the server registry; the web side treats the mask as "unchanged" and strips
// it from settings patches instead of echoing it back.
export const SECRET_MASK = "********"

export type ExtensionRpcOptions = {
  directory?: string
  signal?: AbortSignal
  timeoutMs?: number
}

function normalizeAssetURL(value: string, serverURL: string) {
  const server = new URL(serverURL)
  const url = new URL(value, server)
  if (url.origin !== server.origin) throw new Error(`Extension asset origin does not match server: ${url.origin}`)
  return url.toString()
}

function normalize(input: SdkExtensionInfo, serverURL: string): ExtensionInfo {
  return {
    ...input,
    revision: typeof input.revision === "number" && Number.isFinite(input.revision) ? input.revision : undefined,
    contributes: input.contributes as ExtensionInfo["contributes"],
    web: input.web
      ? {
          ...input.web,
          base: normalizeAssetURL(input.web.base, serverURL),
          styles: input.web.styles.map((style) => normalizeAssetURL(style, serverURL)),
        }
      : undefined,
  }
}

// The generated SDK client resolves failed requests into `result.error` (a
// parsed body, not necessarily an `Error`) unless the caller opts into
// `throwOnError`. Extract the most useful message the server offered.
function sdkErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const body = error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
    if (typeof body.data?.message === "string" && body.data.message) return body.data.message
    if (typeof body.message === "string" && body.message) return body.message
    if (typeof body.name === "string" && body.name) return body.name
  }
  if (typeof error === "string" && error) return error
  return "unknown error"
}

export function createExtensionApi(input: { globalSDK: ReturnType<typeof useGlobalSDK> }): ExtensionApi {
  return {
    async list() {
      const serverURL = input.globalSDK.url
      const client = input.globalSDK.client
      const result = await client.extension.list()
      if (!Array.isArray(result.data)) throw new Error("Extension manifest response is unavailable")
      // Per-item fault tolerance: one malformed or cross-origin manifest must
      // not take down the whole list, so invalid entries are dropped with a
      // warning instead of failing the refresh for every extension.
      const manifests: ExtensionInfo[] = []
      for (const item of result.data) {
        try {
          manifests.push(normalize(item, serverURL))
        } catch (error) {
          const id =
            typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : "unknown"
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[extension-host] skipping invalid extension manifest id=${id} error=${message}`)
        }
      }
      return manifests
    },
    async retry(id) {
      const serverURL = input.globalSDK.url
      const client = input.globalSDK.client
      const result = await client.extension.retry({ id })
      if (result.error) throw new Error(`Extension retry failed: ${sdkErrorMessage(result.error)}`)
      const data = result.data
      if (!data || typeof data !== "object") throw new Error(`Extension retry response is unavailable: ${id}`)
      if (data.id !== id) throw new Error(`Extension retry response id mismatch: expected ${id} got ${String(data.id)}`)
      if (!data.enabled || data.server?.needsRestart || data.server?.runtime === "blocked") {
        throw new Error(`Extension retry is unavailable; enable the extension or restart OpenCode: ${id}`)
      }
      return normalize(data, serverURL)
    },
    async setEnabled({ id, enabled }) {
      // Capture the connection up front so the request and the response
      // validation below both refer to the same server, even if the app
      // switches servers while the call is in flight.
      const serverURL = input.globalSDK.url
      const client = input.globalSDK.client
      const action = enabled ? "enable" : "disable"
      const result = enabled ? await client.extension.enable({ id }) : await client.extension.disable({ id })
      if (result.error) throw new Error(`Extension ${action} failed: ${sdkErrorMessage(result.error)}`)
      const data = result.data
      if (!data || typeof data !== "object") {
        throw new Error(`Extension ${action} response is unavailable: ${id}`)
      }
      if (data.id !== id) {
        throw new Error(`Extension ${action} response id mismatch: expected ${id} got ${String(data.id)}`)
      }
      if (data.enabled !== enabled) {
        throw new Error(`Extension ${action} response enabled mismatch: ${id}`)
      }
      // The registry reports state per manifest health, not toggle success: a
      // readable manifest is "ready" when enabled and "disabled" when not,
      // while a broken one stays "error"/"incompatible" with `enabled` flipped
      // (the toggle still persisted). Only an unknown state is a protocol
      // violation, so the host and UI can decide what "ready" means for them.
      if (
        data.state !== "ready" &&
        data.state !== "disabled" &&
        data.state !== "error" &&
        data.state !== "incompatible"
      ) {
        throw new Error(`Extension ${action} response state is invalid: ${id}`)
      }
      // Same-origin asset normalization applies to toggle responses too: a
      // cross-origin manifest must not reach the host just because it arrived
      // through a mutation instead of a refresh.
      return normalize(data, serverURL)
    },
  }
}

// Authenticated transport for the P2 extension bridge endpoints. The generated
// SDK client has no typed routes for them yet, so requests go through the
// host's fetch with the same connection credentials the SDK uses. Headers come
// from the current server connection (never hand-assembled credentials beyond
// the Basic token the app already derives in `utils/server.ts`).
export type ExtensionBridgeDeps = {
  serverURL(): string
  headers(): Record<string, string>
  fetch?: typeof fetch
  // Test/harness seam for the client-side timeout fallback. Production uses
  // DEFAULT_RPC_TIMEOUT_MS.
  defaultTimeoutMs?: number
}

export type ExtensionBridge = {
  rpc(input: { extensionID: string; method: string; input?: unknown; options?: ExtensionRpcOptions }): Promise<unknown>
  updateSettings(input: { extensionID: string; patch: Record<string, unknown> }): Promise<Record<string, unknown>>
}

// Client-side fallback for extension RPCs: the server enforces its own budget
// via the `x-opencode-rpc-timeout` header, but a client that waits forever on
// a hung server is still broken, so an rpc without an explicit timeout gets a
// client-side deadline too.
export const DEFAULT_RPC_TIMEOUT_MS = 30_000

// Resolves the effective client-side deadline for one rpc call. An omitted
// timeout falls back to the client default; a negative or non-finite timeout
// is rejected outright instead of being silently clamped to a bogus header
// value.
export function resolveRpcTimeoutMs(timeoutMs: number | undefined, fallback = DEFAULT_RPC_TIMEOUT_MS): number {
  if (timeoutMs === undefined) return fallback
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Extension RPC timeout must be a positive number of milliseconds: ${String(timeoutMs)}`)
  }
  return Math.round(timeoutMs)
}

// Merges the caller's abort signal with a client-side timeout deadline so
// either one aborts the request. The returned disposer clears the timer and
// detaches the relay listener once the call settles, so a completed call never
// leaks a pending abort.
export function mergeAbortSignalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  message: string,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return
    controller.abort(reason)
  }
  const onAbort = () => abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abort(signal.reason)
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => abort(new Error(message)), timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

function serverError(response: Response, fallback: string) {
  return response
    .json()
    .then((body: unknown) => {
      const message = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined
      return `${fallback} (${response.status}${typeof message === "string" ? `: ${message}` : ""})`
    })
    .catch(() => `${fallback} (${response.status})`)
}

export function createExtensionBridge(deps: ExtensionBridgeDeps): ExtensionBridge {
  const request = async (
    url: URL,
    init: { method: "POST" | "PATCH"; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
  ) => {
    const response = await (deps.fetch ?? fetch)(url, {
      method: init.method,
      headers: {
        ...deps.headers(),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    })
    if (!response.ok) throw new Error(await serverError(response, `Extension request failed`))
    const text = await response.text()
    if (!text) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`Extension request returned invalid JSON (${response.status})`)
    }
  }

  return {
    async rpc({ extensionID, method, input, options }) {
      const url = new URL(
        `/extension/${encodeURIComponent(extensionID)}/rpc/${encodeURIComponent(method)}`,
        `${deps.serverURL().replace(/\/+$/, "")}/`,
      )
      if (options?.directory) url.searchParams.set("directory", options.directory)
      // Reject invalid timeouts before touching the network, and always give
      // the request a client-side deadline (explicit or default fallback).
      const timeoutMs = resolveRpcTimeoutMs(options?.timeoutMs, deps.defaultTimeoutMs)
      const headers: Record<string, string> = { "x-opencode-rpc-timeout": String(timeoutMs) }
      const abort = mergeAbortSignalWithTimeout(
        options?.signal,
        timeoutMs,
        `Extension RPC timed out after ${String(timeoutMs)}ms: ${extensionID}.${method}`,
      )
      try {
        const payload = await request(url, { method: "POST", body: { input }, headers, signal: abort.signal })
        if (typeof payload !== "object" || payload === null || !("result" in payload)) {
          throw new Error(`Extension RPC response is unavailable: ${extensionID}.${method}`)
        }
        return (payload as { result: unknown }).result
      } finally {
        abort.dispose()
      }
    },
    async updateSettings({ extensionID, patch }) {
      // Secrets travel masked; the mask means "keep the stored value", so it is
      // stripped here as well — the web side never reads (or echoes) plaintext.
      const sanitized: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (value === SECRET_MASK) continue
        sanitized[key] = value
      }
      const url = new URL(
        `/global/extension/${encodeURIComponent(extensionID)}/settings`,
        `${deps.serverURL().replace(/\/+$/, "")}/`,
      )
      const payload = await request(url, { method: "PATCH", body: sanitized })
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof (payload as { settings?: unknown }).settings !== "object"
      ) {
        throw new Error(`Extension settings response is unavailable: ${extensionID}`)
      }
      return (payload as { settings: Record<string, unknown> }).settings
    },
  }
}

const extensionEventProperties = z.object({
  id: z.string(),
  name: z.string(),
  data: z.unknown(),
})

// Guard for `extension.event` payloads arriving over the global event stream.
// Everything that is not an extension event is ignored silently; a payload
// claiming to be one but failing the shape check is dropped with a warning.
export function parseExtensionEvent(payload: unknown): { id: string; name: string; data: unknown } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  if ((payload as { type?: unknown }).type !== "extension.event") return undefined
  const result = extensionEventProperties.safeParse((payload as { properties?: unknown }).properties)
  if (!result.success) {
    console.warn("[extension-host] dropped malformed extension.event payload")
    return undefined
  }
  return result.data
}

// Events reach the web side multiplexed inside `extension.event`. A listener is
// a dedicated `listenAll` subscription filtered by extension id and event name,
// and by the server the extension was loaded from: events from another server
// (extra-agent domain) never reach it. The bus routing key doubles as the
// directory: global events publish as "global" (no directory), instance events
// carry the instance directory in `meta.directory`.
export type ExtensionEventSource = {
  url: string
  listenAll(listener: (event: { name: string; details: unknown; domain: string }) => void): () => void
  forDomain(domain: string): { url: string }
}

export function listenExtensionEvents(input: {
  extensionID: string
  name: string
  listener: (data: unknown, meta: { directory?: string }) => void
  source: ExtensionEventSource
}): () => void {
  return input.source.listenAll((event) => {
    let serverURL: string | undefined
    try {
      serverURL = input.source.forDomain(event.domain).url
    } catch {
      return
    }
    if (serverURL !== input.source.url) return
    const parsed = parseExtensionEvent(event.details)
    if (!parsed) return
    if (parsed.id !== input.extensionID) return
    if (parsed.name !== input.name) return
    try {
      input.listener(parsed.data, { directory: event.name === "global" ? undefined : event.name })
    } catch (error) {
      console.warn(
        `[extension-host] event listener failed id=${input.extensionID} name=${input.name} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}
