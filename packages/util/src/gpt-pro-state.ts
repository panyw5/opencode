import type { GptProJob, GptProPhase } from "./gpt-pro"
import { gptProCanResume, type GptProIssueCode } from "./gpt-pro-error"

export type GptProExecutionSnapshot = {
  id: string
  owner: string
  parentID: string | null
  successorID: string | null
  pageID: string | null
  ownerPage: GptProJob["ownerPage"] | null
  stateVersion: number
  phase: GptProPhase
  prompt: string
  url: string
  model: string | null
  createdAt: number
  updatedAt: number
  error: string | null
  errorCode: GptProIssueCode | null
  recovery: GptProJob["recovery"] | null
  queueReason: GptProJob["queueReason"] | null
  queueOwnerConsultationID: string | null
  submitted: boolean
  sendAttempted: boolean
  userID: string | null
  stopPending: boolean
  background: boolean
  attachments: Array<{ id: string; name: string; mime: string; status: string; error: string | null }>
}

export type GptProArchivedResult = {
  id: string
  owner: string
  phase: "completed" | "failed" | "cancelled"
  url: string
  model: string | null
  updatedAt: number
  error: string | null
  errorCode: GptProIssueCode | null
}

export type GptProHistoricalSnapshot = {
  kind: "historical"
  id?: string
  phase?: string
  url?: string
  error?: string
}

export type GptProState =
  | { kind: "execution"; job: GptProExecutionSnapshot }
  | { kind: "archive"; result: GptProArchivedResult }

export type GptProStateResponse = {
  sourceID: string
  sequence: number
  requestedID: string
  state: GptProState
}

export type GptProStateEvent =
  | {
      type: "snapshot" | "change"
      sourceID: string
      sequence: number
      jobs: GptProExecutionSnapshot[]
      removed: string[]
    }
  | { type: "disconnected"; message: string }

export type GptProStateAPI = {
  read(id: string): Promise<GptProStateResponse>
  list(): Promise<Extract<GptProStateEvent, { sourceID: string }>>
  subscribe(listener: (event: GptProStateEvent) => void): () => void
}

export function gptProExecutionSnapshot(job: GptProJob): GptProExecutionSnapshot {
  return {
    id: job.id,
    owner: job.owner,
    parentID: job.parentID ?? null,
    successorID: job.successorID ?? null,
    pageID: job.pageID ?? null,
    ownerPage: job.ownerPage ? { ...job.ownerPage } : null,
    stateVersion: job.stateVersion ?? 0,
    phase: job.phase,
    prompt: job.prompt.slice(0, 160),
    url: job.url,
    model: job.model ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
    errorCode: job.errorCode ?? null,
    recovery: job.recovery ? { ...job.recovery } : null,
    queueReason: job.queueReason ?? null,
    queueOwnerConsultationID: job.queueOwnerConsultationID ?? null,
    submitted: job.submitted === true,
    sendAttempted: job.sendAttempted === true || job.submitted === true,
    userID: job.userID ?? null,
    stopPending: job.stopPending === true,
    background: job.background === true,
    attachments: (job.attachments ?? []).map(({ id, name, mime, status, error }) => ({
      id,
      name,
      mime,
      status,
      error: error ?? null,
    })),
  }
}

export function gptProArchivedResult(job: GptProJob): GptProArchivedResult {
  if (!gptProResultFinal(job.phase)) throw new Error("A non-final consultation cannot be an archived result")
  return {
    id: job.id,
    owner: job.owner,
    phase: job.phase,
    url: job.url,
    model: job.model ?? null,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
    errorCode: job.errorCode ?? null,
  }
}

export function gptProResultFinal(phase: string): phase is GptProArchivedResult["phase"] {
  return phase === "completed" || phase === "failed" || phase === "cancelled"
}

export function gptProCapabilities(state: GptProState | undefined, current: boolean) {
  const job = current && state?.kind === "execution" ? state.job : undefined
  return {
    view: !!state,
    background: !!job && ["queued", "preparing", "sending", "generating"].includes(job.phase) && !job.background,
    pause: !!job && ["preparing", "sending", "generating"].includes(job.phase),
    stop: !!job && ["queued", "preparing", "sending", "generating", "paused"].includes(job.phase),
    resume:
      !!job &&
      gptProCanResume({
        phase: job.phase,
        error: job.error,
        code: job.errorCode,
        sendAttempted: job.sendAttempted,
        submitted: job.submitted,
        userID: job.userID ?? undefined,
      }),
  }
}
