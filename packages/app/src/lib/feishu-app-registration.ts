import { renderSVG } from "./uqr"

/**
 * Feishu / Lark App Registration device-code flow.
 *
 * POST {accounts}/oauth/v1/app/registration
 *   init  → supported_auth_methods
 *   begin → device_code + verification_uri_complete (QR payload)
 *   poll  → client_id + client_secret after user scans with Feishu App
 *
 * Reference: Hermes-agent gateway/platforms/feishu.py `qr_register`.
 */

export type FeishuDomain = "feishu" | "lark"

export type FeishuRegistrationCredentials = {
  appId: string
  appSecret: string
  domain: FeishuDomain
  openId?: string
  botName?: string
  botOpenId?: string
}

export type FeishuRegistrationSession = {
  deviceCode: string
  qrUrl: string
  userCode: string
  intervalMs: number
  expireInMs: number
  domain: FeishuDomain
}

export type FeishuRegistrationErrorCode = "access_denied" | "expired_token" | "timeout" | "unsupported" | "network"

export class FeishuRegistrationError extends Error {
  readonly code: FeishuRegistrationErrorCode

  constructor(code: FeishuRegistrationErrorCode, message: string) {
    super(message)
    this.name = "FeishuRegistrationError"
    this.code = code
  }
}

const ACCOUNTS: Record<FeishuDomain, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
}

const OPEN: Record<FeishuDomain, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
}

const REGISTRATION_PATH = "/oauth/v1/app/registration"
const REQUEST_TIMEOUT_MS = 15_000
const BRAND_FROM = "opencode"
const BRAND_TP = "opencode"

