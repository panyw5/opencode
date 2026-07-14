import { describe, expect, test } from "bun:test"
import {
  buildTaskCardJson,
  finalTextFromMessages,
  stepFromAssistant,
  stepsFromMessages,
} from "./feishu-card"

describe("feishu task card", () => {
  test("builds schema 2.0 card with collapsible panels and final answer", () => {
    const raw = buildTaskCardJson({
      status: "✅ 已完成",
      steps: [
        { summary: "webfetch", detail: "### 🛠 Tool Calls\n- `webfetch`" },
        { summary: "今日新闻", detail: "### 📝 Output\n头条新闻…" },
      ],
      final: "以上是今天的主要新闻。",
    })
    const card = JSON.parse(raw) as {
      schema: string
      body: { elements: Array<{ tag: string; header?: { title?: { content?: string } }; content?: string }> }
    }
    expect(card.schema).toBe("2.0")
    const tags = card.body.elements.map((e) => e.tag)
    expect(tags).toContain("collapsible_panel")
    expect(tags.filter((t) => t === "collapsible_panel")).toHaveLength(2)
    expect(tags).toContain("hr")
    const panels = card.body.elements.filter((e) => e.tag === "collapsible_panel")
    expect(panels[0]?.header?.title?.content).toContain("Turn 1")
    expect(panels[1]?.header?.title?.content).toContain("Turn 2")
  })

  test("builds steps and final text from multi-assistant turn", () => {
    const rows = [
      { info: { role: "user" }, parts: [{ type: "text", text: "今天有什么新闻？" }] },
      {
        info: { role: "assistant", finish: "tool-calls" },
        parts: [
          { type: "tool", tool: "webfetch", state: { status: "completed", input: { url: "https://x" } } },
        ],
      },
      {
        info: { role: "assistant", finish: "tool-calls" },
        parts: [{ type: "text", text: "## 今日新闻\n- A\n- B" }],
      },
      {
        info: { role: "assistant", finish: "stop" },
        parts: [{ type: "text", text: "以上是今天的主要新闻。" }],
      },
    ]
    const steps = stepsFromMessages(rows)
    expect(steps).toHaveLength(3)
    expect(steps[0]?.summary).toContain("webfetch")
    expect(steps[0]?.detail).toContain("Tool Calls")
    expect(steps[1]?.detail).toContain("今日新闻")
    expect(finalTextFromMessages(rows)).toContain("今日新闻")
    expect(finalTextFromMessages(rows)).toContain("以上是今天的主要新闻")
  })

  test("stepFromAssistant skips empty noise-only rows without activity", () => {
    expect(stepFromAssistant({ info: { role: "assistant" }, parts: [] })).toBeNull()
  })
})
