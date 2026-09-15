import { describe, expect, test } from "bun:test"
import { isWechatLoginTerminal, WechatAuthGeneration, requireWechatAuthData } from "./wechat-auth"

describe("WeChat authorization lifecycle", () => {
  test("missing SDK data fails explicitly and HTTP auth errors are terminal", () => {
    expect(() => requireWechatAuthData(undefined, 200)).toThrow()
    for (const status of [400, 401, 403, 404, 409]) {
      try {
        requireWechatAuthData(undefined, status)
      } catch (error) {
        expect(error).toMatchObject({ retryable: false })
      }
    }
    for (const status of [408, 429, 500, 503]) {
      try {
        requireWechatAuthData(undefined, status)
      } catch (error) {
        expect(error).toMatchObject({ retryable: true })
      }
    }
    expect(requireWechatAuthData({ status: "wait" }, 200)).toEqual({ status: "wait" })
  })
  test("refresh and navigation invalidate stale results", () => {
    const lifecycle = new WechatAuthGeneration()
    const first = lifecycle.advance()
    expect(first).toBe(lifecycle.value)
    const refreshed = lifecycle.advance()
    expect(first).not.toBe(lifecycle.value)
    expect(refreshed).toBe(lifecycle.value)
    lifecycle.advance()
    expect(refreshed).not.toBe(lifecycle.value)
  })
  test("verification and provider redirects keep polling while terminal results stop", () => {
    for (const status of ["wait", "scaned", "scaned_but_redirect", "need_verifycode"])
      expect(isWechatLoginTerminal(status)).toBe(false)
    for (const status of ["confirmed", "expired", "verify_code_blocked", "binded_redirect", "cancelled"])
      expect(isWechatLoginTerminal(status)).toBe(true)
  })
})
