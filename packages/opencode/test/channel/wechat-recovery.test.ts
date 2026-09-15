import { expect, test } from "bun:test"
import path from "node:path"
import { createServer } from "node:http"
import { tmpdir } from "../fixture/fixture"
import { startWechatChannel, createWechatTransport } from "../../src/channel/wechat"
import { WechatStorage, type Context } from "../../src/channel/wechat-storage"
import { WechatApi, type Message } from "../../src/channel/wechat-api"
import { Database, eq } from "../../src/storage/db"
import { IMMessageTable } from "../../src/im/inbox.sql"
import { Target } from "../../src/im/model"
import * as Log from "@opencode-ai/core/util/log"
import fs from "node:fs/promises"

async function until<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`WeChat recovery readiness timed out: ${description}`)
}
const baseUrl = "https://ilinkai.weixin.qq.com"
function raw(id: string, context = true): Message {
  return {
    message_id: id,
    from_user_id: "owner",
    message_type: 1,
    create_time_ms: 1234,
    ...(context ? { context_token: `private-${id}` } : {}),
    item_list: [{ type: 1, text_item: { text: "recover safely" } }],
  }
}
function held(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error("test poll cancelled"))
    signal?.addEventListener("abort", () => reject(new Error("test poll cancelled")), { once: true })
  })
}
const rows = (name: string) =>
  Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all())

for (const failure of ["context", "cursor"] as const) {
  test(`failed ${failure} commit retries from old checkpoint and deduplicates durable inbox`, async () => {
    await Log.init({ print: false, level: "INFO" })
    await using tmp = await tmpdir()
    let failed = false
    class FailureStorage extends WechatStorage {
      override async saveContext(bot: string, user: string, context: Context) {
        if (failure === "context" && !failed) {
          failed = true
          throw new Error("injected private context disk failure")
        }
        return super.saveContext(bot, user, context)
      }
      override async saveCursor(bot: string, cursor: string) {
        if (failure === "cursor" && !failed) {
          failed = true
          throw new Error("injected checkpoint disk failure")
        }
        return super.saveCursor(bot, cursor)
      }
    }
    const name = `wechat-recovery-${failure}-${crypto.randomUUID()}`
    const storage = new FailureStorage(path.join(tmp.path, "private"))
    await storage.saveCredentials(name, { botId: name, scannerUserId: "owner", baseUrl, token: "test-token" })
    const key = JSON.stringify([baseUrl, name])
    const cursors: string[] = []
    let polls = 0
    const api = new WechatApi({
      token: "test-token",
      fetch: (async (url, init) => {
        if (!String(url).endsWith("getupdates")) return Response.json({ ret: 0 })
        cursors.push(JSON.parse(String(init?.body)).get_updates_buf)
        if (++polls > 2) return held(init?.signal)
        return Response.json({ ret: 0, msgs: [raw("event")], get_updates_buf: "next-cursor" })
      }) as typeof fetch,
    })
    const handle = await startWechatChannel({
      name,
      config: { type: "wechat", botId: name, scannerUserId: "owner", baseUrl, autoReply: false },
      directory: tmp.path,
      baseUrl: "http://127.0.0.1:1",
      storage,
      api,
    })
    expect(handle).toBeDefined()
    try {
      await until(() => (failed ? true : undefined), "injected disk failure reached")
      expect(await storage.loadCursor(key)).toBeUndefined()
      expect(rows(name)).toHaveLength(1)
      expect(rows(name)[0].legacy_status).toBe("received")
      await until(
        async () => ((await storage.loadCursor(key)) === "next-cursor" ? true : undefined),
        "replayed checkpoint committed",
      )
      expect(cursors.slice(0, 2)).toEqual(["", ""])
      expect(rows(name)).toHaveLength(1)
      expect((await storage.loadContext(key, "owner", "event"))?.token).toBe("private-event")
      const logs = await fs.readFile(Log.file(), "utf8")
      expect(logs).toContain("receive retry scheduled")
      expect(logs).not.toContain("private-event")
    } finally {
      await handle?.stop()
    }
  })
}

