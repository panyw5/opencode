import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  collectSessionContext,
  context,
  fullSessionContextMessages,
  isSessionNotFoundError,
  mergeMessages,
  patchAgentQuestionDeny,
  prompt,
  quickQuestionAnswers,
  quickRequestNotFound,
  removeQuickRequest,
  splitInjectedSessionContext,
} from "./quick-assistant/helpers"
import { quickAssistantMessageText } from "./quick-assistant/messages"

const msg = (id: string, role: "user" | "assistant") =>
  ({
    id,
    sessionID: "ses_1",
    role,
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt-5" },
  }) as Message

describe("mergeMessages", () => {
  test("preserves optimistic messages when fetched history is stale", () => {
    const result = mergeMessages([msg("msg_2", "user")], [])
    expect(result.map((item) => item.id)).toEqual(["msg_2"])
  })

  test("deduplicates by id and keeps fetched updates", () => {
    const result = mergeMessages([msg("msg_1", "user")], [msg("msg_1", "assistant"), msg("msg_2", "assistant")])
    expect(result.map((item) => `${item.id}:${item.role}`)).toEqual(["msg_1:assistant", "msg_2:assistant"])
  })
})

describe("quick assistant prompt", () => {
  test("omits current session context by default", () => {
    expect(prompt("ship it", "<current-opencode-session>\nfoo\n</current-opencode-session>", false)).toBe("ship it")
  })

  test("prepends current session context when enabled", () => {
    expect(prompt("ship it", "<current-opencode-session>\nfoo\n</current-opencode-session>", true)).toBe(
      "<current-opencode-session>\nfoo\n</current-opencode-session>\n\nship it",
    )
  })

  test("separates injected context from the visible question", () => {
    const extra = context("/repo", "ses_1", { title: "Demo" } as any, 7)
    expect(splitInjectedSessionContext(prompt("What changed?", extra, true))).toEqual({
      context: extra,
      message: "What changed?",
    })
  })

  test("leaves ordinary and incomplete messages unchanged", () => {
    expect(splitInjectedSessionContext("What changed?")).toEqual({ message: "What changed?" })
    expect(splitInjectedSessionContext("<current-opencode-session>\ndirectory: /repo")).toEqual({
      message: "<current-opencode-session>\ndirectory: /repo",
    })
  })

  test("renders current session context block", () => {
    expect(context("/repo", "ses_1", { title: "Demo" } as any, 7)).toBe(
      [
        "<current-opencode-session>",
        "directory: /repo",
        "session_id: ses_1",
        "title: Demo",
        "message_count: 7",
        "history_scope: complete",
        "text_scope: 0 bounded excerpts",
        "snapshot_source: OpenCode app",
        "snapshot_note: The messages below were attached by the app. Do not try to read this session through a localhost URL or SQLite.",
        "</current-opencode-session>",
      ].join("\n"),
    )
  })

  test("includes the attached session snapshot without an unauthenticated URL", () => {
    const block = context("/repo", "ses_1", { title: "Demo" } as any, 7, {
      messages: [
        { role: "user", text: "What changed?" },
        { role: "assistant", text: "Updated the parser." },
      ],
      complete: false,
    })
    expect(block).toContain("history_scope: partial\ntext_scope: 2 bounded excerpts")
    expect(block).toContain(
      [
        "<session-messages>",
        '<message role="user">',
        "What changed?",
        "</message>",
        '<message role="assistant">',
        "Updated the parser.",
      ].join("\n"),
    )
    expect(block).not.toContain("messages_url")
  })

  test("builds a bounded whole-session snapshot and ignores synthetic text", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      info: msg(`msg_${index.toString().padStart(2, "0")}`, index % 2 ? "assistant" : "user"),
      parts: [
        { type: "text", text: `${index}:` + "x".repeat(4_000) },
        { type: "text", text: "hidden", synthetic: true },
      ] as Part[],
    }))
    const result = fullSessionContextMessages(items)

    expect(result[0]?.text.startsWith("0:")).toBe(true)
    expect(result.at(-1)?.text.startsWith("11:")).toBe(true)
    expect(result.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(20_000)
    expect(result.some((item) => item.text.includes("hidden"))).toBe(false)
  })

  test("collects paginated session messages in chronological order", async () => {
    const calls: Array<string | undefined> = []
    const result = await collectSessionContext(async (before) => {
      calls.push(before)
      if (!before) return { items: [{ info: msg("msg_3", "assistant"), parts: [] }], cursor: "older" }
      return {
        items: [
          { info: msg("msg_1", "user"), parts: [] },
          { info: msg("msg_2", "assistant"), parts: [] },
        ],
      }
    })
    expect(calls).toEqual([undefined, "older"])
    expect(result.items.map((item) => item.info.id)).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(result.complete).toBe(true)
    expect(result.pages).toBe(2)
  })

  test("marks capped pagination partial and rejects repeated cursors", async () => {
    const capped = await collectSessionContext(
      async () => ({ items: [{ info: msg("msg_1", "user"), parts: [] }], cursor: "older" }),
      1,
    )
    expect(capped.complete).toBe(false)
    expect(collectSessionContext(async () => ({ items: [], cursor: "same" }))).rejects.toThrow(
      "pagination did not advance",
    )
  })
})

