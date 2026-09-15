import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { WechatStorage } from "../../src/channel/wechat-storage"
import { WechatApi, TransportError, type QrStatus } from "../../src/channel/wechat-api"
import { createLoginService } from "../../src/channel/wechat-login"

test("QR login saves credentials without exposing token and cancellation fences pending polls", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(tmp.path)
  let resolve!: (response: QrStatus) => void
  const fake = {
    getQr: async () => ({ qrcode: "private", qrcode_img_content: "qr-content" }),
    pollQr: () =>
      new Promise<QrStatus>((r) => {
        resolve = r
      }),
  } as WechatApi
  const service = createLoginService({ storage, api: () => fake })
  const start = await service.startLogin({ channelName: "c" })
  expect(start.qrContent).toBe("qr-content")
  const pending = service.pollLogin({ channelName: "c", attemptID: start.attemptID })
  await service.cancelLogin({ channelName: "c", attemptID: start.attemptID })
  resolve({ status: "confirmed", bot_token: "secret", ilink_bot_id: "bot", ilink_user_id: "user" })
  await expect(pending).rejects.toThrow("no longer active")
  expect(await storage.loadCredentials("c")).toBeUndefined()
  const next = await service.startLogin({ channelName: "c" })
  const success = service.pollLogin({ channelName: "c", attemptID: next.attemptID })
  resolve({ status: "confirmed", bot_token: "secret", ilink_bot_id: "bot", ilink_user_id: "user" })
  const result = await success
  expect(result.status).toBe("confirmed")
  expect(JSON.stringify(result)).not.toContain("secret")
  expect((await storage.loadCredentials("c"))!.token).toBe("secret")
})
test("redirect validation and binded_redirect do not create false authorization", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(tmp.path)
  let response: QrStatus = { status: "scaned_but_redirect", redirect_host: "evil.test" }
  const fake = {
    getQr: async () => ({ qrcode: "q", qrcode_img_content: "content" }),
    pollQr: async () => response,
  } as WechatApi
  const service = createLoginService({ storage, api: () => fake })
  const attempt = await service.startLogin({ channelName: "c" })
  await expect(service.pollLogin({ channelName: "c", attemptID: attempt.attemptID })).rejects.toThrow(
    "Invalid WeChat API host",
  )
  response = { status: "binded_redirect" }
  expect((await service.pollLogin({ channelName: "c", attemptID: attempt.attemptID })).status).toBe("binded_redirect")
  expect(await storage.loadCredentials("c")).toBeUndefined()
})

test("QR timeout remains retryable and verification/expired states can refresh", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(tmp.path)
  let response: QrStatus | TransportError = new TransportError("timeout", "get_qrcode_status")
  const codes: Array<string | undefined> = []
  const fake = {
    getQr: async () => ({ qrcode: "q", qrcode_img_content: "content" }),
    pollQr: async (_qr: string, code?: string) => {
      codes.push(code)
      if (response instanceof TransportError) throw response
      return response
    },
  } as WechatApi
  const service = createLoginService({ storage, api: () => fake })
  const first = await service.startLogin({ channelName: "c" })
  expect((await service.pollLogin({ channelName: "c", attemptID: first.attemptID })).status).toBe("wait")
  response = { status: "scaned" }
  expect((await service.pollLogin({ channelName: "c", attemptID: first.attemptID })).status).toBe("scaned")
  response = { status: "need_verifycode" }
  expect((await service.pollLogin({ channelName: "c", attemptID: first.attemptID })).status).toBe("need_verifycode")
  await service.pollLogin({ channelName: "c", attemptID: first.attemptID, verifyCode: "123456" })
  expect(codes.at(-1)).toBe("123456")
  response = { status: "verify_code_blocked" }
  expect((await service.pollLogin({ channelName: "c", attemptID: first.attemptID })).status).toBe("verify_code_blocked")
  const count = codes.length
  await service.pollLogin({ channelName: "c", attemptID: first.attemptID })
  expect(codes).toHaveLength(count)
  const refreshed = await service.startLogin({ channelName: "c" })
  expect(refreshed.attemptID).not.toBe(first.attemptID)
  await expect(service.pollLogin({ channelName: "c", attemptID: first.attemptID })).rejects.toThrow("no longer active")
  response = { status: "expired" }
  expect((await service.pollLogin({ channelName: "c", attemptID: refreshed.attemptID })).status).toBe("expired")
})
