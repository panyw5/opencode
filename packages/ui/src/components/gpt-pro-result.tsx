import { type GptProJob } from "@opencode-ai/util/gpt-pro"
import { gptProErrorText, gptProIssue, type GptProIssueCode } from "@opencode-ai/util/gpt-pro-error"
import { gptProStateStore } from "./gpt-pro-state"
import { gptProResultFinal, type GptProExecutionSnapshot } from "@opencode-ai/util/gpt-pro-state"
import type { GptProStateClient } from "@opencode-ai/util/gpt-pro-store"

export type GptProCachedResult = {
  id: string
  phase: "completed" | "cancelled" | "failed"
  url: string
  text?: string
  html?: string
  error?: string
  errorCode?: GptProIssueCode
  source: "read" | "output"
}

export type GptProViewResolution =
  | { kind: "cached"; result: GptProCachedResult }
  | { kind: "live"; job: GptProExecutionSnapshot }
  | { kind: "unavailable"; id: string; url?: string; error?: string; errorCode?: GptProIssueCode }

function finalPhase(value: unknown): value is GptProCachedResult["phase"] {
  return value === "completed" || value === "cancelled" || value === "failed"
}

function resultFromJob(job: GptProJob): GptProCachedResult {
  return {
    id: job.id,
    phase: job.phase as GptProCachedResult["phase"],
    url: job.url,
    text: job.text,
    html: job.html,
    error: job.error,
    errorCode: job.errorCode,
    source: "read",
  }
}

export function parseGptProOutputFallback(
  output: string | undefined,
  expectedID: string,
): GptProCachedResult | undefined {
  if (!output) return
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    const id = typeof value.consultation_id === "string" ? value.consultation_id : undefined
    if (!id || id !== expectedID || !finalPhase(value.phase)) return
    return {
      id,
      phase: value.phase,
      url: typeof value.url === "string" ? value.url : "",
      text:
        typeof value.text === "string"
          ? value.text
          : typeof value.partial_text === "string"
            ? value.partial_text
            : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
      html: typeof value.html === "string" ? value.html : undefined,
      source: "output",
    }
  } catch {
    return
  }
}

export async function resolveGptProView(
  client: GptProStateClient,
  id: string,
  output?: string,
): Promise<GptProViewResolution> {
  const store = gptProStateStore(client)
  const entry = await store.refresh(id)
  if (entry.freshness !== "current" || !entry.state)
    return { kind: "unavailable", id, error: entry.error, errorCode: "connection" }
  const current = entry.state.kind === "execution" ? entry.state.job : entry.state.result
  if (entry.state.kind === "execution" && !gptProResultFinal(current.phase))
    return { kind: "live", job: entry.state.job }
  try {
    const answer = await store.command({ action: "read", id: current.id })
    const latest = store.get(id)
    const selected = latest.state?.kind === "execution" ? latest.state.job : latest.state?.result
    if (latest.freshness !== "current" || !selected || selected.id !== answer.id || selected.phase !== answer.phase)
      return { kind: "unavailable", id: selected?.id ?? current.id, errorCode: "history_missing" }
    return { kind: "cached", result: resultFromJob(answer) }
  } catch (error) {
    const latest = await store.refresh(id)
    if (latest.freshness !== "current" || !latest.state)
      return {
        kind: "unavailable",
        id: current.id,
        error: gptProErrorText(error),
        errorCode: gptProIssue({ error })?.code ?? "unknown",
      }
    if (latest.state.kind === "execution" && !gptProResultFinal(latest.state.job.phase))
      return { kind: "live", job: latest.state.job }
    const selected = latest.state.kind === "execution" ? latest.state.job : latest.state.result
    const fallback = parseGptProOutputFallback(output, selected.id)
    return fallback && fallback.phase === selected.phase
      ? { kind: "cached", result: fallback }
      : {
          kind: "unavailable",
          id: selected.id,
          url: selected.url,
          error: gptProErrorText(error),
          errorCode: gptProIssue({ error })?.code ?? "unknown",
        }
  }
}
