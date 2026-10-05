export const GPT_PRO_PARTITION = "persist:consult-gpt-pro"
export const GPT_PRO_URL = "https://chatgpt.com/"
export const GPT_PRO_MAX_HTML_CHARS = 1_000_000

export type GptProPageState = {
  url: string
  model: string
  targetModel: boolean
  composer: boolean
  draft: string
  generating: boolean
  sendReady?: boolean
  error?: { kind: "verification" | "request"; message: string }
  revision: number
  users: Array<{ id: string; text: string }>
  answer?: {
    id: string
    userID: string
    text: string
    html: string
    complete: boolean
    truncated: boolean
  }
}

export type GptProProbeStatus = {
  phase: "not_open" | "loading" | "needs_login" | "needs_model" | "ready" | "tracking" | "completed" | "blocked"
  partition: string
  page?: GptProPageState
  detail?: string
}

/** P0 diagnostics only; no unattended consultation is exposed yet. */
export type GptProAPI = {
  open(): Promise<GptProProbeStatus>
  status(): Promise<GptProProbeStatus>
  loginInBrowser(): Promise<GptProLoginStatus>
  loginStatus(): Promise<GptProLoginStatus>
  cancelLogin(): Promise<GptProLoginStatus>
  getConfig(): Promise<GptProConfig>
  setConfig(config: GptProConfig): Promise<GptProConfig>
  command(input: GptProCommand): Promise<GptProJob>
  list(): Promise<GptProJob[]>
}

export type GptProConfig = { enabled: boolean; timeoutMinutes: number; progressIntervalSeconds?: number }
export const DEFAULT_GPT_PRO_CONFIG: GptProConfig = { enabled: false, timeoutMinutes: 30 }
export type GptProAction =
  | "consult"
  | "status"
  | "read"
  | "open"
  | "stop"
  | "pause"
  | "resume"
  | "intervene"
  | "background"
export type GptProCommand = {
  action?: GptProAction
  id?: string
  prompt?: string
  requestID?: string
  background?: boolean
}
export type GptProNotification = {
  id: string
  consultationID: string
  owner: string
  phase: GptProPhase
  revision: number
  at: number
  url: string
  kind: "progress" | "completed" | "state"
  format: "append" | "snapshot"
  text: string
  truncated: boolean
  error?: string
}
export type GptProPhase =
  | "queued"
  | "preparing"
  | "sending"
  | "generating"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "send_uncertain"
export type GptProJob = {
  id: string
  owner: string
  requestID: string
  parentID?: string
  successorID?: string
  phase: GptProPhase
  prompt: string
  url: string
  createdAt: number
  updatedAt: number
  submitted: boolean
  userID?: string
  userCount?: number
  model?: string
  text?: string
  html?: string
  revision: number
  error?: string
  background?: boolean
  notifications?: GptProNotification[]
  notificationSequence?: number
  notificationAt?: number
  notificationText?: string
  notificationPhase?: GptProPhase
}
export const gptProTerminal = (phase: GptProPhase) =>
  ["completed", "cancelled", "failed", "interrupted", "send_uncertain", "paused"].includes(phase)
export function normalizeGptProConfig(config: Partial<GptProConfig>): GptProConfig {
  return {
    enabled: config.enabled === true,
    timeoutMinutes: Number.isFinite(config.timeoutMinutes)
      ? Math.min(60, Math.max(1, Math.round(config.timeoutMinutes!)))
      : 30,
    progressIntervalSeconds: Number.isFinite(config.progressIntervalSeconds)
      ? Math.min(600, Math.max(10, Math.round(config.progressIntervalSeconds!)))
      : 60,
  }
}

export type GptProLoginStatus = {
  phase: "idle" | "waiting" | "importing" | "imported" | "expired" | "cancelled" | "failed"
  expiresAt?: number
  importedCookies?: number
  extensionDirectory?: string
  error?: string
}

export function isGpt6ProLabel(label: string) {
  return /\bGPT[\s-]*6[\s-]+Pro\b/i.test(label.trim())
}

export function isGptProOrigin(url: string) {
  try {
    return new URL(url).origin === new URL(GPT_PRO_URL).origin
  } catch {
    return false
  }
}
