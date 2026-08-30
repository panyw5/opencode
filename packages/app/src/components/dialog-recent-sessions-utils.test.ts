import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { latestUserMessageText, mergeRecentSessions } from "./dialog-recent-sessions-utils"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory" | "time">) => input as Session

describe("mergeRecentSessions", () => {
  test("merges nested project sessions by recency and removes duplicates", () => {
    const result = mergeRecentSessions([
      [session({ id: "math", directory: "/math", time: { created: 1, updated: 10 } })],
      [
        session({ id: "opencode", directory: "/opencode/packages/opencode", time: { created: 2, updated: 20 } }),
        session({ id: "math", directory: "/math", time: { created: 1, updated: 10 } }),
      ],
    ])

    expect(result.map((item) => item.id)).toEqual(["opencode", "math"])
  })

  test("filters child and archived sessions", () => {
    const result = mergeRecentSessions([
      [
        session({ id: "root", directory: "/project", time: { created: 1, updated: 3 } }),
        session({ id: "child", directory: "/project", parentID: "root", time: { created: 1, updated: 4 } }),
        session({ id: "archived", directory: "/project", time: { created: 1, updated: 5, archived: 6 } }),
      ],
    ])

    expect(result.map((item) => item.id)).toEqual(["root"])
  })
})

describe("latestUserMessageText", () => {
  test("returns text from the newest user message", () => {
    const items = [
      {
        info: { id: "assistant", role: "assistant", time: { created: 30 } } as Message,
        parts: [{ type: "text", text: "assistant reply" }] as Part[],
      },
      {
        info: { id: "new", role: "user", time: { created: 20 } } as Message,
        parts: [{ type: "text", text: "  latest\nuser message  " }] as Part[],
      },
      {
        info: { id: "old", role: "user", time: { created: 10 } } as Message,
        parts: [{ type: "text", text: "old message" }] as Part[],
      },
    ]

    expect(latestUserMessageText(items)).toBe("latest user message")
  })

  test("ignores synthetic and ignored text parts", () => {
    const items = [
      {
        info: { id: "new", role: "user", time: { created: 20 } } as Message,
        parts: [
          { type: "text", text: "synthetic", synthetic: true },
          { type: "text", text: "ignored", ignored: true },
        ] as Part[],
      },
      {
        info: { id: "old", role: "user", time: { created: 10 } } as Message,
        parts: [{ type: "text", text: "visible" }] as Part[],
      },
    ]

    expect(latestUserMessageText(items)).toBe("visible")
  })
})
