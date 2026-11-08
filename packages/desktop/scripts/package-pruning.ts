// These packages ship JavaScript entry points; their TypeScript sources are
// development inputs, not runtime modules. Keep source-exporting packages out.
const sdkSources = [
  "@ai-sdk/alibaba",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/deepgram",
  "@ai-sdk/deepinfra",
  "@ai-sdk/deepseek",
  "@ai-sdk/elevenlabs",
  "@ai-sdk/fireworks",
  "@ai-sdk/gateway",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/perplexity",
  "@ai-sdk/provider",
  "@ai-sdk/provider-utils",
  "@ai-sdk/togetherai",
  "@ai-sdk/vercel",
  "@ai-sdk/xai",
  "@anthropic-ai/sdk",
  "openai",
  "ai-gateway-provider",
  "venice-ai-sdk-provider",
]

export const packagePruningPatterns = [
  "!**/node_modules/**/*.{d.ts,d.mts,d.cts}",
  "!node_modules/@opencode-ai/core/node_modules/**/*",
  ...sdkSources.map((name) => `!**/node_modules/${name}/src/**/*`),
]

export function isPrunedPackagePath(file: string) {
  if (!file.startsWith("node_modules/")) return false
  if (/\.d\.(ts|mts|cts)$/.test(file)) return true
  if (file.startsWith("node_modules/@opencode-ai/core/node_modules/")) return true
  return sdkSources.some((name) => file.includes(`node_modules/${name}/src/`))
}
