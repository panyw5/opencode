export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type TestProviderModelInput = {
  baseURL: string
  apiKey: string
  modelId: string
  headers?: Array<{ key: string; value: string }>
  /** Defaults to platform fetch / global fetch */
  fetchImpl?: FetchLike
  /** Request timeout in ms (default 15000) */
  timeoutMs?: number
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
    }

/** Build OpenAI-compatible chat/completions URL from a provider baseURL. */
export function chatCompletionsUrl(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "")
  if (!base) return ""
  if (/\/chat\/completions$/i.test(base)) return base
  return `${base}/chat/completions`
}

/** Minimal body for a connectivity / model-id smoke test. */
export function chatCompletionsTestBody(modelId: string) {
  return {
    model: modelId.trim(),
    messages: [{ role: "user" as const, content: "ping" }],
    max_tokens: 1,
    stream: false,
  }
}

export function buildTestHeaders(input: {
  apiKey: string
  headers?: Array<{ key: string; value: string }>
}): Record<string, string> {
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const key = input.apiKey.trim()
  // Bare keys only — {env:VAR} cannot be resolved in the browser for a live curl.
  if (key && !/^\{env:[^}]+\}$/i.test(key)) {
    reqHeaders.Authorization = `Bearer ${key}`
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
 * Simple OpenAI-compatible curl-style probe:
 * POST {baseURL}/chat/completions with the filled model id and max_tokens=1.
 */
export async function testProviderModel(input: TestProviderModelInput): Promise<TestProviderModelResult> {
  const modelId = input.modelId.trim()
  const url = chatCompletionsUrl(input.baseURL)
  const started = Date.now()

  if (!url) {
    return { ok: false, latencyMs: 0, error: "missing baseURL" }
  }
  if (!modelId) {
    return { ok: false, latencyMs: 0, error: "missing model id" }
  }

  const doFetch = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: buildTestHeaders({ apiKey: input.apiKey, headers: input.headers }),
      body: JSON.stringify(chatCompletionsTestBody(modelId)),
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
  }
}
