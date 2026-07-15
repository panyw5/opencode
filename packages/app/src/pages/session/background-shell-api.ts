import type { usePlatform } from "@/context/platform"
import type { useSDK } from "@/context/sdk"
import { authTokenFromCredentials } from "@/utils/server"

export type BackgroundShellStatus = "running" | "completed" | "error" | "stopped"

export type BackgroundShellInfo = {
  id: string
  sessionID: string
  messageID?: string
  callID?: string
  ptyID: string
  command: string
  cwd: string
  description?: string
  status: BackgroundShellStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  outputTail?: string
}

export type BackgroundShellCreateInput = {
  sessionID: string
  messageID?: string
  callID?: string
  command: string
  cwd?: string
  description?: string
}

type SDK = ReturnType<typeof useSDK>
type Platform = ReturnType<typeof usePlatform>
type Auth = {
  username?: string
  password?: string
}

function endpoint(sdk: SDK, path: string, query: Record<string, string | undefined>) {
  const url = new URL(path, sdk.url)
  url.searchParams.set("directory", sdk.directory)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

function headers(init?: HeadersInit, auth?: Auth) {
  const result = new Headers(init)
  if (auth?.password) {
    result.set(
      "authorization",
      `Basic ${authTokenFromCredentials({ username: auth.username, password: auth.password })}`,
    )
  }
  return result
}

async function json<T>(platform: Platform, url: string, init?: RequestInit, auth?: Auth): Promise<T> {
  const run = platform.fetch ?? fetch
  const response = await run(url, {
    ...init,
    headers: headers(init?.headers, auth),
  })
  if (!response.ok) throw new Error(`Background shell request failed: ${response.status}`)
  return (await response.json()) as T
}

export function listBackgroundShells(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  sessionID?: string
}): Promise<BackgroundShellInfo[]> {
  return json<BackgroundShellInfo[]>(
    input.platform,
    endpoint(input.sdk, "/background-shell", { sessionID: input.sessionID }),
    undefined,
    input.auth,
  )
}

export function createBackgroundShell(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  payload: BackgroundShellCreateInput
}): Promise<BackgroundShellInfo> {
  return json<BackgroundShellInfo>(
    input.platform,
    endpoint(input.sdk, "/background-shell", {}),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.payload),
    },
    input.auth,
  )
}

export function setBackgroundShell(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  id: string
}): Promise<BackgroundShellInfo> {
  return json<BackgroundShellInfo>(
    input.platform,
    endpoint(input.sdk, `/background-shell/${encodeURIComponent(input.id)}/background`, {}),
    { method: "POST" },
    input.auth,
  )
}
