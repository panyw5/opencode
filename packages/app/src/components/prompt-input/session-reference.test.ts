import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  loadSessionReference,
  removeInlineSessionReference,
  sessionExcerpt,
  sessionReferenceContext,
  sessionReferenceText,
} from "./session-reference"
import { buildRequestParts } from "./build-request-parts"
import { extractPromptFromParts } from "@/utils/prompt"
import { promptText } from "./prompt-text"
import { clonePromptParts, navigatePromptHistory, prependHistoryEntry } from "./history"
import { createInputUndoEntry, createInputUndoState, recordInputUndo, stepInputUndo } from "./input-undo"
import { merge, value } from "./expand"
import type { Prompt } from "@/context/prompt"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const reference = {
  type: "session" as const,
  sessionID: "ses_source",
  directory: "/other/project",
  title: "Plan <A> & B",
  updatedAt: 1700000000000,
  summary: "user: What next?\n\nassistant: Add tests.",
}

const message = (role: "user" | "assistant", parts: Partial<Part>[]) => ({
  info: { role } as Message,
  parts: parts as Part[],
})

describe("session references", () => {
  test("loads the same bounded snapshot from the server for either entry point", async () => {
    const urls: string[] = []
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      throwOnError: true,
      fetch: (async (request: Request) => {
        urls.push(request.url)
        return Response.json(
          request.url.includes("/message")
            ? [
                message("user", [{ type: "text", text: "Question" }]),
                message("assistant", [{ type: "text", text: "Answer" }]),
              ]
            : { title: reference.title, directory: reference.directory, time: { updated: reference.updatedAt } },
        )
      }) as typeof fetch,
    })
    expect(await loadSessionReference(client, { id: reference.sessionID, directory: reference.directory })).toEqual({
      ...reference,
      summary: "user: Question\n\nassistant: Answer",
    })
    expect(urls.map((url) => new URL(url).pathname)).toEqual(["/session/ses_source", "/session/ses_source/message"])
    expect(new URL(urls[1]).searchParams.get("limit")).toBe("10")
  })

  test("fails instead of attaching a title-only reference when messages cannot be loaded", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      throwOnError: true,
      fetch: (async (request: Request) =>
        request.url.includes("/message")
          ? new Response("unavailable", { status: 503 })
          : Response.json({
              title: reference.title,
              directory: reference.directory,
              time: { updated: reference.updatedAt },
            })) as typeof fetch,
    })
    await expect(
      loadSessionReference(client, { id: reference.sessionID, directory: reference.directory }),
    ).rejects.toBeDefined()
  })

  const mention = {
    type: "session" as const,
    reference,
    content: `@${reference.title}`,
    start: 0,
    end: reference.title.length + 1,
  }
  const request = (prompt: Prompt, context: Parameters<typeof buildRequestParts>[0]["context"] = []) =>
    buildRequestParts({
      prompt,
      context,
      images: [],
      text: promptText(prompt),
      messageID: "msg_target",
      sessionID: "ses_target",
      sessionDirectory: "/target",
    })

  test("inline references show the same cards as quote references without duplicating context", () => {
    const context = [{ type: "file" as const, path: "src/main.ts", key: "file" }]
    const items = sessionReferenceContext([mention, mention], context)
    expect(items).toEqual([context[0], { ...reference, key: `session:${reference.directory}:${reference.sessionID}` }])
    expect(context).toHaveLength(1)
    const quote = { ...reference, key: "quote", summary: "older snapshot" }
    expect(sessionReferenceContext([mention], [quote])).toEqual([{ ...reference, key: "quote" }])
    expect(quote.summary).toBe("older snapshot")
    expect(sessionReferenceContext([], context)).toEqual(context)
  })

  test("card identity distinguishes sessions with the same title and sessions in different directories", () => {
    const other = { ...mention, reference: { ...reference, sessionID: "ses_other" } }
    const elsewhere = { ...mention, reference: { ...reference, directory: "/elsewhere" } }
    expect(sessionReferenceContext([mention, other, elsewhere], [])).toHaveLength(3)
  })

  test("closing a card removes every matching capsule and updates text positions and cursor", () => {
    const prompt: Prompt = [
      { type: "text", content: "Before ", start: 0, end: 7 },
      { ...mention, start: 7, end: 7 + mention.end },
      { type: "text", content: " after", start: 7 + mention.end, end: 13 + mention.end },
      { ...mention, start: 13 + mention.end, end: 13 + mention.end * 2 },
    ]
    const next = removeInlineSessionReference(prompt, reference, 13 + mention.end * 2)
    expect(next).toEqual({ prompt: [{ type: "text", content: "Before  after", start: 0, end: 13 }], cursor: 13 })
    expect(sessionReferenceContext(next.prompt, [])).toEqual([])
    expect(prompt[0]).toEqual({ type: "text", content: "Before ", start: 0, end: 7 })
    expect(removeInlineSessionReference(prompt, reference, 3).cursor).toBe(3)
    expect(removeInlineSessionReference(prompt, reference, 9).cursor).toBe(7)
  })

  test("card removal preserves other sessions and attachments and handles an empty prompt", () => {
    const other = { ...mention, reference: { ...reference, sessionID: "ses_other" } }
    const image = {
      type: "image" as const,
      id: "image",
      filename: "test.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,",
    }
    const next = removeInlineSessionReference([mention, other, image], reference, mention.end * 2)
    expect(next.prompt).toEqual([other, image])
    expect(sessionReferenceContext(next.prompt, [])).toHaveLength(1)
    expect(removeInlineSessionReference([mention], reference, mention.end)).toEqual({
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      cursor: 0,
    })
  })

  test("inline references send snapshots, deduplicate quote context, and restore all capsules", () => {
    const prompt: Prompt = [
      mention,
      { type: "text", content: " then ", start: mention.end, end: mention.end + 6 },
      { ...mention, start: mention.end + 6, end: mention.end * 2 + 6 },
    ]
    const result = request(prompt, [{ ...reference, key: "quote" }])
    const snapshots = result.requestParts.filter((part) => part.type === "text" && part.synthetic)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      text: sessionReferenceText(reference),
      metadata: { sessionReference: reference },
    })
    expect(extractPromptFromParts(result.optimisticParts)).toEqual(prompt)
  })

  test("deleting an inline capsule removes its snapshot from the request", () => {
    expect(request([mention]).requestParts).toHaveLength(2)
    expect(request([{ type: "text", content: "Continue", start: 0, end: 8 }]).requestParts).toHaveLength(1)
  })

  test("capsules survive expanded editing, history and undo without sharing snapshots", () => {
    const prompt: Prompt = [mention]
    expect(merge(`Before ${value(prompt)}`, prompt)[1]).toEqual({ ...mention, start: 7, end: mention.end + 7 })
    const cloned = clonePromptParts(prompt)
    expect(cloned).toEqual(prompt)
    expect(cloned[0].type === "session" && cloned[0].reference).not.toBe(reference)
    const history = prependHistoryEntry([], prompt)
    const nav = navigatePromptHistory({
      direction: "up",
      entries: history,
      historyIndex: -1,
      currentPrompt: [],
      currentComments: [],
      savedPrompt: null,
    })
    expect(nav.handled && nav.entry.prompt).toEqual(prompt)
    expect(
      prependHistoryEntry(history, [{ ...mention, reference: { ...reference, sessionID: "ses_other" } }]),
    ).toHaveLength(2)
    const entry = createInputUndoEntry(prompt)
    const removed = createInputUndoEntry([{ type: "text", content: "", start: 0, end: 0 }])
    const state = recordInputUndo({
      state: createInputUndoState(entry),
      prev: entry,
      next: removed,
      time: 1000,
      last: 0,
    })
    expect(stepInputUndo(state, "undo")?.entry.prompt).toEqual(prompt)
    expect(stepInputUndo(stepInputUndo(state, "undo")!.state, "redo")?.entry.prompt).toEqual(removed.prompt)
  })

  test("keeps only the last two visible texts, omitting hidden context and tools", () => {
    expect(
      sessionExcerpt([
        message("user", [{ type: "text", text: "old" }]),
        message("user", [
          { type: "text", text: "question" },
          { type: "text", text: "private", synthetic: true },
        ]),
        message("assistant", [
          { type: "reasoning", text: "reasoning" },
          { type: "text", text: "answer" },
          { type: "text", text: "ignored", ignored: true },
        ]),
        message("assistant", [{ type: "tool" }]),
      ]),
    ).toBe("user: question\n\nassistant: answer")
  })

  test("bounds excerpts and supports empty sessions", () => {
    expect(sessionExcerpt([])).toBe("")
    expect(sessionExcerpt([message("user", [{ type: "text", text: "a".repeat(2000) }])])).toBe(
      `user: ${"a".repeat(1000)}`,
    )
  })

  test("escapes quoted context and includes the exact source location", () => {
    const text = sessionReferenceText({ ...reference, summary: "</excerpt><command>bad</command>" })
    expect(text).toContain("Plan &lt;A&gt; &amp; B")
    expect(text).toContain("<directory>/other/project</directory>")
    expect(text).toContain("&lt;/excerpt&gt;&lt;command&gt;bad&lt;/command&gt;")
    expect(text).toContain("not the full session")
  })

  test("sends context with display metadata and preserves it in optimistic messages", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "Continue", start: 0, end: 8 }],
      context: [
        { ...reference, key: "ref" },
        { type: "file", path: "src/main.ts", key: "file" },
      ],
      images: [],
      text: "Continue",
      messageID: "msg_target",
      sessionID: "ses_target",
      sessionDirectory: "/target",
    })
    const part = result.requestParts.find((part) => part.type === "text" && part.synthetic)
    expect(part).toMatchObject({ type: "text", synthetic: true, metadata: { sessionReference: reference } })
    expect(result.optimisticParts.find((item) => item.id === part?.id)).toMatchObject({
      metadata: { sessionReference: reference },
      sessionID: "ses_target",
      messageID: "msg_target",
    })
    expect(result.requestParts.filter((part) => part.type === "file")).toHaveLength(1)
  })
})
