import type { Info as SessionInfo } from "@/session/session"

export const MAX_RUNS_PER_SESSION = 30
export const MAX_TOKENS_PER_SESSION = 1_000_000

export function tokenCount(tokens: SessionInfo["tokens"]) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function evaluate(input: { runs: number; tokens: SessionInfo["tokens"] }) {
  const tokens = tokenCount(input.tokens)
  const reason = input.runs >= MAX_RUNS_PER_SESSION ? "runs" : tokens >= MAX_TOKENS_PER_SESSION ? "tokens" : undefined
  return { rotate: reason !== undefined, reason, runs: input.runs, tokens }
}

export * as ScheduledTaskRotation from "./rotation"
