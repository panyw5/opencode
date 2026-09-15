import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { WechatApi } from "../../src/channel/wechat-api"
import { WechatStorage } from "../../src/channel/wechat-storage"
import { channelStatus, startWechatChannel } from "../../src/channel/wechat"

test("receiver backs off after three failures, recovers, and cancels the live long poll", async () => {
  await using tmp = await tmpdir()
  const name = `wechat-backoff-${crypto.randomUUID()}`
  const store = new WechatStorage(path.join(tmp.path, "private"))
  const config = { type: "wechat" as const, botId: name, baseUrl: "https://ilinkai.weixin.qq.com", scannerUserId: "owner", autoReply: false }
  await store.saveCredentials(name, { botId: name, baseUrl: config.baseUrl, scannerUserId: "owner", token: "test-token" })
  const polls: number[] = []
  let cancelled = false
  const api = new WechatApi({ token: "test-token", fetch: (async (url, init) => {
    if (!String(url).endsWith("getupdates")) return Response.json({ ret: 0 })
    polls.push(Date.now())
    if (polls.length <= 3) return new Response("temporary server failure", { status: 503 })
    if (polls.length === 4) return Response.json({ ret: 0, msgs: [], get_updates_buf: "recovered" })
    return new Promise<Response>((_, reject) => {
      const abort = () => { cancelled = true; reject(new Error("cancelled")) }
      if (init?.signal?.aborted) abort()
      else init?.signal?.addEventListener("abort", abort, { once: true })
    })
  }) as typeof fetch })
  const handle = await startWechatChannel({ name, config, storage: store, api, baseUrl: "http://127.0.0.1:1", directory: tmp.path })
  if (!handle) throw new Error("Test monitor did not start")
  try {
    const deadline = Date.now() + 40_000
    while (polls.length < 5 || channelStatus(name).status !== "connected") {
      if (Date.now() > deadline) throw new Error("Backoff receiver did not recover")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(polls[1]! - polls[0]!).toBeGreaterThanOrEqual(1900)
    expect(polls[2]! - polls[1]!).toBeGreaterThanOrEqual(1900)
    expect(polls[3]! - polls[2]!).toBeGreaterThanOrEqual(29_000)
    expect(await store.loadCursor(JSON.stringify([config.baseUrl, config.botId]))).toBe("recovered")
  } finally { await handle.stop() }
  expect(cancelled).toBe(true)
}, 45_000)
