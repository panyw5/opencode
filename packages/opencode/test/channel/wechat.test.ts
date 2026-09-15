import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "../../src/config/config"
import type { ConfigChannels } from "../../src/config/channels"
import { IMOwner } from "../../src/im/owner"
import { Target, isTargetScopeSupported } from "../../src/im/model"
import { transportCapabilities, ProviderRejectedError, SendValidationError } from "../../src/im/transport"
import { createWechatTransport, normalizeMessage, permitted, startWechatChannel } from "../../src/channel/wechat"
import { WechatApi } from "../../src/channel/wechat-api"
import { WechatStorage } from "../../src/channel/wechat-storage"
import { Database, eq } from "../../src/storage/db"
import { IMMessageTable } from "../../src/im/inbox.sql"
import { tmpdir } from "../fixture/fixture"

const config: ConfigChannels.Wechat = {
  type: "wechat",
  botId: "test-bot",
  baseUrl: "https://ilinkai.weixin.qq.com",
  scannerUserId: "owner",
  autoReply: false,
}
const target = new Target({
  platform: "wechat",
  channelName: "wechat-test",
  scope: "c2c",
  conversationID: "owner",
  senderID: "owner",
  replyTo: "event-1",
})
async function until<T>(check: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(description)
}

describe("WeChat channel integration", () => {
  test("keeps durable send client IDs stable and missing exact reply contexts fail closed", async () => {
    const sent: Array<{ client_id?: string }> = []
    const transport = createWechatTransport({
      name: "wechat-test",
      config,
      accountKey: "account",
      api: {
        sendMessage: async (message) => {
          sent.push(message)
          return { ret: 0 }
        },
      },
      storage: {
        loadContext: async (_account, _user, replyTo) =>
          replyTo === "missing" ? undefined : { token: "context", timestamp: 1, messageId: "event-1" },
      },
    })
    await transport.sendText({ target, text: "reply", mode: "reply", providerClientID: "stable-project-send" })
    await transport.sendText({ target, text: "reply", mode: "reply", providerClientID: "stable-project-send" })
    expect(sent.map((message) => message.client_id)).toEqual(["stable-project-send", "stable-project-send"])
    await expect(
      transport.sendText({
        target: new Target({ ...target, replyTo: "missing" }),
        text: "must not use latest",
        mode: "reply",
      }),
    ).rejects.toBeInstanceOf(SendValidationError)
    expect(sent).toHaveLength(2)
  })
  test("private-only capabilities and safe default sender ACL", () => {
    expect(isTargetScopeSupported("wechat", "c2c")).toBe(true)
    for (const scope of ["chat", "group", "guild"] as const) expect(isTargetScopeSupported("wechat", scope)).toBe(false)
    expect(transportCapabilities("wechat")).toMatchObject({
      proactiveC2C: "limited",
      proactiveGroup: "unsupported",
      proactiveGuild: "unsupported",
    })
    expect(permitted(config, "owner")).toBe(true)
    expect(permitted(config, "stranger")).toBe(false)
    expect(permitted({ type: "wechat" }, "stranger")).toBe(false)
    expect(permitted({ ...config, allowedUsers: ["*"] }, "stranger")).toBe(true)
  })

  test("normalizes text/transcripts without leaking secrets and filters groups/echoes", () => {
    const raw = {
      message_id: "18446744073709551615",
      message_type: 1,
      from_user_id: "owner",
      context_token: "PRIVATE_CONTEXT",
      item_list: [
        { type: 1, text_item: { text: "hello" } },
        { type: 3, voice_item: { text: "world" } },
      ],
    }
    const normalized = normalizeMessage("wechat-test", config, raw)
    expect(normalized?.eventID).toBe(raw.message_id)
    expect(normalized?.text).toBe("hello\nworld")
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_CONTEXT")
    expect(normalizeMessage("wechat-test", config, { ...raw, message_type: 2 })).toBeUndefined()
    expect(normalizeMessage("wechat-test", config, { ...raw, group_id: "group" })).toBeUndefined()
    expect(normalizeMessage("wechat-test", config, { ...raw, from_user_id: "stranger" })).toBeUndefined()
    expect(normalizeMessage("wechat-test", config, { ...raw, item_list: [{ type: 2 }] })?.metadata).toMatchObject({
      textAvailable: false,
      hasMedia: true,
    })
  })

  test("resolves scanner owner, canonicalizes identity, and does not reuse a previous binding", async () => {
    const channelName = `wechat-owner-${crypto.randomUUID()}`
    let channels: Record<string, ConfigChannels.Info> = { [channelName]: config }
    const layer = IMOwner.makeLayer({ legacyPaths: () => [] }).pipe(
      Layer.provide(
        Layer.succeed(Config.Service, {
          getGlobal: () => Effect.succeed({ channels }),
        } as Config.Interface),
      ),
    )
    const resolve = () => Effect.runPromise(IMOwner.resolve(channelName).pipe(Effect.provide(layer)))
    expect(await resolve()).toMatchObject({ scope: "c2c", senderID: "owner", conversationID: "owner" })
    expect(IMOwner.appIdentity(config)).toBe(
      IMOwner.appIdentity({ ...config, baseUrl: "https://ILINKAI.WEIXIN.QQ.COM/" }),
    )
    channels = { [channelName]: { ...config, botId: "replacement", scannerUserId: "new-owner" } }
    expect(await resolve()).toMatchObject({ senderID: "new-owner" })
    channels = { [channelName]: { type: "wechat", scannerUserId: "owner" } }
    await expect(resolve()).rejects.toThrow("no discovered private recipient")
  })

  test("sends with exact reply context, limits proactive sends and rejects unsupported/unauthorized targets", async () => {
    const sent: unknown[] = []
    const lookups: unknown[] = []
    const transport = createWechatTransport({
      name: "wechat-test",
      config,
      accountKey: "account",
      api: {
        sendMessage: async (message) => {
          sent.push(message)
          return { ret: 0 }
        },
      },
      storage: {
        loadContext: async (account, user, replyTo) => {
          lookups.push([account, user, replyTo])
          return { token: "SECRET", timestamp: 1, messageId: "event-1" }
        },
      },
    })
    expect(await transport.sendText({ target, text: "reply", mode: "reply" })).toHaveProperty("timeSent")
    await transport.sendText({ target, text: "notification", mode: "proactive" })
    expect(lookups).toEqual([
      ["account", "owner", "event-1"],
      ["account", "owner", undefined],
    ])
    expect(sent[0]).toMatchObject({ to_user_id: "owner", context_token: "SECRET", message_type: 2, message_state: 2 })
    await expect(
      transport.sendText({ target, text: "markdown", mode: "reply", format: "markdown" }),
    ).rejects.toBeInstanceOf(SendValidationError)
    await expect(
      transport.sendText({ target: new Target({ ...target, conversationID: "stranger" }), text: "no", mode: "reply" }),
    ).rejects.toBeInstanceOf(SendValidationError)
    await expect(
      transport.sendText({ target: new Target({ ...target, scope: "group" }), text: "no", mode: "reply" }),
    ).rejects.toBeInstanceOf(SendValidationError)
    expect(sent).toHaveLength(2)
    const noContext = createWechatTransport({
      name: "wechat-test",
      config,
      accountKey: "account",
      api: {
        sendMessage: async () => {
          throw new Error("must not send")
        },
      },
      storage: { loadContext: async () => undefined },
    })
    await expect(noContext.sendText({ target, text: "no", mode: "proactive" })).rejects.toBeInstanceOf(
      SendValidationError,
    )
  })

  test("provider rejection is failed while server and network outcomes remain unknown", async () => {
    for (const [status, rejection] of [
      [400, true],
      [503, false],
    ] as const) {
      const api = new WechatApi({
        token: "secret",
        fetch: (async () => new Response("{}", { status })) as typeof fetch,
      })
      const transport = createWechatTransport({
        name: "wechat-test",
        config,
        accountKey: "account",
        api,
        storage: { loadContext: async () => ({ token: "context", timestamp: 1, messageId: "event-1" }) },
      })
      try {
        await transport.sendText({ target, text: "test", mode: "reply" })
        throw new Error("must reject")
      } catch (error) {
        expect(error instanceof ProviderRejectedError).toBe(rejection)
      }
    }
  })

  test("runtime persists inbound messages/context before checkpoint and releases its lock on stop", async () => {
    await using tmp = await tmpdir()
    const name = `wechat-runtime-${crypto.randomUUID()}`
    const storage = new WechatStorage(tmp.path)
    await storage.saveCredentials(name, {
      botId: config.botId!,
      token: "private-token",
      baseUrl: config.baseUrl!,
      scannerUserId: "owner",
    })
    const accountKey = JSON.stringify([config.baseUrl, config.botId])
    let contextStarted = false
    let unblock!: () => void
    const hold = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const saveContext = storage.saveContext.bind(storage)
    storage.saveContext = async (...args) => {
      contextStarted = true
      await hold
      return saveContext(...args)
    }
    const requests: string[] = []
    let polled = false
    const api = new WechatApi({
      token: "private-token",
      fetch: (async (url, init) => {
        requests.push(String(url))
        if (String(url).endsWith("getupdates")) {
          if (!polled) {
            polled = true
            return Response.json({
              ret: 0,
              get_updates_buf: "cursor-1",
              msgs: [
                {
                  message_id: "event-1",
                  message_type: 1,
                  from_user_id: "owner",
                  context_token: "private-context",
                  item_list: [{ type: 1, text_item: { text: "sidecar received" } }],
                },
              ],
            })
          }
          return await new Promise<Response>((_, reject) => {
            if (init?.signal?.aborted) return reject(new Error("cancelled"))
            init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
          })
        }
        return Response.json({ ret: 0 })
      }) as typeof fetch,
    })
    const handle = await startWechatChannel({
      name,
      config,
      storage,
      api,
      directory: tmp.path,
      baseUrl: "http://127.0.0.1:1",
    })
    expect(handle).toBeDefined()
    try {
      await until(() => (contextStarted ? true : undefined), "context write did not start")
      expect(await storage.loadCursor(accountKey)).toBeUndefined()
      const rows = Database.use((db) =>
        db.select().from(IMMessageTable).where(eq(IMMessageTable.channel_name, name)).all(),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.text).toBe("sidecar received")
      expect(JSON.stringify(rows)).not.toContain("private-context")
      unblock()
      await until(
        () => (requests.filter((url) => url.endsWith("getupdates")).length >= 2 ? true : undefined),
        "second poll did not start",
      )
      expect(await storage.loadCursor(accountKey)).toBe("cursor-1")
      expect((await storage.loadContext(accountKey, "owner", "event-1"))?.token).toBe("private-context")
    } finally {
      unblock()
      await handle?.stop()
    }
    const release = await storage.acquireLock(accountKey)
    await release()
    expect(requests.some((url) => url.endsWith("notifystop"))).toBe(true)
  })
})
