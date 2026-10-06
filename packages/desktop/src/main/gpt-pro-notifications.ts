import type { GptProJob, GptProNotification } from "@opencode-ai/util/gpt-pro"

const LIMIT = 20_000
const alertPhases = new Set(["completed", "paused", "cancelled", "failed", "interrupted", "send_uncertain"])

export function collectGptProNotification(
  job: GptProJob,
  now: number,
  intervalMs: number,
): GptProNotification | undefined {
  if (!job.background && !(job.recovery && job.owner.includes("\n"))) return
  const alert = alertPhases.has(job.phase)
  const text = job.text ?? ""
  if (alert) {
    if (job.notificationPhase === job.phase) return
  } else {
    job.notificationPhase = job.phase
    if (job.phase !== "generating" || !text || text === job.notificationText) return
    if (now - (job.notificationAt ?? job.createdAt) < intervalMs) return
  }
  const previous = job.notificationText ?? ""
  const append = !alert && previous.length > 0 && text.startsWith(previous)
  const content = append ? text.slice(previous.length) : text
  const sequence = (job.notificationSequence ?? 0) + 1
  const event: GptProNotification = {
    id: `${job.id}:notification:${sequence}`,
    consultationID: job.id,
    owner: job.owner,
    phase: job.phase,
    revision: job.revision,
    at: now,
    url: job.url,
    kind: job.phase === "completed" ? "completed" : alert ? "state" : "progress",
    format: append ? "append" : "snapshot",
    text: content.slice(0, LIMIT),
    truncated: content.length > LIMIT,
    error: job.error,
    recovery: job.recovery,
  }
  job.notificationSequence = sequence
  job.notificationAt = now
  job.notificationText = text
  job.notificationPhase = job.phase
  ;(job.notifications ??= []).push(event)
  return event
}
