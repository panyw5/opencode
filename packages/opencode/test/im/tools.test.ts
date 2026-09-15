import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { IMOwner } from "../../src/im/owner"
import { IM } from "../../src/im/service"
import { NormalizedMessage, Target, messageRecordID } from "../../src/im/model"
import { IMSubscription } from "../../src/im/subscription"
import { registry, transportCapabilities } from "../../src/im/transport"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { IMListTool, IMReadTool, IMSendTool, IMWatchTool } from "../../src/tool/im"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const fixedTarget = new Target({
  platform: "feishu",
  channelName: "tool-test",
  scope: "chat",
  conversationID: "chat-tool-test",
  senderID: "owner-tool-test",
})
let currentTarget = fixedTarget
const ownerLayer = Layer.mock(IMOwner.Service, {
  resolve: () => Effect.sync(() => currentTarget),
  list: () =>
    Effect.succeed([
      {
        channelName: "tool-test",
        platform: "feishu" as const,
        enabled: true,
        running: true,
        recipientStatus: "ready" as const,
        recipient: { name: "Owner" },
      },
    ]),
})
const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Truncate.defaultLayer,
    Session.defaultLayer,
    IM.defaultLayer,
    IMSubscription.layer.pipe(Layer.provide(ownerLayer)),
    ownerLayer,
  ),
)

afterEach(async () => {
  currentTarget = fixedTarget
  registry.unregister("tool-test")
  await disposeAllInstances()
})

