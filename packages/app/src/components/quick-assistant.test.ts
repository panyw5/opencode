import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  context,
  isSessionNotFoundError,
  mergeMessages,
  patchAgentQuestionDeny,
  prompt,
  quickQuestionAnswers,
  quickRequestNotFound,
  removeQuickRequest,
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

  test("renders current session context block", () => {
    expect(context("/repo", "ses_1", { title: "Demo" } as any, 7)).toBe(
      [
        "<current-opencode-session>",
        "directory: /repo",
        "session_id: ses_1",
        "title: Demo",
        "message_count: 7",
        "</current-opencode-session>",
      ].join("\n"),
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
