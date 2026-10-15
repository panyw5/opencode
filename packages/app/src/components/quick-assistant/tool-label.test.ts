import { describe, expect, test } from "bun:test"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { dict as ja } from "@opencode-ai/ui/i18n/ja"
import { dict as fr } from "@opencode-ai/ui/i18n/fr"
import { dict as de } from "@opencode-ai/ui/i18n/de"
import { quickAssistantToolName } from "./tool-label"

const translate = (dict: Record<string, string>) => (key: keyof typeof en) => dict[key] ?? en[key]

describe("quick assistant tool names", () => {
  test.each([
    [en, "Task", "Questions", "Read"],
    [zh, "任务", "问题", "读取"],
    [ja, "タスク", "質問", "読み込み"],
    [fr, "Tâche", "Questions", "Lire"],
    [de, "Aufgabe", "Fragen", "Lesen"],
  ] as const)("uses the shared locale dictionary %#", (dict, task, question, read) => {
    const t = translate(dict)
    expect(quickAssistantToolName("task", t)).toBe(task)
    expect(quickAssistantToolName("question", t)).toBe(question)
    expect(quickAssistantToolName("read", t)).toBe(read)
  })

  test("resolves aliases and tool names whose translation keys differ", () => {
    const t = translate(zh)
    expect(quickAssistantToolName("bash", t)).toBe(zh["ui.tool.shell"])
    expect(quickAssistantToolName("exec", t)).toBe(zh["ui.tool.shell"])
    expect(quickAssistantToolName("apply_patch", t)).toBe(zh["ui.tool.patch"])
    expect(quickAssistantToolName("edit", t)).toBe(zh["ui.messagePart.title.edit"])
    expect(quickAssistantToolName("todowrite", t)).toBe(zh["ui.tool.todos"])
  })

  test("follows language changes without caching translated labels", () => {
    let dict: Record<string, string> = zh
    const t = (key: keyof typeof en) => translate(dict)(key)
    expect(quickAssistantToolName("task", t)).toBe("任务")
    dict = ja
    expect(quickAssistantToolName("task", t)).toBe("タスク")
  })

  test("preserves unknown and custom tool names", () => {
    const t = () => {
      throw new Error("unknown tools must not request a translation")
    }
    expect(quickAssistantToolName("mcp_custom_search", t)).toBe("mcp_custom_search")
    expect(quickAssistantToolName("toString", t)).toBe("toString")
  })
})
