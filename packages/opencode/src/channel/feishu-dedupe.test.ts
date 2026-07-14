import { describe, expect, test } from "bun:test"
import { __test } from "./feishu"

const { createMessageDedupe, createChatQueue, extractAssistantText, extractText, parseModel } = __test

describe("feishu message dedupe", () => {
  test("claims each message_id only once", () => {
    const dedupe = createMessageDedupe(10)
    expect(dedupe.claim("m1")).toBe(true)
    expect(dedupe.claim("m1")).toBe(false)
    expect(dedupe.has("m1")).toBe(true)
    expect(dedupe.claim("m2")).toBe(true)
  })

  test("evicts oldest ids when over limit", () => {
    const dedupe = createMessageDedupe(2)
    expect(dedupe.claim("a")).toBe(true)
    expect(dedupe.claim("b")).toBe(true)
    expect(dedupe.claim("c")).toBe(true)
    // "a" should be evicted
    expect(dedupe.has("a")).toBe(false)
    expect(dedupe.claim("a")).toBe(true)
    expect(dedupe.has("b")).toBe(false)
  })
})

describe("feishu chat queue", () => {
  test("runs tasks for the same key serially", async () => {
    const queue = createChatQueue()
    const order: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = queue.enqueue("chat-1", async () => {
      order.push(1)
      await gate
      order.push(2)
    })
    const second = queue.enqueue("chat-1", async () => {
      order.push(3)
    })

    // Second must not start until first finishes
    await Promise.resolve()
    expect(order).toEqual([1])
    release()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2, 3])
  })

  test("different keys can start independently", async () => {
    const queue = createChatQueue()
    const started: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const a = queue.enqueue("a", async () => {
      started.push("a")
      await gateA
    })
    const b = queue.enqueue("b", async () => {
      started.push("b")
    })

    await Promise.resolve()
    expect(started.sort()).toEqual(["a", "b"])
    releaseA()
    await Promise.all([a, b])
  })
})

describe("feishu helpers", () => {
  test("extracts text message body", () => {
    expect(extractText(JSON.stringify({ text: "今天几号？" }), "text")).toBe("今天几号？")
  })

  test("parses provider/model", () => {
    expect(parseModel("aether/gpt-5.5")).toEqual({ providerID: "aether", modelID: "gpt-5.5" })
    expect(parseModel("")).toBeUndefined()
  })

  test("extracts assistant text parts", () => {
    expect(
      extractAssistantText({
        parts: [
          { type: "step-start" },
          { type: "text", text: "2026年7月14日" },
          { type: "text", text: "星期二" },
        ],
      }),
    ).toBe("2026年7月14日\n星期二")
  })

  test("aggregates multi-step assistant text after last user message", () => {
    const { aggregateTurnText } = __test
    const rows = [
      { info: { role: "user" }, parts: [{ type: "text", text: "今天有什么新闻？" }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "tool" }, { type: "step-finish" }],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "## 📰 今日新闻速递\n- 头条A\n- 头条B" }],
      },
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "以上是今天的主要新闻。你对哪条感兴趣？" }],
      },
    ]
    const text = aggregateTurnText(rows)
    expect(text).toContain("今日新闻速递")
    expect(text).toContain("头条A")
    expect(text).toContain("以上是今天的主要新闻")
  })
})
