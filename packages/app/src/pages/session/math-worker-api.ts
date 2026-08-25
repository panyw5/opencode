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
  state: "running" | "stopping" | "dead" | "missing"
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

export function ensureMathWorker(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  parentSessionID: string
  workerSessionID: string
  project?: string
}): Promise<MathWorkerStatus> {
  const query = input.project ? `?project=${encodeURIComponent(input.project)}` : ""
  return request({
    ...input,
    path: `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/ensure${query}`,
    init: { method: "POST", body: "{}" },
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
