export type ModelIconItem = {
  id: string
  name?: string
  api?: {
    id?: string
    npm?: string
  }
  provider: {
    id: string
    name?: string
  }
}

const MODEL_PROVIDER_ICON_PREFIXES: Record<string, string> = {
  ai21: "ai21",
  alibaba: "alibaba",
  amazon: "amazon-bedrock",
  anthropic: "anthropic",
  azure: "azure",
  cerebras: "cerebras",
  claude: "anthropic",
  cloudflare: "cloudflare-workers-ai",
  cohere: "cohere",
  deepseek: "deepseek",
  fireworks: "fireworks-ai",
  gemini: "google",
  github: "github-copilot",
  google: "google",
  groq: "groq",
  huggingface: "huggingface",
  llama: "llama",
  meta: "llama",
  mistral: "mistral",
  moonshot: "moonshotai",
  nova: "amazon-bedrock",
  openai: "openai",
  perplexity: "perplexity",
  qwen: "alibaba",
  xai: "xai",
}

export function modelProviderIconID(item: ModelIconItem): string {
  const candidates = [item.api?.id, item.id, item.provider.id, item.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.toLowerCase().replace(/^hf:/, "").split(/[/.:-]/))
  for (const candidate of candidates) {
    const mapped = MODEL_PROVIDER_ICON_PREFIXES[candidate]
    if (mapped) return mapped
  }
  if (item.api?.npm === "@ai-sdk/anthropic") return "anthropic"
  if (item.api?.npm === "@ai-sdk/openai") return "openai"
  if (item.api?.npm === "@ai-sdk/google") return "google"
  if (item.api?.npm === "@ai-sdk/google-vertex") return "google-vertex"
  if (item.api?.npm === "@ai-sdk/amazon-bedrock") return "amazon-bedrock"
  if (item.api?.npm === "@openrouter/ai-sdk-provider") return "openrouter"
  if (item.api?.npm === "gitlab-ai-provider") return "gitlab"
  return item.provider.id
}
