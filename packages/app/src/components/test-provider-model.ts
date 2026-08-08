export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Wire protocol for the connectivity probe (mirrors custom-provider npm). */
export type TestProviderProtocol = "openai-chat" | "anthropic-messages"

export type TestProviderModelInput = {
  baseURL: string
  apiKey: string
  modelId: string
  /**
   * Custom provider npm package (e.g. `@ai-sdk/anthropic`).
   * Defaults to OpenAI-compatible chat completions.
   */
  npm?: string
  headers?: Array<{ key: string; value: string }>
  /** Defaults to platform fetch / global fetch */
  fetchImpl?: FetchLike
  /** Request timeout in ms (default 15000) */
  timeoutMs?: number
  /** Optional external abort (e.g. user cancel). Composed with the timeout. */
  signal?: AbortSignal
}

export type TestProviderModelResult =
  | {
      ok: true
      status: number
      latencyMs: number
      url: string
      preview?: string
    }
  | {
      ok: false
      status?: number
      latencyMs: number
      url?: string
      error: string
      preview?: string
      /** True when aborted by the caller's signal (not the probe timeout). */
      cancelled?: boolean
    }

export function resolveTestProtocol(npm?: string): TestProviderProtocol {
  const id = npm?.trim().toLowerCase() ?? ""
  if (id === "@ai-sdk/anthropic" || id.endsWith("/anthropic")) return "anthropic-messages"
  return "openai-chat"
}

/** Build OpenAI-compatible chat/completions URL from a provider baseURL. */
export function chatCompletionsUrl(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "")
  if (!base) return ""
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

/** Build Anthropic Messages API URL from a provider baseURL. */
export function anthropicMessagesUrl(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "")
  if (!base) return ""
  if (/\/messages$/i.test(base)) return base
  // If someone pasted a full OpenAI path by mistake, swap the suffix.
  if (/\/chat\/completions$/i.test(base)) {
    return base.replace(/\/chat\/completions$/i, "/messages")
  }
  return `${base}/messages`
}

export function testEndpointUrl(baseURL: string, protocol: TestProviderProtocol = "openai-chat"): string {
  return protocol === "anthropic-messages" ? anthropicMessagesUrl(baseURL) : chatCompletionsUrl(baseURL)
}

/** Minimal body for a connectivity / model-id smoke test (OpenAI chat). */
export function chatCompletionsTestBody(modelId: string) {
  return {
    model: modelId.trim(),
    messages: [{ role: "user" as const, content: "ping" }],
    max_tokens: 1,
    stream: false,
  }
}

/** Minimal body for Anthropic Messages API smoke test. */
export function anthropicMessagesTestBody(modelId: string) {
  return {
    model: modelId.trim(),
    messages: [{ role: "user" as const, content: "ping" }],
    max_tokens: 1,
  }
}

export function testRequestBody(modelId: string, protocol: TestProviderProtocol = "openai-chat") {
  return protocol === "anthropic-messages" ? anthropicMessagesTestBody(modelId) : chatCompletionsTestBody(modelId)
}

export function buildTestHeaders(input: {
  apiKey: string
  headers?: Array<{ key: string; value: string }>
  protocol?: TestProviderProtocol
}): Record<string, string> {
  const protocol = input.protocol ?? "openai-chat"
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const key = input.apiKey.trim()
  // Bare keys only — {env:VAR} cannot be resolved in the browser for a live curl.
  if (key && !/^\{env:[^}]+\}$/i.test(key)) {
    if (protocol === "anthropic-messages") {
      reqHeaders["x-api-key"] = key
      reqHeaders["anthropic-version"] = "2023-06-01"
    } else {
      reqHeaders.Authorization = `Bearer ${key}`
    }
  } else if (protocol === "anthropic-messages") {
    // Version header is required even when key is supplied via custom headers.
    reqHeaders["anthropic-version"] = "2023-06-01"
  }
  for (const h of input.headers ?? []) {
    const name = h.key.trim()
    const value = h.value.trim()
    if (name && value) reqHeaders[name] = value
  }
  return reqHeaders
}

function previewText(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

/**
 * Connectivity probe:
 * - OpenAI-compatible: POST {baseURL}/chat/completions
 * - Anthropic (`@ai-sdk/anthropic`): POST {baseURL}/messages with x-api-key
 */
export async function testProviderModel(input: TestProviderModelInput): Promise<TestProviderModelResult> {
  const modelId = input.modelId.trim()
  const protocol = resolveTestProtocol(input.npm)
  const url = testEndpointUrl(input.baseURL, protocol)
  const started = Date.now()

  if (!url) {
    return { ok: false, latencyMs: 0, error: "missing baseURL" }
  }
  if (!modelId) {
    return { ok: false, latencyMs: 0, error: "missing model id" }
  }

  if (input.signal?.aborted) {
    return { ok: false, latencyMs: 0, url, error: "cancelled", cancelled: true }
  }

  const doFetch = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  input.signal?.addEventListener("abort", onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: buildTestHeaders({ apiKey: input.apiKey, headers: input.headers, protocol }),
      body: JSON.stringify(testRequestBody(modelId, protocol)),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    let bodyText = ""
    try {
      bodyText = await res.text()
    } catch {
      bodyText = ""
    }
    const preview = bodyText ? previewText(bodyText) : undefined

    if (res.ok) {
      return { ok: true, status: res.status, latencyMs, url, preview }
    }

    return {
      ok: false,
      status: res.status,
      latencyMs,
      url,
      error: `HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ""}`,
      preview,
    }
  } catch (e) {
    const latencyMs = Date.now() - started
    if (e instanceof Error && e.name === "AbortError") {
      if (input.signal?.aborted) {
        return { ok: false, latencyMs, url, error: "cancelled", cancelled: true }
      }
      return { ok: false, latencyMs, url, error: `timeout after ${timeoutMs}ms` }
    }
    return {
      ok: false,
      latencyMs,
      url,
      error: e instanceof Error ? e.message : String(e),
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", onExternalAbort)
  }
}
