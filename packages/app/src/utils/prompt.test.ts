import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { commandInvocationFromParts, extractPromptFromParts, injectionPreviewFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  const base = { sessionID: "ses_1", messageID: "msg_1" }

  test("restores the ignored slash invocation instead of its expanded template", () => {
    const parts = [
      {
        ...base,
        id: "invocation",
        type: "text",
        text: "/ocr paper.pdf",
        ignored: true,
        metadata: { kind: "command-invocation", command: "ocr" },
      },
      {
        ...base,
        id: "template",
        type: "text",
        text: "Expanded command instructions",
        synthetic: true,
        metadata: { kind: "command-injection", command: "ocr" },
      },
      {
        ...base,
        id: "file",
        type: "file",
        mime: "application/pdf",
        filename: "paper.pdf",
        url: "data:application/pdf;base64,AAA",
      },
    ] satisfies Part[]

    expect(extractPromptFromParts(parts)).toEqual([
      { type: "text", content: "/ocr paper.pdf", start: 0, end: 14 },
      {
        type: "image",
        id: "file",
        mime: "application/pdf",
        filename: "paper.pdf",
        dataUrl: "data:application/pdf;base64,AAA",
      },
    ])
  })

  test("restores legacy subtask commands without exposing the expanded prompt", () => {
    const parts = [
      {
        ...base,
        id: "subtask",
        type: "subtask",
        command: "research",
        prompt: "Expanded prompt",
        description: "Research",
        agent: "explore",
      },
    ] satisfies Part[]
    expect(extractPromptFromParts(parts)).toEqual([{ type: "text", content: "/research", start: 0, end: 9 }])
  })

  test("restores ordinary text while still excluding internal injections", () => {
    const parts = [
      { ...base, id: "text", type: "text", text: "hello" },
      { ...base, id: "ignored", type: "text", text: "Internal ignored instructions", ignored: true },
      { ...base, id: "synthetic", type: "text", text: "Internal synthetic instructions", synthetic: true },
    ] satisfies Part[]
    expect(extractPromptFromParts(parts)).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
  })

  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })
})

describe("commandInvocationFromParts", () => {
  test("returns a persisted command invocation with its arguments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "/review packages/app/src",
        ignored: true,
        metadata: { kind: "command-invocation", command: "review" },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(commandInvocationFromParts(parts)).toBe("/review packages/app/src")
  })

  test("returns a slash command for persisted subtask messages", () => {
    const parts = [
      {
        id: "subtask_1",
        type: "subtask",
        command: "research",
        prompt: "Investigate the issue",
        description: "Research",
        agent: "explore",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(commandInvocationFromParts(parts)).toBe("/research")
  })
})

describe("injectionPreviewFromParts", () => {
  test("returns scheduled-injection text for the user-message menu", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "搜索最新的新闻。",
        synthetic: true,
        metadata: {
          kind: "scheduled-injection",
          taskID: "task_1",
          taskName: "新闻搜刮",
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(injectionPreviewFromParts(parts)).toBe("搜索最新的新闻。")
  })

  test("ignores non-injection synthetic text", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "Background shell completed",
        synthetic: true,
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    expect(injectionPreviewFromParts(parts)).toBeUndefined()
  })
})
