import { describe, expect, test } from "bun:test"
import { __test } from "./qq"

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
})