const context = (sessionID: SessionID, ask: Tool.Context["ask"], callID = "call-owner-send"): Tool.Context => ({
  sessionID,
  callID,
  messageID: MessageID.make(`msg_${crypto.randomUUID()}`),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

describe("channel-only IM tools", () => {
  it.instance("lists configured channels without any project target grants", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* IMListTool).init()
      const session = yield* (yield* Session.Service).create({ title: "IM channels" })
      const result = yield* tool.execute(
        {},
        context(session.id, () => Effect.void),
      )
      expect(JSON.parse(result.output)).toEqual([
        {
          channelName: "tool-test",
          platform: "feishu",
          enabled: true,
          running: true,
          recipientStatus: "ready",
          recipient: { name: "Owner" },
        },
      ])
      expect(result.output).not.toContain("conversationID")
    }),
  )

  it.instance("sends with channel and text only and uses a stable tool-call idempotency key", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* IMSendTool).init()
      const session = yield* (yield* Session.Service).create({ title: "IM send" })
      const calls: unknown[] = []
      registry.register({
        platform: "feishu",
        channelName: "tool-test",
        capabilities: transportCapabilities("feishu"),
        sendText: async (input) => {
          calls.push(input)
          return { providerMessageID: "provider-tool", timeSent: Date.now() }
        },
      })
      const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []
      const ctx = context(session.id, (request) =>
        Effect.sync(() => {
          asks.push(request)
        }),
      )
      const first = yield* tool.execute({ channelName: "tool-test", text: "hello owner" }, ctx)
      const retry = yield* tool.execute({ channelName: "tool-test", text: "hello owner", id: " " }, ctx)
      expect(JSON.parse(first.output).status).toBe("sent")
      expect(JSON.parse(first.output).id).toBe(`tool:${session.id}:${ctx.callID}`)
      expect(JSON.parse(retry.output).providerMessageID).toBe("provider-tool")
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        target: { conversationID: "chat-tool-test" },
        text: "hello owner",
        mode: "proactive",
      })
      expect(asks[0]?.patterns).toEqual(["tool-test"])
      const changed = yield* tool.execute({ channelName: "tool-test", text: "different" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(changed)).toBe(true)
      const rich = yield* tool.execute(
        { channelName: "tool-test", text: "**rich**", format: "markdown", id: "rich-tool" },
        ctx,
      )
      expect(JSON.parse(rich.output).format).toBe("markdown")
      expect(calls.at(-1)).toMatchObject({ format: "markdown", text: "**rich**" })
    }),
  )

  it.instance("reads only the resolved fixed user and private chat", () =>
    Effect.gen(function* () {
      const im = yield* IM.Service
      const prefix = crypto.randomUUID()
      for (const [chat, sender, text] of [
        [fixedTarget.conversationID, fixedTarget.senderID!, prefix],
        [fixedTarget.conversationID, "stranger", "not-owner"],
        ["different-chat", fixedTarget.senderID!, "not-owner-chat"],
      ]) {
        const eventID = `tools-read-${crypto.randomUUID()}`
        yield* im.ingest({
          message: new NormalizedMessage({
            id: messageRecordID("feishu", "tool-test", eventID),
            platform: "feishu",
            channelName: "tool-test",
            eventID,
            target: new Target({ ...fixedTarget, conversationID: chat, senderID: sender }),
            senderID: sender,
            text,
          }),
        })
      }
      const tool = yield* (yield* IMReadTool).init()
      const session = yield* (yield* Session.Service).create({ title: "IM read" })
      const result = yield* tool.execute(
        { channelName: "tool-test", direction: "before" },
        context(session.id, () => Effect.void),
      )
      const rows = JSON.parse(result.output).items as Array<{ senderID: string; target: Target; text: string }>
      expect(rows.some((item) => item.text === prefix)).toBe(true)
      expect(
        rows.every(
          (item) => item.senderID === fixedTarget.senderID && item.target.conversationID === fixedTarget.conversationID,
        ),
      ).toBe(true)
    }),
  )

  it.instance("creates an owner-only watch and lists only the current session subscriptions", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* IMWatchTool).init()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "IM watch" })
      const other = yield* sessions.create({ title: "Other session" })
      const created = yield* tool.execute(
        { channelName: "tool-test", keyword: "deploy" },
        context(session.id, () => Effect.void),
      )
      const row = JSON.parse(created.output)
      expect(row.status).toBe("active")
      expect(row.target.conversationID).toBe(fixedTarget.conversationID)
      expect(row.target.senderID ?? row.senderID).toBe(fixedTarget.senderID)
      const listed = yield* tool.execute(
        { action: "list" },
        context(session.id, () => Effect.void),
      )
      const otherListed = yield* tool.execute(
        { action: "list" },
        context(other.id, () => Effect.void),
      )
      expect(JSON.parse(listed.output)).toHaveLength(1)
      expect(JSON.parse(otherListed.output)).toEqual([])
    }),
  )

  it.instance("retains session ownership and refuses to resume a watch after recipient changes", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* IMWatchTool).init()
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "IM owner" })
      const other = yield* sessions.create({ title: "IM other" })
      const created = yield* tool.execute(
        { channelName: "tool-test" },
        context(session.id, () => Effect.void),
      )
      const subscriptionID = JSON.parse(created.output).id as string
      const denied = yield* tool
        .execute(
          { action: "pause", subscriptionID },
          context(other.id, () => Effect.void),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
      const paused = yield* tool.execute(
        { action: "pause", subscriptionID },
        context(session.id, () => Effect.void),
      )
      expect(JSON.parse(paused.output).status).toBe("paused")
      const resumed = yield* tool.execute(
        { action: "resume", subscriptionID },
        context(session.id, () => Effect.void),
      )
      expect(JSON.parse(resumed.output).status).toBe("active")
      yield* tool.execute(
        { action: "pause", subscriptionID },
        context(session.id, () => Effect.void),
      )
      currentTarget = new Target({ ...fixedTarget, conversationID: "changed-chat" })
      const changed = yield* tool
        .execute(
          { action: "resume", subscriptionID },
          context(session.id, () => Effect.void),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(changed)).toBe(true)
      const stopped = yield* tool.execute(
        { action: "stop", subscriptionID },
        context(session.id, () => Effect.void),
      )
      expect(JSON.parse(stopped.output).status).toBe("stopped")
    }),
  )

  it.instance("rejects incomplete actions and non-idempotent sends without a tool call ID", () =>
    Effect.gen(function* () {
      const watch = yield* (yield* IMWatchTool).init()
      const send = yield* (yield* IMSendTool).init()
      const session = yield* (yield* Session.Service).create({ title: "IM validation" })
      const ctx = context(session.id, () => Effect.void)
      const invalidCreate = yield* watch.execute({ action: "create" }, ctx).pipe(Effect.exit)
      const invalidPause = yield* watch.execute({ action: "pause" }, ctx).pipe(Effect.exit)
      const invalidSend = yield* send
        .execute({ channelName: "tool-test", text: "hello" }, { ...ctx, callID: undefined })
        .pipe(Effect.exit)
      expect(Exit.isFailure(invalidCreate)).toBe(true)
      expect(Exit.isFailure(invalidPause)).toBe(true)
      expect(Exit.isFailure(invalidSend)).toBe(true)
    }),
  )
})
