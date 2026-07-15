import type { usePlatform } from "@/context/platform"
import type { useSDK } from "@/context/sdk"

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

function endpoint(sdk: SDK, path: string, query: Record<string, string | undefined>) {
  const url = new URL(path, sdk.url)
  url.searchParams.set("directory", sdk.directory)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

async function json<T>(platform: Platform, url: string, init?: RequestInit): Promise<T> {
  const run = platform.fetch ?? fetch
  const response = await run(url, init)
  if (!response.ok) throw new Error(`Background shell request failed: ${response.status}`)
  return (await response.json()) as T
}

export function listBackgroundShells(input: {
  sdk: SDK
  platform: Platform
  sessionID?: string
}): Promise<BackgroundShellInfo[]> {
  return json<BackgroundShellInfo[]>(
    input.platform,
    endpoint(input.sdk, "/background-shell", { sessionID: input.sessionID }),
  )
}

export function createBackgroundShell(input: {
  sdk: SDK
  platform: Platform
  payload: BackgroundShellCreateInput
}): Promise<BackgroundShellInfo> {
  return json<BackgroundShellInfo>(input.platform, endpoint(input.sdk, "/background-shell", {}), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.payload),
  })
}

export function setBackgroundShell(input: {
  sdk: SDK
  platform: Platform
  id: string
}): Promise<BackgroundShellInfo> {
  return json<BackgroundShellInfo>(
    input.platform,
    endpoint(input.sdk, `/background-shell/${encodeURIComponent(input.id)}/background`, {}),
    { method: "POST" },
  )
}
