import { describe, expect, test } from "bun:test"
import type { SessionMessagePage } from "@/context/global-sync/session-messages"
import { loadShareMessages, shareMarkdown, shareMessages } from "./session-share-model"

const page = (id: string, parts: object[], cursor?: string): SessionMessagePage =>
  ({
    session: [{ id, role: "user" }],
    part: [{ id, part: parts }],
    cursor,
    complete: !cursor,
  }) as SessionMessagePage

describe("session share", () => {
  test("keeps complete visible text and image attachments, not private parts", () => {
    const text = "a".repeat(100_000)
    const result = shareMessages([
      page("1", [
        { type: "text", text },
        { type: "text", text: "hidden", synthetic: true },
        { type: "text", text: "ignored", ignored: true },
        { type: "reasoning", text: "secret" },
        { type: "tool", text: "tool output" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "photo" },
        { type: "file", mime: "text/plain", url: "file:///private/path" },
      ]),
    ])
    expect(result[0].markdown).toBe(`${text}\n\n![photo](data:image/png;base64,AAAA)\n\n[Attachment]`)
  })
  test("loads independent pages with the explicit target and chronological ordering", async () => {
    const inputs: object[] = []
    const result = await loadShareMessages(
      async (input) => {
        inputs.push(input)
        return input.before
          ? page("1", [{ type: "text", text: "first" }])
          : page("2", [{ type: "text", text: "second" }], "older")
      },
      "/target",
      "target-session",
    )
    expect(result.map((item) => item.id)).toEqual(["1", "2"])
    expect(inputs).toEqual([
      { directory: "/target", sessionID: "target-session", limit: 200, before: undefined },
      { directory: "/target", sessionID: "target-session", limit: 200, before: "older" },
    ])
  })
  test("rejects repeated or missing cursors instead of silently truncating history", async () => {
    await expect(loadShareMessages(async () => page("1", [], "same"), "/a", "b")).rejects.toThrow("cursor")
    await expect(loadShareMessages(async () => ({ ...page("1", []), complete: false }), "/a", "b")).rejects.toThrow(
      "cursor",
    )
  })
  test("marks gaps, including leading and trailing omissions", () => {
    const messages = ["1", "2", "3", "4", "5"].map((id) => ({ id, role: "user" as const, markdown: `body ${id}` }))
    const result = shareMarkdown(messages, ["2", "4"], "Title")
    expect(result.match(/Messages omitted/g)?.length).toBe(3)
    expect(result).toContain("body 2")
    expect(result).not.toContain("body 3")
    expect(shareMarkdown(messages, [], "Title")).toBe("# Title\n")
  })
})
