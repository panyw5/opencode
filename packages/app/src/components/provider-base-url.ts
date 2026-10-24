// SDKs that use the OpenAI-compatible /v1 endpoint by default.
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
  return V1_PACKAGES.has(npm?.trim().toLowerCase() || "")
}

export function hasProviderV1(value: string) {
  return /\/v1\/*$/.test(value.trim().split(/[?#]/, 1)[0])
}

export function stripProviderV1(value: string, npm?: string, autoV1 = true) {
  if (!autoV1 || !usesProviderV1(npm)) return value
  return value.trim().replace(/\/v1\/*(?=[?#]|$)/, "")
}

export function resolveProviderBaseURL(value: string, npm?: string, autoV1 = true) {
  const base = value.trim()
  if (!base || !autoV1 || !usesProviderV1(npm)) return base
  // Keep query parameters and fragments after the automatically supplied path.
  return stripProviderV1(base, npm, autoV1).replace(/\/*(?=[?#]|$)/, "/v1")
}

export function pasteProviderBaseURL(
  value: string,
  pasted: string,
  start: number,
  end: number,
  npm?: string,
  autoV1 = true,
) {
  const text = stripProviderV1(pasted, npm, autoV1)
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length }
}