test("restart leaves missing-context received message unclaimed and replay restores one automatic reply", async () => {
  await Log.init({ print: false, level: "INFO" })
  await using tmp = await tmpdir()
  const name = `wechat-missing-context-${crypto.randomUUID()}`
  let contextReads = 0
  class ObservedStorage extends WechatStorage {
    override async loadContext(bot: string, user: string, replyTo?: string) {
      contextReads++
      return super.loadContext(bot, user, replyTo)
    }
  }
  const storage = new ObservedStorage(path.join(tmp.path, "private"))
  await storage.saveCredentials(name, { botId: name, scannerUserId: "owner", baseUrl, token: "token" })
  const incoming: Message[] = [raw("missing", false)]
  const sends: Message[] = []
  let prompts = 0
  const sidecar = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain request before responding */
    }
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("/message")) {
      prompts++
      response.end(JSON.stringify({ parts: [{ type: "text", text: "restored context reply" }] }))
      return
    }
    response.end(JSON.stringify({ id: `ses_${crypto.randomUUID().replaceAll("-", "")}` }))
  })
  await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve))
  const address = sidecar.address()
  if (!address || typeof address === "string") throw new Error("Recovery sidecar did not listen")
  const api = new WechatApi({
    token: "token",
    fetch: (async (url, init) => {
      if (String(url).endsWith("getupdates"))
        return Response.json({ ret: 0, msgs: incoming.splice(0), get_updates_buf: "cursor" })
      if (String(url).endsWith("sendmessage")) sends.push(JSON.parse(String(init?.body)).msg)
      return Response.json({ ret: 0 })
    }) as typeof fetch,
  })
  const config = { type: "wechat" as const, botId: name, scannerUserId: "owner", baseUrl, autoReply: true }
  const start = () =>
    startWechatChannel({ name, config, storage, api, directory: tmp.path, baseUrl: `http://127.0.0.1:${address.port}` })
  let handle = await start()
  try {
    await until(
      () => (contextReads >= 1 && rows(name).length ? true : undefined),
      "missing context checked before model",
    )
    expect(rows(name)[0].legacy_status).toBe("received")
    expect(prompts).toBe(0)
    await handle?.stop()
    const previousReads = contextReads
    handle = await start()
    await until(() => (contextReads > previousReads ? true : undefined), "restart recovery checked missing context")
    expect(rows(name)[0].legacy_status).toBe("received")
    expect(prompts).toBe(0)
    incoming.push(raw("missing"), raw("missing"))
    await until(() => (sends.length ? true : undefined), "replay context restored provider reply")
    await until(() => (rows(name)[0].legacy_status === "completed" ? true : undefined), "durable reply completion")
    expect(rows(name)).toHaveLength(1)
    expect(prompts).toBe(1)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ to_user_id: "owner", context_token: "private-missing" })
    const logs = await fs.readFile(Log.file(), "utf8")
    expect(logs).toContain("automatic reply waits for provider reply context")
    expect(logs).toContain("automatic reply completed")
    expect(logs).not.toContain("private-missing")
  } finally {
    await handle?.stop()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test("stored reply context never crosses account/user and older events do not rewind latest", async () => {
  await using tmp = await tmpdir()
  const storage = new WechatStorage(tmp.path)
  const old = JSON.stringify([baseUrl, "old-bot"])
  const current = JSON.stringify([baseUrl, "new-bot"])
  await storage.saveContext(old, "owner", { token: "old-account-secret", messageId: "old", timestamp: 20 })
  await storage.saveContext(current, "other-user", { token: "other-user-secret", messageId: "other", timestamp: 20 })
  await storage.saveContext(current, "owner", { token: "new-context", messageId: "new", timestamp: 30 })
  await storage.saveContext(current, "owner", { token: "older-context", messageId: "older", timestamp: 10 })
  const sent: Message[] = []
  const transport = createWechatTransport({
    name: "wechat-context-isolation",
    config: { type: "wechat", scannerUserId: "owner", botId: "new-bot", baseUrl },
    accountKey: current,
    storage,
    api: {
      sendMessage: async (message) => {
        sent.push(message)
        return { ret: 0 }
      },
    },
  })
  const target = new Target({
    platform: "wechat",
    channelName: "wechat-context-isolation",
    scope: "c2c",
    conversationID: "owner",
    senderID: "owner",
    replyTo: "old",
  })
  await expect(transport.sendText({ target, text: "no cross-account reply", mode: "reply" })).rejects.toThrow(
    "reply context",
  )
  await expect(
    transport.sendText({
      target: new Target({ ...target, replyTo: "other" }),
      text: "no cross-user reply",
      mode: "reply",
    }),
  ).rejects.toThrow("reply context")
  await transport.sendText({ target, text: "latest current account reply", mode: "proactive" })
  expect(sent).toHaveLength(1)
  expect(sent[0].context_token).toBe("new-context")
})
