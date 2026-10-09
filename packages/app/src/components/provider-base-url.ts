const V1_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/alibaba",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/xai",
  "@ai-sdk/togetherai",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
])

export function usesProviderV1(npm?: string) {
  return V1_PACKAGES.has(npm?.trim().toLowerCase() || "@ai-sdk/openai-compatible")
}

export function hasProviderV1(value: string) {
  return /\/v1\/*$/.test(value.trim().split(/[?#]/, 1)[0])
}

export function stripProviderV1(value: string, npm?: string) {
  if (!usesProviderV1(npm)) return value
  return value.trim().replace(/\/v1\/*(?=[?#]|$)/, "")
}

export function resolveProviderBaseURL(value: string, npm?: string) {
  const base = value.trim()
  if (!base || !usesProviderV1(npm)) return base
  // Keep query parameters and fragments after the automatically supplied path.
  return stripProviderV1(base, npm).replace(/\/*(?=[?#]|$)/, "/v1")
}

export function pasteProviderBaseURL(value: string, pasted: string, start: number, end: number, npm?: string) {
  const text = stripProviderV1(pasted, npm)
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length }
}
