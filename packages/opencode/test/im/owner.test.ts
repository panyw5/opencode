import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import type { ConfigChannels } from "../../src/config/channels"
import { Database } from "../../src/storage/db"
import { IMMessageTable } from "../../src/im/inbox.sql"
import { IMOwner } from "../../src/im/owner"
import { IMOwnerTable } from "../../src/im/owner.sql"
import { NormalizedMessage, Target } from "../../src/im/model"
import { Global } from "@opencode-ai/core/global"

function environment(
  initial: Record<string, ConfigChannels.Info>,
  options: IMOwner.Options = { legacyPaths: () => [] },
) {
  let channels = initial
  const config = Layer.succeed(Config.Service, { getGlobal: () => Effect.succeed({ channels }) } as Config.Interface)
  const layer = IMOwner.makeLayer(options).pipe(Layer.provide(config))
  return {
    set: (value: typeof channels) => {
      channels = value
    },
    run: <A, E>(effect: Effect.Effect<A, E, IMOwner.Service>) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}

function record(
  channelName: string,
  config: ConfigChannels.Feishu | ConfigChannels.QQ,
  senderID: string,
  conversationID: string,
  privateChat = true,
) {
  const id = `owner-${crypto.randomUUID()}`
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(IMMessageTable)
      .values({
        id,
        platform: config.type,
        channel_name: channelName,
        event_id: id,
        ingest_seq: now + Math.floor(Math.random() * 1000),
        direction: "inbound",
        legacy_status: "received",
        scope: config.type === "feishu" ? "chat" : privateChat ? "c2c" : "group",
        conversation_id: conversationID,
        sender_id: senderID,
        text: "message",
        metadata: { chatType: privateChat ? "p2p" : "group", appIdentity: IMOwner.appIdentity(config) },
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return new NormalizedMessage({
    id,
    platform: config.type,
    channelName,
    eventID: id,
    target: new Target({
      platform: config.type,
      channelName,
      scope: config.type === "feishu" ? "chat" : privateChat ? "c2c" : "group",
      conversationID,
    }),
    senderID,
    text: "message",
    metadata: { chatType: privateChat ? "p2p" : "group", appIdentity: IMOwner.appIdentity(config) },
  })
}

const feishu: ConfigChannels.Feishu = { type: "feishu", appId: "owner-test-app", appSecret: "unused" }

describe("IM fixed channel recipient", () => {
  test("uses verified private chat owner openID without requiring chat member-read permission", () => {
    expect(
      IMOwner.feishuPrivateOwner({ chat_mode: "p2p", owner_id_type: "open_id", owner_id: "ou_owner" }, "oc_private"),
    ).toEqual({ conversationID: "oc_private", senderID: "ou_owner" })
    expect(
      IMOwner.feishuPrivateOwner(
        { chat_mode: "group", owner_id_type: "open_id", owner_id: "ou_group_owner" },
        "oc_group",
      ),
    ).toBeUndefined()
    expect(
      IMOwner.feishuPrivateOwner({ chat_mode: "p2p", owner_id_type: "user_id", owner_id: "user" }, "oc_private"),
    ).toBeUndefined()
  })
  test("discovers an existing private recipient without any project authorization and persists it across runtimes", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    record(channelName, feishu, "u1", "oc_private")
    const env = environment({ [channelName]: feishu })
    const first = await env.run(IMOwner.resolve(channelName))
    expect(first).toMatchObject({ conversationID: "oc_private", senderID: "u1", channelName })
    expect(await environment({ [channelName]: feishu }).run(IMOwner.resolve(channelName))).toEqual(first)
    expect(await env.run(IMOwner.list())).toEqual([
      { channelName, platform: "feishu", enabled: true, running: false, recipientStatus: "ready", recipient: {} },
    ])
  })

  test("never replaces a persisted recipient with another sender or a group", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    const env = environment({ [channelName]: feishu })
    record(channelName, feishu, "owner", "oc_owner")
    await env.run(IMOwner.resolve(channelName))
    const foreign = record(channelName, feishu, "foreign", "oc_foreign")
    await env.run(Effect.flatMap(IMOwner.Service, (service) => service.observe(foreign)))
    record(channelName, feishu, "owner", "oc_group", false)
    expect(await env.run(IMOwner.resolve(channelName))).toMatchObject({ senderID: "owner", conversationID: "oc_owner" })
  })

  test("rejects ambiguous historical private recipients unless the channel pins one allowed user", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    record(channelName, feishu, "u1", "oc_one")
    record(channelName, feishu, "u2", "oc_two")
    const env = environment({ [channelName]: feishu })
    expect(await env.run(IMOwner.resolve(channelName).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect((await env.run(IMOwner.list()))[0]?.recipientStatus).toBe("ambiguous")
    env.set({ [channelName]: { ...feishu, allowedUsers: ["u2"] } })
    expect(await env.run(IMOwner.resolve(channelName))).toMatchObject({ senderID: "u2", conversationID: "oc_two" })
  })

  test("does not use the previous app's recipient when a configured channel changes app identity", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    const env = environment({ [channelName]: feishu })
    record(channelName, feishu, "old", "oc_old")
    await env.run(IMOwner.resolve(channelName))
    const replacement = { ...feishu, appId: "replacement-app" }
    env.set({ [channelName]: replacement })
    expect(await env.run(IMOwner.resolve(channelName).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    record(channelName, replacement, "new", "oc_new")
    expect(await env.run(IMOwner.resolve(channelName))).toMatchObject({ senderID: "new", conversationID: "oc_new" })
  })

  test("imports legacy mappings only after Feishu verifies a private chat and one user", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    const file = path.join(Global.Path.tmp, `owner-map-${crypto.randomUUID()}.json`)
    await fs.writeFile(
      file,
      JSON.stringify({
        sessions: {
          [`${channelName}::oc_group`]: "ses_old",
          [`${channelName}::oc_private`]: { sessionId: "ses_old", directory: "/tmp" },
        },
      }),
    )
    const calls: string[] = []
    try {
      const env = environment(
        { [channelName]: feishu },
        {
          legacyPaths: () => [file],
          verifyFeishu: async (_config, chat) => {
            calls.push(chat)
            return chat === "oc_private" ? { conversationID: chat, senderID: "owner", name: "Owner" } : undefined
          },
        },
      )
      expect(await env.run(IMOwner.resolve(channelName))).toMatchObject({
        conversationID: "oc_private",
        senderID: "owner",
      })
      expect(calls).toEqual(["oc_group", "oc_private"])
      expect((await env.run(IMOwner.list()))[0]?.recipient).toEqual({ name: "Owner" })
    } finally {
      await fs.unlink(file)
    }
  })

  test("supports QQ private chats, ignores groups, and reports unavailable or unsupported channels", async () => {
    const channelName = `owner-${crypto.randomUUID()}`
    const qq: ConfigChannels.QQ = { type: "qq", appId: "qq-owner-app", clientSecret: "unused" }
    record(channelName, qq, "group-user", "group:one", false)
    const env = environment({
      [channelName]: qq,
      disabled: { ...feishu, enabled: false },
      discord: { type: "discord", botToken: "unused" },
    })
    expect(await env.run(IMOwner.resolve(channelName).pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    record(channelName, qq, "private-user", "private:private-user")
    expect(await env.run(IMOwner.resolve(channelName))).toMatchObject({
      platform: "qq",
      scope: "c2c",
      conversationID: "private:private-user",
      senderID: "private-user",
    })
    expect(await env.run(IMOwner.resolve("disabled").pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect(await env.run(IMOwner.resolve("not-configured").pipe(Effect.exit))).toMatchObject({ _tag: "Failure" })
    expect((await env.run(IMOwner.list())).find((item) => item.channelName === "discord")?.recipientStatus).toBe(
      "unsupported",
    )
    expect(Database.use((db) => db.select().from(IMOwnerTable).all()).length).toBeGreaterThan(0)
  })
})