type RegistrationJson = Record<string, unknown>

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function postRegistration(
  domain: FeishuDomain,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<RegistrationJson> {
  const url = `${ACCOUNTS[domain]}${REGISTRATION_PATH}`
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    })
    const text = await res.text()
    // Intermediate states (e.g. authorization_pending) may return HTTP 4xx with JSON body.
    try {
      return JSON.parse(text) as RegistrationJson
    } catch {
      throw new FeishuRegistrationError(
        "network",
        `Feishu registration returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      )
    }
  } catch (err) {
    if (err instanceof FeishuRegistrationError) throw err
    if (err instanceof DOMException && err.name === "AbortError") throw err
    throw new FeishuRegistrationError(
      "network",
      err instanceof Error ? err.message : "Network error talking to Feishu registration API",
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function brandQrUrl(url: string): string {
  if (!url) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}from=${BRAND_FROM}&tp=${BRAND_TP}`
}

export async function initRegistration(domain: FeishuDomain = "feishu", signal?: AbortSignal): Promise<void> {
  const res = await postRegistration(domain, { action: "init" }, signal)
  const methods = Array.isArray(res.supported_auth_methods) ? res.supported_auth_methods.map(String) : []
  if (!methods.includes("client_secret")) {
    throw new FeishuRegistrationError(
      "unsupported",
      `Feishu registration does not support client_secret auth. Supported: ${methods.join(", ") || "(none)"}`,
    )
  }
}

export async function beginRegistration(
  domain: FeishuDomain = "feishu",
  signal?: AbortSignal,
): Promise<FeishuRegistrationSession> {
  const res = await postRegistration(
    domain,
    {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    },
    signal,
  )
  const deviceCode = asString(res.device_code)
  if (!deviceCode) {
    throw new FeishuRegistrationError("network", "Feishu registration did not return a device_code")
  }
  const intervalSec = typeof res.interval === "number" && res.interval > 0 ? res.interval : 5
  const expireSec = typeof res.expires_in === "number" && res.expires_in > 0 ? res.expires_in : 600
  return {
    deviceCode,
    qrUrl: brandQrUrl(asString(res.verification_uri_complete) ?? ""),
    userCode: asString(res.user_code) ?? "",
    intervalMs: intervalSec * 1000,
    expireInMs: expireSec * 1000,
    domain,
  }
}

export async function pollRegistration(
  session: FeishuRegistrationSession,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<FeishuRegistrationCredentials> {
  const signal = options?.signal
  const deadline = Date.now() + Math.min(session.expireInMs, options?.timeoutMs ?? session.expireInMs)
  let domain = session.domain
  let domainSwitched = false

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

    let res: RegistrationJson
    try {
      res = await postRegistration(
        domain,
        {
          action: "poll",
          device_code: session.deviceCode,
          tp: "ob_app",
        },
        signal,
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err
      await sleep(session.intervalMs, signal)
      continue
    }

    const userInfo = (res.user_info && typeof res.user_info === "object" ? res.user_info : {}) as Record<
      string,
      unknown
    >
    if (userInfo.tenant_brand === "lark" && !domainSwitched) {
      domain = "lark"
      domainSwitched = true
    }

    const clientId = asString(res.client_id)
    const clientSecret = asString(res.client_secret)
    if (clientId && clientSecret) {
      return {
        appId: clientId,
        appSecret: clientSecret,
        domain,
        openId: asString(userInfo.open_id),
      }
    }

    const error = asString(res.error)
    if (error === "access_denied" || error === "expired_token") {
      throw new FeishuRegistrationError(error, `Feishu registration ${error}`)
    }

    // authorization_pending or unknown — keep polling
    await sleep(session.intervalMs, signal)
  }

  throw new FeishuRegistrationError("timeout", "Timed out waiting for Feishu QR authorization")
}

export async function probeBot(
  appId: string,
  appSecret: string,
  domain: FeishuDomain,
  signal?: AbortSignal,
): Promise<{ botName?: string; botOpenId?: string } | undefined> {
  const base = OPEN[domain]
  try {
    const tokenRes = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    })
    const tokenJson = (await tokenRes.json()) as { tenant_access_token?: string }
    const token = tokenJson.tenant_access_token
    if (!token) return undefined

    const botRes = await fetch(`${base}/open-apis/bot/v3/info`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal,
    })
    const botJson = (await botRes.json()) as {
      code?: number
      bot?: { app_name?: string; bot_name?: string; open_id?: string }
      data?: { bot?: { app_name?: string; bot_name?: string; open_id?: string } }
    }
    if (botJson.code !== 0) return undefined
    const bot = botJson.bot ?? botJson.data?.bot ?? {}
    return {
      botName: bot.app_name ?? bot.bot_name,
      botOpenId: bot.open_id,
    }
  } catch {
    return undefined
  }
}

/**
 * Full scan-to-create flow: init → begin → poll → optional probe.
 * Caller should render `session.qrUrl` as a QR code between begin and poll.
 */
export async function registerViaQr(options?: {
  domain?: FeishuDomain
  signal?: AbortSignal
  timeoutMs?: number
  onSession?: (session: FeishuRegistrationSession) => void
  probe?: boolean
}): Promise<FeishuRegistrationCredentials> {
  const domain = options?.domain ?? "feishu"
  const signal = options?.signal
  await initRegistration(domain, signal)
  const session = await beginRegistration(domain, signal)
  options?.onSession?.(session)
  const creds = await pollRegistration(session, { signal, timeoutMs: options?.timeoutMs })
  if (options?.probe !== false) {
    const bot = await probeBot(creds.appId, creds.appSecret, creds.domain, signal)
    if (bot) {
      creds.botName = bot.botName
      creds.botOpenId = bot.botOpenId
    }
  }
  return creds
}


/** Encode a URL into an SVG QR data URL (vendored uqr). */
export function qrSvgDataUrl(text: string, size = 200): string {
  const svg = renderSVG(text, { ecc: "M", border: 2, pixelSize: 4, whiteColor: "#ffffff", blackColor: "#000000" })
  // Scale via width/height attributes for consistent UI size
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`
}
