import { randomUUID } from "node:crypto"
import { WechatApi, DEFAULT_BASE_URL, validateBaseUrl, TransportError, type QrStatus } from "./wechat-api"
import { WechatStorage, type Credentials } from "./wechat-storage"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "wechat-login" })
export type LoginStatus = QrStatus["status"] | "cancelled" | "starting"
export interface LoginResult {
  attemptID: string
  status: LoginStatus
  qrContent?: string
  expiresAt: number
  account?: Omit<Credentials, "token">
}
interface Attempt {
  channelName: string
  result: LoginResult
  qrcode: string
  baseUrl: string
  controller: AbortController
  redirects: number
  polling?: Promise<LoginResult>
}
export function createLoginService(
  options: { storage?: WechatStorage; api?: (baseUrl: string) => WechatApi; now?: () => number; ttlMs?: number } = {},
) {
  const storage = options.storage ?? new WechatStorage()
  const api = options.api ?? ((baseUrl) => new WechatApi({ baseUrl }))
  const now = options.now ?? Date.now
  const attempts = new Map<string, Attempt>()
  const copy = (attempt: Attempt): LoginResult => ({
    ...attempt.result,
    account: attempt.result.account ? { ...attempt.result.account } : undefined,
  })
  const expire = () => {
    for (const [name, attempt] of attempts) {
      if (attempt.result.expiresAt > now()) continue
      attempt.controller.abort()
      attempts.delete(name)
      log.info("login attempt expired")
    }
  }
  const current = (attempt: Attempt) =>
    attempts.get(attempt.channelName) === attempt &&
    !attempt.controller.signal.aborted &&
    attempt.result.expiresAt > now()
  const lookup = (input: { channelName: string; attemptID: string }) => {
    expire()
    const attempt = attempts.get(input.channelName)
    if (!attempt || attempt.result.attemptID !== input.attemptID)
      throw new Error("WeChat login attempt is no longer active")
    return attempt
  }
  return {
    async startLogin(input: { channelName: string }): Promise<LoginResult> {
      expire()
      if (!input.channelName.trim() || input.channelName.length > 128) throw new Error("Invalid channel name")
      attempts.get(input.channelName)?.controller.abort()
      if (!attempts.has(input.channelName) && attempts.size >= 32) throw new Error("Too many WeChat login attempts")
      const attempt: Attempt = {
        channelName: input.channelName,
        qrcode: "",
        baseUrl: DEFAULT_BASE_URL,
        controller: new AbortController(),
        redirects: 0,
        result: { attemptID: randomUUID(), status: "starting", expiresAt: now() + (options.ttlMs ?? 300_000) },
      }
      attempts.set(input.channelName, attempt)
      log.info("login QR requested")
      try {
        const qr = await api(attempt.baseUrl).getQr(attempt.controller.signal)
        if (!current(attempt)) throw new Error("WeChat login attempt is no longer active")
        if (
          typeof qr.qrcode !== "string" ||
          typeof qr.qrcode_img_content !== "string" ||
          !qr.qrcode ||
          !qr.qrcode_img_content
        )
          throw new Error("WeChat QR response is incomplete")
        attempt.qrcode = qr.qrcode
        attempt.result = { ...attempt.result, status: "wait", qrContent: qr.qrcode_img_content }
        log.info("login QR ready")
        return copy(attempt)
      } catch (error) {
        if (attempts.get(input.channelName) === attempt) attempts.delete(input.channelName)
        throw error
      }
    },
    async pollLogin(input: { channelName: string; attemptID: string; verifyCode?: string }): Promise<LoginResult> {
      const attempt = lookup(input)
      if (
        ["confirmed", "cancelled", "expired", "verify_code_blocked", "binded_redirect"].includes(attempt.result.status)
      )
        return copy(attempt)
      if (attempt.polling) return attempt.polling
      const work = async () => {
        let response: QrStatus
        try {
          response = await api(attempt.baseUrl).pollQr(attempt.qrcode, input.verifyCode, attempt.controller.signal)
        } catch (error) {
          if (current(attempt) && error instanceof TransportError && ["timeout", "network"].includes(error.kind)) {
            log.info("QR long poll will continue after a temporary transport failure")
            return copy(attempt)
          }
          throw error
        }
        if (!current(attempt)) throw new Error("WeChat login attempt is no longer active")
        const allowed: QrStatus["status"][] = [
          "wait",
          "scaned",
          "confirmed",
          "expired",
          "need_verifycode",
          "verify_code_blocked",
          "scaned_but_redirect",
          "binded_redirect",
        ]
        if (!allowed.includes(response.status)) throw new Error("Invalid WeChat login status")
        log.info("login status received", { status: response.status })
        if (response.status === "scaned_but_redirect") {
          if (!response.redirect_host || ++attempt.redirects > 5) throw new Error("Invalid WeChat login redirect")
          attempt.baseUrl = validateBaseUrl(
            response.redirect_host.startsWith("https://")
              ? response.redirect_host
              : `https://${response.redirect_host}`,
          )
        }
        if (response.status === "confirmed") {
          if (
            ![response.bot_token, response.ilink_bot_id, response.ilink_user_id].every(
              (x) => typeof x === "string" && x.length > 0,
            )
          )
            throw new Error("WeChat login credentials are incomplete")
          const credentials: Credentials = {
            botId: response.ilink_bot_id!,
            token: response.bot_token!,
            scannerUserId: response.ilink_user_id!,
            baseUrl: validateBaseUrl(response.baseurl ?? attempt.baseUrl),
          }
          await storage.saveCredentials(input.channelName, credentials, () => current(attempt))
          if (!current(attempt)) throw new Error("WeChat login attempt is no longer active")
          const { token: _, ...account } = credentials
          attempt.result.account = account
          attempt.result.qrContent = undefined
          log.info("login credentials saved")
        }
        attempt.result.status = response.status
        return copy(attempt)
      }
      attempt.polling = work().finally(() => {
        attempt.polling = undefined
      })
      return attempt.polling
    },
    async cancelLogin(input: { channelName: string; attemptID: string }): Promise<LoginResult> {
      const attempt = lookup(input)
      attempt.controller.abort()
      attempt.result.status = "cancelled"
      attempt.result.qrContent = undefined
      log.info("login cancelled")
      return copy(attempt)
    },
    async status(input: {
      channelName: string
    }): Promise<LoginResult | { status: "idle"; account?: Omit<Credentials, "token"> }> {
      expire()
      const attempt = attempts.get(input.channelName)
      if (attempt) return copy(attempt)
      const credentials = await storage.loadCredentials(input.channelName)
      if (!credentials) return { status: "idle" }
      const { token: _, ...account } = credentials
      return { status: "idle", account }
    },
  }
}
const service = createLoginService()
export const startLogin = service.startLogin
export const pollLogin = service.pollLogin
export const cancelLogin = service.cancelLogin
export const status = service.status
export * as WechatLogin from "./wechat-login"
