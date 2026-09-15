import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import {
  ChannelInfoSchema,
  ImApi,
  ListQuery,
  SendPayload,
  SubscriptionPayload,
} from "../../src/server/routes/instance/httpapi/groups/im"

describe("channel-first IM API contract", () => {
  test("send requires only a channel name and text", () => {
    expect(
      Schema.decodeUnknownSync(SendPayload)({ channelName: "cc", text: "**rich**", format: "markdown" }).format,
    ).toBe("markdown")
    expect(() => Schema.decodeUnknownSync(SendPayload)({ channelName: "cc", text: "rich", format: "html" })).toThrow()
    expect(Schema.decodeUnknownSync(SendPayload)({ channelName: "cc", text: "hello" })).toEqual({
      channelName: "cc",
      text: "hello",
    })
    expect(Schema.decodeUnknownSync(SendPayload)({ channelName: "cc", text: "hello", id: "notification-1" })).toEqual({
      channelName: "cc",
      text: "hello",
      id: "notification-1",
    })
    expect(() => Schema.decodeUnknownSync(SendPayload)({ text: "hello" })).toThrow()
  })

  test("read and subscription creation do not require chat IDs or grants", () => {
    expect(Schema.decodeUnknownSync(ListQuery)({ channelName: "cc" })).toEqual({ channelName: "cc" })
    expect(() => Schema.decodeUnknownSync(ListQuery)({})).toThrow()
    expect(
      Schema.decodeUnknownSync(SubscriptionPayload)({ sessionID: "ses_owner", channelName: "cc", keyword: "deploy" }),
    ).toEqual({ sessionID: "ses_owner", channelName: "cc", keyword: "deploy" })
  })

  test("channel info strips credentials and internal target IDs", () => {
    const info = Schema.decodeUnknownSync(ChannelInfoSchema)({
      channelName: "cc",
      platform: "feishu",
      enabled: true,
      running: true,
      recipientStatus: "ready",
      recipient: { name: "Owner", senderID: "ou_private" },
      appSecret: "secret",
      conversationID: "oc_private",
    })
    expect(info).toEqual({
      channelName: "cc",
      platform: "feishu",
      enabled: true,
      running: true,
      recipientStatus: "ready",
      recipient: { name: "Owner" },
    })
    expect(JSON.stringify(info)).not.toContain("secret")
  })

  test("OpenAPI removes exact-target access endpoints and documents channel-only requests", () => {
    const spec = OpenApi.fromApi(ImApi)
    expect(spec.paths["/im/channels"]?.get).toBeDefined()
    expect(spec.paths["/im/access"]).toBeUndefined()
    expect(spec.paths["/im/targets"]).toBeUndefined()
    const raw = JSON.stringify(spec.paths["/im/send"]?.post?.requestBody)
    expect(raw).toContain("channelName")
    expect(raw).toContain("text")
    expect(raw).not.toContain("conversationID")
    expect(raw).not.toContain('"target"')
    expect(raw).not.toContain('"mode"')
    expect(raw).not.toContain('"platform"')
  })
})
