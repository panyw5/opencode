import type { usePlatform } from "@/context/platform"
import type { useSDK } from "@/context/sdk"
import { authTokenFromCredentials } from "@/utils/server"

type SDK = ReturnType<typeof useSDK>
type Platform = ReturnType<typeof usePlatform>
type Auth = { username?: string; password?: string }

export type MathWorkerStatus = {
  sessionID: string
  project?: string
  parentSessionID?: string
  alive: boolean
  state: "running" | "stopping" | "blocked" | "dead" | "missing"
  pid?: number
  round?: number
  last_fact_id?: string
  last_rc?: number | null
  lastHeartbeatAt?: number
  attachable?: boolean
  restartable?: boolean
  stopRequested?: boolean
  transcriptUpdatedAt?: number
  model?: string
  variant?: string
  startedAt?: number
  cost?: number
  tokens?: number
  taskUpdatedAt?: number
  taskPreview?: string
  factCount?: number
  verificationCorrect?: number
  verificationWrong?: number
  verificationError?: number
  latestVerification?: string
  verifierModel?: string
  noProgressRounds?: number
  verificationErrorStreak?: number
  blockedReason?: string
  blockedAt?: number
  generation?: number
  blockedTaskFingerprint?: string
  lastOutcome?: "completed" | "blocked" | "failed" | "superseded"
  lastSummary?: string
}

export type MathDetailKind = "facts" | "correct" | "wrong" | "error"

export type MathVerificationReport = {
  summary: string
  criticalErrors: string[]
  gaps: string[]
}

export type MathFactDetail = {
  kind: "fact"
  id: string
  factId: string
  problemId: string
  author: string
  predecessors: string[]
  statement: string
  proof: string
  intuition?: string
  glossaryIntroduces: Record<string, string>
}

export type MathVerificationDetail = {
  kind: "correct" | "wrong" | "error"
  id: string
  timestamp: string
  workerSessionID?: string
  statement: string
  proof?: string
  evidence: string
  factId?: string
  writeError?: string
  error?: string
  report?: MathVerificationReport
}

export type MathDetailItem = MathFactDetail | MathVerificationDetail

export type MathDetailPage = {
  kind: MathDetailKind
  total: number
  offset: number
  limit: number
  items: MathDetailItem[]
}

export type MathWorkerTaskInfo = {
  sessionID: string
  project: string
  task: string
  updatedAt: number
}

function endpoint(sdk: SDK, path: string) {
  const url = new URL(path, sdk.url)
  url.searchParams.set("directory", sdk.directory)
  return url.toString()
}

async function request<T>(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  path: string
  init?: RequestInit
}): Promise<T> {
  const headers = new Headers(input.init?.headers)
  headers.set("accept", "application/json")
  if (input.init?.body) headers.set("content-type", "application/json")
  if (input.auth?.password) {
    headers.set(
      "authorization",
      `Basic ${authTokenFromCredentials({ username: input.auth.username, password: input.auth.password })}`,
    )
  }
  const run = input.platform.fetch ?? fetch
  const response = await run(endpoint(input.sdk, input.path), { ...input.init, headers })
  const raw = await response.text()
  if (!response.ok) throw new Error(`Math worker request failed (${response.status})`)
  if ((response.headers.get("content-type") ?? "").includes("text/html") || /^\s*</.test(raw)) {
    throw new Error("Math worker API is unavailable on this server")
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error("Math worker API returned invalid JSON")
  }
}

export function listMathWorkers(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
}): Promise<MathWorkerStatus[]> {
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers`,
  })
}

export function listMathDetails(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  project: string
  kind: MathDetailKind
  offset?: number
  limit?: number
}): Promise<MathDetailPage> {
  const query = new URLSearchParams({ project: input.project, kind: input.kind })
  if (input.offset !== undefined) query.set("offset", String(input.offset))
  if (input.limit !== undefined) query.set("limit", String(input.limit))
  console.debug(
    `[math-details] api request parent=${input.parentSessionID} project=${input.project} kind=${input.kind} offset=${input.offset ?? 0} limit=${input.limit ?? 20}`,
  )
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-details?${query.toString()}`,
  })
}

export function ensureMathWorker(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  workerSessionID: string
  project?: string
  reEnable?: boolean
  verifierModel?: string
}): Promise<MathWorkerStatus> {
  const query = input.project ? `?project=${encodeURIComponent(input.project)}` : ""
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/ensure${query}`,
    init: {
      method: "POST",
      body: JSON.stringify({ reEnable: input.reEnable ?? false, verifierModel: input.verifierModel }),
    },
  })
}

export function stopMathWorker(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  workerSessionID: string
  project?: string
  force?: boolean
}): Promise<MathWorkerStatus> {
  const query = input.project ? `?project=${encodeURIComponent(input.project)}` : ""
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/stop${query}`,
    init: { method: "POST", body: JSON.stringify({ force: input.force ?? false }) },
  })
}

export function getMathWorkerTask(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  workerSessionID: string
  project?: string
}): Promise<MathWorkerTaskInfo> {
  const query = input.project ? `?project=${encodeURIComponent(input.project)}` : ""
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/task${query}`,
  })
}

export function updateMathWorkerTask(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  workerSessionID: string
  project?: string
  task: string
}): Promise<MathWorkerTaskInfo> {
  const query = input.project ? `?project=${encodeURIComponent(input.project)}` : ""
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/task${query}`,
    init: { method: "PUT", body: JSON.stringify({ task: input.task }) },
  })
}
