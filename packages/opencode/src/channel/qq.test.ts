import { describe, expect, test } from "bun:test"
import { __test, createQQTransport } from "./qq"
import { Target } from "@/im/model"

describe("qq official bot helpers", () => {
  test("maps official private and group events", () => {
    expect(
      __test.messageInfo("C2C_MESSAGE_CREATE", {
        id: "private-message",
        author: { user_openid: "user-openid" },
      }),
    ).toEqual({
      openid: "user-openid",
      chatId: "private:user-openid",
      path: "/v2/users/user-openid/messages",
    })
    expect(
      __test.messageInfo("GROUP_AT_MESSAGE_CREATE", {
        id: "group-message",
        group_openid: "group-openid",
        author: { member_openid: "member-openid" },
      }),
    ).toEqual({
      openid: "member-openid",
      chatId: "group:group-openid",
      path: "/v2/groups/group-openid/messages",
    })
  })

  test("removes official mention markup from content", () => {
    expect(__test.textFromMessage("<@!123456> 请总结")).toBe("请总结")
  })

  test("deduplicates message ids", () => {
    const dedupe = __test.createDedupe(1)
    expect(dedupe.claim("a")).toBe(true)
    expect(dedupe.claim("a")).toBe(false)
    expect(dedupe.claim("b")).toBe(true)
    expect(dedupe.claim("a")).toBe(true)
  })

  test("transport distinguishes proactive and reply targets with bounded sequences", async () => {
    const requests: Array<{ url: string; body: any }> = []
    const transport = createQQTransport({
      name: "test",
      apiBase: "https://qq.example",
      getToken: async () => "token",
      requestJson: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init?.body)) })
        return { id: "sent" }
      },
    })
    const target = new Target({ platform: "qq", channelName: "test", scope: "c2c", conversationID: "private:user" })
    await transport.sendText({ target, mode: "proactive", text: "push" })
    await transport.sendText({ target: new Target({ ...target, replyTo: "inbound" }), mode: "reply", text: "reply" })
    expect(requests[0]).toMatchObject({ url: "https://qq.example/v2/users/user/messages", body: { msg_seq: 1 } })
    expect(requests[0]?.body.msg_id).toBeUndefined()
    expect(requests[1]?.body).toMatchObject({ msg_seq: 1, msg_id: "inbound" })
    await expect(
      transport.sendText({
        target: new Target({ platform: "qq", channelName: "test", scope: "guild", conversationID: "channel:g:c" }),
        mode: "proactive",
        text: "nope",
      }),
    ).rejects.toThrow("unsupported")
  })
})
