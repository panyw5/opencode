import type { usePlatform } from "@/context/platform"
import type { useSDK } from "@/context/sdk"
import { authTokenFromCredentials } from "@/utils/server"

type SDK = ReturnType<typeof useSDK>
type Platform = ReturnType<typeof usePlatform>
type Auth = {
  username?: string
  password?: string
}

function endpoint(sdk: SDK, path: string) {
  const url = new URL(path, sdk.url)
  url.searchParams.set("directory", sdk.directory)
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
  console.info("[background-task-api] request", String(url), String(init?.method ?? "GET"))
  const response = await run(url, {
    ...init,
    headers: headers(init?.headers, auth),
  })
  const raw = await response.text()
  const contentType = response.headers.get("content-type") ?? ""
  console.info(
    "[background-task-api] response",
    String(response.status),
    contentType,
    `bodyLength=${raw.length}`,
  )

  if (!response.ok) {
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 180)
    throw new Error(
      snippet
        ? `Background task promote failed (${response.status}): ${snippet}`
        : `Background task promote failed (${response.status})`,
    )
  }

  // SPA/HTML fallbacks return 200 with <!doctype… — do not call response.json()
  // which throws "Unexpected token '<'" and was mislabeled as OpenClaw auth.
  if (contentType.includes("text/html") || /^\s*</.test(raw)) {
    throw new Error(
      "Background task promote returned HTML instead of JSON. The server may be outdated or missing POST /experimental/session/:id/background.",
    )
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(
      `Background task promote returned non-JSON body (${response.status}). Check that experimental background subagents are supported by this server.`,
    )
  }
}

/**
 * Promote foreground (blocking) subagent tasks for a parent session to
 * background. Returns true when at least one task job was promoted.
 * Requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS.
 */
export function backgroundSessionTasks(input: {
  sdk: SDK
  platform: Platform
  auth?: Auth
  sessionID: string
}): Promise<boolean> {
  return json<boolean>(
    input.platform,
    endpoint(input.sdk, `/experimental/session/${encodeURIComponent(input.sessionID)}/background`),
    { method: "POST" },
    input.auth,
  )
}
