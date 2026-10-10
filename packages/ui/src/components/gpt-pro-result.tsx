import { gptProTerminal, type GptProAPI, type GptProJob } from "@opencode-ai/util/gpt-pro"

export type GptProCachedResult = {
  id: string
  phase: "completed" | "cancelled" | "failed"
  url: string
  text?: string
  error?: string
  source: "read" | "output"
}

export type GptProViewResolution =
  | { kind: "cached"; result: GptProCachedResult }
  | { kind: "live"; job: GptProJob }
  | { kind: "unavailable"; id: string; url?: string }

function finalPhase(value: unknown): value is GptProCachedResult["phase"] {
  return value === "completed" || value === "cancelled" || value === "failed"
}

function resultFromJob(job: GptProJob): GptProCachedResult {
  return {
    id: job.id,
    phase: job.phase as GptProCachedResult["phase"],
    url: job.url,
    text: job.text,
    error: job.error,
    source: "read",
  }
}

export function parseGptProOutputFallback(output: string | undefined, expectedID: string): GptProCachedResult | undefined {
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
      source: "output",
    }
  } catch {
    return
  }
}

export async function resolveGptProView(
  client: Pick<GptProAPI, "command">,
  id: string,
  output?: string,
): Promise<GptProViewResolution> {
  let current: GptProJob
  try {
    // Read is successor-aware and preserves the full answer; never build a result from list/status text.
    current = await client.command({ action: "read", id })
  } catch {
    let currentID = id
    let url: string | undefined
    try {
      const status = await client.command({ action: "status", id })
      currentID = status.id
      url = status.url
      if (!finalPhase(status.phase)) return { kind: "live", job: status }
    } catch {
      const fallback = parseGptProOutputFallback(output, id)
      return fallback ? { kind: "cached", result: fallback } : { kind: "unavailable", id }
    }
    const fallback = parseGptProOutputFallback(output, currentID)
    return fallback ? { kind: "cached", result: fallback } : { kind: "unavailable", id: currentID, url }
  }
  if (!gptProTerminal(current.phase) || !finalPhase(current.phase)) return { kind: "live", job: current }
  return { kind: "cached", result: resultFromJob(current) }
}
