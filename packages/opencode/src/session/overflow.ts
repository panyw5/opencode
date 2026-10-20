import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
export const DEFAULT_THRESHOLD = 0.9

export function usable(input: { cfg: Config.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // A larger generation allowance must not reserve the entire window and force endless compaction.
  const summaryOutput = Math.min(
    ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax, { kind: "compaction" }),
    context >= 2 * ProviderTransform.SUMMARY_OUTPUT_TOKEN_MAX ? context : Math.floor(context * 0.1),
  )
  const reserved = input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, summaryOutput)
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - summaryOutput)
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const limit = usable(input)
  const ratio = input.cfg.compaction?.threshold ?? DEFAULT_THRESHOLD
  const threshold = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : DEFAULT_THRESHOLD
  return count >= Math.floor(limit * threshold)
}
