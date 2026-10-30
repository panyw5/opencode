import { createHash } from "node:crypto"
import type { BrowserCdp } from "./browser-cdp"

export type GptProAuthentication = {
  phase: "authenticated" | "needs_login" | "unknown"
  account?: string
  accountID?: string
  detail?: string
  retryAfterMs?: number
}

type AuthenticationEvidence = {
  phase: GptProAuthentication["phase"]
  identity?: string
  account?: string
  reason?: string
  status?: number
  retryAfterMs?: number
}

export const GPT_PRO_LOGIN_EXPIRED_DETAIL =
  "ChatGPT could not refresh this login session. Reconnect ChatGPT using the browser login import; no question was resent."

// Return only identity metadata across CDP. Access tokens and session JSON never leave the page.
const expression = `(async () => {
  if (location.origin !== 'https://chatgpt.com') return {phase:'unknown',reason:'origin'}
  try {
    const response = await fetch('/api/auth/session', {credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000)})
    if (response.status === 401) return {phase:'needs_login',reason:'unauthorized',status:response.status}
    if (!response.ok) {
      const retry = response.headers?.get('Retry-After')
      const seconds = retry && /^\\d+(?:\\.\\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now()
      return {phase:'unknown',reason:'http',status:response.status,retryAfterMs:Number.isFinite(seconds) ? Math.max(0,seconds) : undefined}
    }
    const data = await response.json()
    // A failed refresh still includes the OLD user and access token.
    if (data?.error) return {phase:data.error === 'RefreshAccessTokenError' ? 'needs_login' : 'unknown',reason:data.error === 'RefreshAccessTokenError' ? 'refresh_failed' : 'session_error',status:response.status}
    if (typeof data?.expires === 'string' && Date.parse(data.expires) <= Date.now()) return {phase:'needs_login',reason:'expired',status:response.status}
    const identity = data?.user?.id || data?.user?.email
    if (typeof identity !== 'string' || !identity) return {phase:'needs_login',reason:'missing_identity',status:response.status}
    return {phase:'authenticated',reason:'session',status:response.status,identity,account:typeof data.user.email === 'string' ? data.user.email : undefined}
  } catch (error) { return {phase:'unknown',reason:error?.name === 'TimeoutError' ? 'timeout' : 'fetch'} }
})()`

export async function readGptProAuthentication(
  cdp: Pick<BrowserCdp, "evaluate">,
  log: (message: string) => void = () => {},
): Promise<GptProAuthentication> {
  let value: AuthenticationEvidence
  try {
    value = await cdp.evaluate<AuthenticationEvidence>(expression)
  } catch {
    value = { phase: "unknown", reason: "evaluation" }
  }
  log(
    `authentication check phase=${value.phase} reason=${value.reason ?? "unknown"} status=${value.status ?? "none"}; identity and credentials omitted`,
  )
  if (value.phase === "authenticated" && value.identity)
    return {
      phase: "authenticated",
      accountID: createHash("sha256").update(value.identity).digest("hex"),
      account: value.account?.slice(0, 200),
    }
  if (value.phase === "needs_login")
    return {
      phase: "needs_login",
      ...(["refresh_failed", "expired"].includes(value.reason ?? "")
        ? { detail: GPT_PRO_LOGIN_EXPIRED_DETAIL }
        : {}),
    }
  return { phase: "unknown", ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }) }
}