describe("quick assistant message copy", () => {
  test("uses rendered message text for copy content", () => {
    expect(
      quickAssistantMessageText([
        { type: "text", text: "hello" },
        { type: "tool", tool: "bash" },
        { type: "file", filename: "notes.md", url: "file:///tmp/notes.md" },
      ] as Part[]),
    ).toBe(["hello", "[tool] bash", "[file] notes.md"].join("\n"))
  })
})

describe("quick assistant session error handling", () => {
  test("recognizes generated SDK throwOnError not-found errors", () => {
    const err = new Error("Session not found: ses_missing", {
      cause: {
        status: 404,
        body: {
          name: "NotFoundError",
          data: { message: "Session not found: ses_missing" },
        },
      },
    })

    expect(isSessionNotFoundError(err)).toBe(true)
  })

  test("recognizes v2 session not-found errors", () => {
    expect(
      isSessionNotFoundError({
        cause: {
          body: {
            name: "SessionNotFoundError",
            data: { sessionID: "ses_missing" },
          },
        },
      }),
    ).toBe(true)
  })

  test("does not treat unrelated errors as missing sessions", () => {
    expect(isSessionNotFoundError(new Error("network failed"))).toBe(false)
    expect(isSessionNotFoundError({ name: "ProviderModelNotFoundError" })).toBe(false)
  })
})

describe("quick assistant config migration", () => {
  test("removes only the legacy forced question deny", () => {
    expect(patchAgentQuestionDeny({ permission: { question: "deny", bash: "ask" } })).toEqual({
      permission: { question: "allow", bash: "ask" },
    })
  })

  test("preserves explicit non-deny question policies", () => {
    expect(patchAgentQuestionDeny({ permission: { question: "ask" } })).toEqual({
      permission: { question: "ask" },
    })
  })
})

describe("quick assistant question answers", () => {
  test("ignores forbidden custom text and trims empty custom input", () => {
    expect(quickQuestionAnswers([{ custom: false }, {}], { 0: ["A"] }, { 0: "forbidden", 1: "  " })).toEqual([
      ["A"],
      [],
    ])
  })

  test("deduplicates custom multi-choice answers", () => {
    expect(quickQuestionAnswers([{ multiple: true }], { 0: ["A", "B"] }, { 0: " B " })).toEqual([["A", "B"]])
  })

  test("does not mutate selected answers", () => {
    const selected = { 0: ["A"] }
    quickQuestionAnswers([{ multiple: true }], selected, { 0: "B" })
    expect(selected).toEqual({ 0: ["A"] })
  })
  test("appends custom text for multiple choice and replaces single choice", () => {
    expect(
      quickQuestionAnswers([{ multiple: true }, { multiple: false }], { 0: ["A", "B"], 1: ["X"] }, { 0: "C", 1: "Y" }),
    ).toEqual([["A", "B", "C"], ["Y"]])
  })
})

describe("quick assistant expired requests", () => {
  test("cleanup tolerates a list already removed by the backend event", () => {
    expect(removeQuickRequest(undefined, "old")).toEqual([])
    expect(removeQuickRequest([{ id: "next" }, { id: "old" }], "old")).toEqual([{ id: "next" }])
    expect(removeQuickRequest([], "old")).toEqual([])
  })
  test("recognizes nested SDK not-found responses", () => {
    expect(quickRequestNotFound(new Error("gone", { cause: { status: 404 } }))).toBe(true)
    expect(quickRequestNotFound({ body: { name: "QuestionNotFoundError" } })).toBe(true)
  })

  test("keeps retryable failures and handles cycles", () => {
    const error: { cause?: unknown; status: number } = { status: 500 }
    error.cause = error
    expect(quickRequestNotFound(error)).toBe(false)
  })
})
