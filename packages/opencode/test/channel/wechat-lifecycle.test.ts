import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { startWechatChannel, channelStatus } from "../../src/channel/wechat"
import { WechatApi } from "../../src/channel/wechat-api"
import { WechatStorage } from "../../src/channel/wechat-storage"
import { Target } from "../../src/im/model"

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("WeChat lifecycle readiness timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("auth -14 aborts transport sends and stop releases account lease for refreshed token", async () => {
  await using tmp = await tmpdir()
  const name = `wechat-lifecycle-${crypto.randomUUID()}`
  const baseUrl = "https://ilinkai.weixin.qq.com"
  const storage = new WechatStorage(path.join(tmp.path, "private"))
  const config = { type: "wechat" as const, botId: name, scannerUserId: "owner", baseUrl, autoReply: false }
  const credentials = { botId: name, scannerUserId: "owner", baseUrl, token: "old-test-token" }
  await storage.saveCredentials(name, credentials)
  await storage.saveContext(JSON.stringify([baseUrl, name]), "owner", {
    token: "context",
    messageId: "event",
    timestamp: Date.now(),
  })
  let sends = 0
  const api = new WechatApi({
    token: credentials.token,
    fetch: (async (url) => {
      const endpoint = new URL(String(url)).pathname
      if (endpoint.endsWith("sendmessage")) sends++
      return new Response(JSON.stringify(endpoint.endsWith("getupdates") ? { ret: -14 } : { ret: 0 }))
    }) as typeof fetch,
  })
  const handle = await startWechatChannel({
    name,
    config,
    directory: tmp.path,
    baseUrl: "http://127.0.0.1:1",
    storage,
    api,
  })
  expect(handle).toBeDefined()
  if (!handle) throw new Error("Missing test channel")
  try {
    await waitUntil(() => channelStatus(name).status === "auth_expired")
    await expect(
      handle.transport.sendText({
        target: new Target({
          platform: "wechat",
          channelName: name,
          scope: "c2c",
          conversationID: "owner",
          senderID: "owner",
          replyTo: "event",
        }),
        text: "must never reach provider",
        mode: "reply",
      }),
    ).rejects.toThrow("stopped")
    expect(sends).toBe(0)
    await storage.saveCredentials(`${name}-concurrent`, credentials)
    const concurrent = await startWechatChannel({
      name: `${name}-concurrent`,
      config,
      directory: tmp.path,
      baseUrl: "http://127.0.0.1:1",
      storage,
      api,
    })
    expect(concurrent).toBeUndefined()
    expect(channelStatus(`${name}-concurrent`).status).toBe("account_busy")
  } finally {
    await handle.stop()
  }
  await storage.saveCredentials(name, { ...credentials, token: "refreshed-test-token" })
  const refreshedApi = new WechatApi({
    token: "refreshed-test-token",
    fetch: (async () => new Response('{"ret":0,"msgs":[]}')) as typeof fetch,
  })
  const refreshed = await startWechatChannel({
    name,
    config,
    directory: tmp.path,
    baseUrl: "http://127.0.0.1:1",
    storage,
    api: refreshedApi,
  })
  expect(refreshed).toBeDefined()
  await refreshed?.stop()
  expect(channelStatus(name).status).toBe("stopped")
})
