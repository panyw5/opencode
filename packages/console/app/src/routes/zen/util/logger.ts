import { Resource } from "@opencode-ai/console-resource"

const allowedMetricKeys = new Set([
  "is_stream",
  "has_session",
  "has_request",
  "has_client",
  "has_user_agent",
  "request_body_mode",
  "model.variant",
  "source",
  "provider",
  "provider.model",
  "llm.error.code",
  "response_length",
  "timestamp.last_byte",
  "time_to_first_byte",
  "timestamp.first_byte",
  "error.type",
  "model",
  "authenticated",
  "issubscription",
  "subscription",
  "tokens.input",
  "tokens.output",
  "tokens.reasoning",
  "tokens.cache_read",
  "tokens.cache_write_5m",
  "tokens.cache_write_1h",
  "cost.input.microcents",
  "cost.output.microcents",
  "cost.cache_read.microcents",
  "cost.cache_write.microcents",
  "cost.total.microcents",
  "cost.input",
  "cost.output",
  "cost.cache_read",
  "cost.cache_write_5m",
  "cost.cache_write_1h",
  "cost.total",
])

export function sanitizeMetric(values: Record<string, unknown>) {
  const result: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!allowedMetricKeys.has(key.toLowerCase())) continue
    if (typeof value === "string") {
      result[key] = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128)
      continue
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") result[key] = value
  }
  return result
}

export const logger = {
  metric: (values: Record<string, unknown>) => {
    const safe = sanitizeMetric(values)
    if (Object.keys(safe).length === 0) return
    console.log(`_metric:${JSON.stringify(safe)}`)
  },
  debug: (message: string) => {
    if (Resource.App.stage === "production") return
    console.debug(message)
  },
}
