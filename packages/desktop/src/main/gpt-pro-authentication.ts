import { createHash } from "node:crypto"
import type { BrowserCdp } from "./browser-cdp"

export type GptProAuthentication = {
  phase: "authenticated" | "needs_login" | "unknown"
  account?: string
  accountID?: string
}

// Return only identity metadata across CDP. Access tokens and session JSON never leave the page.
const expression = `(async () => {
  if (location.origin !== 'https://chatgpt.com') return {phase:'unknown'}
  try {
    const response = await fetch('/api/auth/session', {credentials:'include',cache:'no-store',signal:AbortSignal.timeout(8000)})
    if (response.status === 401) return {phase:'needs_login'}
    if (!response.ok) return {phase:'unknown'}
    const data = await response.json()
    const identity = data?.user?.id || data?.user?.email
    if (typeof identity !== 'string' || !identity) return {phase:'needs_login'}
    return {phase:'authenticated',identity,account:typeof data.user.email === 'string' ? data.user.email : undefined}
  } catch { return {phase:'unknown'} }
})()`

export async function readGptProAuthentication(cdp: Pick<BrowserCdp, "evaluate">): Promise<GptProAuthentication> {
  const value = await cdp.evaluate<{ phase: GptProAuthentication["phase"]; identity?: string; account?: string }>(
    expression,
  )
  if (value.phase !== "authenticated" || !value.identity)
    return { phase: value.phase === "needs_login" ? "needs_login" : "unknown" }
  return {
    phase: "authenticated",
    accountID: createHash("sha256").update(value.identity).digest("hex"),
    account: value.account?.slice(0, 200),
  }
}
