import { describe, expect, test } from "bun:test"
import { parseQuickEditor, quickPromptText } from "./editor-model"
import { buildRequestParts } from "../prompt-input/build-request-parts"
import { merge } from "../prompt-input/expand"

describe("quick assistant rich editor", () => {
  test("keeps file, agent and IM pills with accurate text offsets", () => {
    const editor = document.createElement("div")
    editor.innerHTML =
      'Read <span data-type="file" data-path="notes.md">@notes.md</span> with <span data-type="agent" data-name="explore">@explore</span><br><span data-type="im" data-content="@team" data-channel-name="team" data-bot-name="helper">team</span>'
    const parts = parseQuickEditor(editor)
    expect(quickPromptText(parts)).toBe("Read @notes.md with @explore\n@team")
    expect(parts.find((part) => part.type === "file")).toEqual({
      type: "file",
      path: "notes.md",
      content: "@notes.md",
      start: 5,
      end: 14,
    })
    expect(parts.find((part) => part.type === "agent")).toEqual({
      type: "agent",
      name: "explore",
      content: "@explore",
      start: 20,
      end: 28,
    })
    expect(parts.find((part) => part.type === "im")).toEqual({
      type: "im",
      content: "@team",
      start: 29,
      end: 34,
      channelName: "team",
      botName: "helper",
    })
  })

  test("preserves multiline input and removes editor cursor placeholders", () => {
    const editor = document.createElement("div")
    editor.innerHTML = "<div>**bold**</div><div>$x^2$<br>\u200B</div>"
    expect(quickPromptText(parseQuickEditor(editor))).toBe("**bold**\n$x^2$\n")
    editor.replaceChildren()
    expect(parseQuickEditor(editor)).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("expanded editing retains attachments and submits files relative to the visible project", () => {
    const editor = document.createElement("div")
    editor.innerHTML =
      '<span data-type="file" data-path="notes.md">@notes.md</span> <span data-type="agent" data-name="explore">@explore</span>'
    const image = {
      type: "image" as const,
      id: "image_1",
      filename: "test.txt",
      mime: "text/plain",
      dataUrl: "data:text/plain;base64,dGVzdA==",
    }
    const parts = merge("Review @notes.md using @explore", [...parseQuickEditor(editor), image])
    const result = buildRequestParts({
      prompt: parts,
      context: [],
      images: [image],
      text: quickPromptText(parts),
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/visible-project",
    })
    expect(result.requestParts.map((part) => part.type)).toEqual(["text", "file", "agent", "file"])
    expect(result.requestParts[1]).toMatchObject({
      type: "file",
      url: "file:///visible-project/notes.md",
      source: { path: "/visible-project/notes.md", text: { start: 7, end: 16 } },
    })
    expect(result.requestParts[3]).toMatchObject({ filename: "test.txt", url: image.dataUrl })
  })
})
