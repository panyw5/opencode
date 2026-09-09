const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
const DEFAULT_API_BASE = "https://api.bot.qq.com"

export type QQProbeResult = {
  accessToken: string
  gatewayUrl: string
}

type JsonObject = Record<string, unknown>

async function jsonRequest(url: string, init: RequestInit, signal?: AbortSignal): Promise<JsonObject> {
  const response = await fetch(url, { ...init, signal })
  const body = (await response.json().catch(() => undefined)) as JsonObject | undefined
  if (!response.ok || (body && typeof body.code === "number" && body.code !== 0)) {
    throw new Error(`QQ API ${response.status}: ${JSON.stringify(body)}`)
  }
  return body ?? {}
}

/** Validate official QQ credentials and Gateway discovery without opening a session. */
export async function probeQQ(
  appId: string,
  clientSecret: string,
  apiBaseUrl?: string,
  signal?: AbortSignal,
): Promise<QQProbeResult> {
  const tokenBody = await jsonRequest(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    },
    signal,
  )
  const accessToken = typeof tokenBody.access_token === "string" ? tokenBody.access_token : undefined
  if (!accessToken) throw new Error("QQ API did not return access_token")

  const base = (apiBaseUrl?.trim() || DEFAULT_API_BASE).replace(/\/$/, "")
  const gatewayBody = await jsonRequest(
    `${base}/gateway`,
    { headers: { Authorization: `QQBot ${accessToken}` } },
    signal,
  )
  const gatewayUrl = typeof gatewayBody.url === "string" ? gatewayBody.url : undefined
  if (!gatewayUrl) throw new Error("QQ API did not return gateway url")
  return { accessToken, gatewayUrl }
}
