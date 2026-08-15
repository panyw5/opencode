import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createComputed, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import {
  applyOptimisticAdd,
  applyOptimisticRemove,
  mergeFetchedParts,
  mergeOptimisticPage,
  reconcileFetchedParts,
  reveal,
  shown,
} from "./sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  test("keeps longer streaming text when a session snapshot is stale", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const fetched = { ...textPart("prt_1", sessionID, messageID), text: "partial" }
    const cached = { ...fetched, text: "partial text received from stream" }

    expect(mergeFetchedParts([fetched], [cached])).toEqual([cached])
  })

  test("uses a fetched text part when it is not a prefix of the cached text", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const fetched = { ...textPart("prt_1", sessionID, messageID), text: "new snapshot" }
    const cached = { ...fetched, text: "old stream" }

    expect(mergeFetchedParts([fetched], [cached])).toEqual([fetched])
  })

  test("does not invalidate unchanged part fields when a fetched snapshot is reconciled", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const original = textPart("prt_1", sessionID, messageID)
    const [store, setStore] = createStore({ parts: [original] as Part[] })
    let runs = 0

    createRoot((dispose) => {
      createComputed(() => {
        store.parts[0]?.text
        runs += 1
      })
      setStore("parts", reconcileFetchedParts([{ ...original }]))
      dispose()
    })

    expect(runs).toBe(1)
  })
})

describe("sync history display", () => {
  test("defaults UI display to the initial page instead of all cached messages", () => {
    expect(shown({ cached: 200, page: 80 })).toBe(80)
    expect(shown({ cached: 4, page: 80 })).toBe(4)
  })

  test("reveals cached history without coupling it to prefetch count", () => {
    expect(reveal({ cached: 200, page: 80, step: 40 })).toBe(120)
    expect(reveal({ cached: 400, show: 200, page: 80, step: 40 })).toBe(240)
    expect(reveal({ cached: 100, page: 80, step: 40 })).toBe(100)
  })
})
