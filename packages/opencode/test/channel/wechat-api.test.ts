import { expect, test } from "bun:test"
import { WechatApi, validateBaseUrl, ProviderRejectedError, TransportError } from "../../src/channel/wechat-api"

test("validates provider-only HTTPS hosts", () => {
  expect(validateBaseUrl("https://ilinkai.weixin.qq.com")).toBe("https://ilinkai.weixin.qq.com")
  for (const host of [
    "http://ilinkai.weixin.qq.com",
    "https://weixin.qq.com.evil.test",
    "https://u@weixin.qq.com",
    "https://weixin.qq.com/path",
    "https://weixin.qq.com:444",
  ])
    expect(() => validateBaseUrl(host)).toThrow()
})
test("QR header/body separation and lossless IDs", async () => {
  const calls: RequestInit[] = []
  const api = new WechatApi({
    token: "secret",
    fetch: (async (_url, init) => {
      calls.push(init!)
      return new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}]}')
    }) as typeof fetch,
  })
  await api.getQr()
  await api.pollQr("qr")
  const updates = await api.getUpdates("cursor")
  expect(updates.msgs![0].message_id).toBe("18446744073709551615")
  expect(calls[0].headers).not.toHaveProperty("Authorization")
  expect(JSON.parse(calls[0].body as string)).toEqual({ local_token_list: [] })
  expect(calls[1].headers).not.toHaveProperty("AuthorizationType")
  expect(calls[2].headers).toHaveProperty("Authorization", "Bearer secret")
  expect(calls[2].redirect).toBe("error")
})
test("business rejection differs from unknown transport and redacts errors", async () => {
  const make = (response: Response) => new WechatApi({ token: "secret", fetch: (async () => response) as typeof fetch })
  await expect(make(new Response('{"ret":-14,"errmsg":"secret"}')).getUpdates()).rejects.toBeInstanceOf(
    ProviderRejectedError,
  )
  await expect(make(new Response("secret", { status: 503 })).sendMessage({})).rejects.toBeInstanceOf(TransportError)
  await expect(make(new Response("invalid secret")).getUpdates()).rejects.toMatchObject({ kind: "invalid_response" })
  const api = new WechatApi({
    token: "secret",
    fetch: (async () => {
      throw new Error("secret")
    }) as typeof fetch,
  })
  await expect(api.sendMessage({})).rejects.toThrow("network")
})

test("rejects malformed receive batches and unconfirmed sends before persistence", async () => {
  const make = (value: unknown) =>
    new WechatApi({ token: "secret", fetch: (async () => Response.json(value)) as typeof fetch })
  for (const value of [
    { msgs: [null] },
    { msgs: {} },
    { get_updates_buf: {} },
    { msgs: [{ item_list: {} }] },
    { msgs: [{ from_user_id: {} }] },
  ])
    await expect(make(value).getUpdates()).rejects.toMatchObject({ kind: "invalid_response" })
  expect(await make({}).sendMessage({})).toEqual({})
  const oversized = new WechatApi({ fetch: (async () => new Response("x".repeat(4_000_001))) as typeof fetch })
  await expect(oversized.getQr()).rejects.toMatchObject({ kind: "invalid_response" })
})
