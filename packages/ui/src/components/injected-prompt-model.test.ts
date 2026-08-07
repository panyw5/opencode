import { describe, expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import {
  formatInjectionPreview,
  injectionPreviewFromParts,
  injectionTitleFromParts,
  isInjectionKind,
  isInjectionTextPart,
  joinInjectionText,
  scheduledInjectionPart,
  selectInjectionParts,
} from "./injected-prompt-model"

function text(part: Partial<TextPart> & Pick<TextPart, "text">): TextPart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    ...part,
  }
}

const t = (key: string, params?: Record<string, string | number | boolean>) => {
  if (!params) return key
  return key + ":" + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")
}

describe("injected-prompt-model", () => {
  test("recognizes known injection kinds", () => {
    expect(isInjectionKind("scheduled-injection")).toBe(true)
    expect(isInjectionKind("hook-injection")).toBe(true)
    expect(isInjectionKind("command-injection")).toBe(true)
    expect(isInjectionKind("project-task-injection")).toBe(true)
    expect(isInjectionKind("command-invocation")).toBe(false)
  })

  test("selects only synthetic injection text parts", () => {
    const parts: Part[] = [
      text({ text: "hello" }),
      text({
        id: "inj",
        text: "搜索新闻",
        synthetic: true,
        metadata: { kind: "scheduled-injection", taskName: "新闻" },
      }),
      text({
        id: "shell",
        text: "Background shell completed",
        synthetic: true,
      }),
    ]

    const selected = selectInjectionParts(parts)
    expect(selected).toHaveLength(1)
    expect(selected[0].text).toBe("搜索新闻")
    expect(isInjectionTextPart(parts[1]!)).toBe(true)
    expect(isInjectionTextPart(parts[2]!)).toBe(false)
  })

  test("scheduledInjectionPart builds the payload shape", () => {
    expect(
      scheduledInjectionPart({
        text: "do work",
        taskID: "task_1",
        taskName: "daily",
      }),
    ).toEqual({
      type: "text",
      text: "do work",
      synthetic: true,
      metadata: {
        kind: "scheduled-injection",
        taskID: "task_1",
        taskName: "daily",
      },
    })
  })

  test("titles scheduled injections with task name", () => {
    const parts = selectInjectionParts([
      text({
        text: "body",
        synthetic: true,
        metadata: { kind: "scheduled-injection", taskName: "新闻搜刮" },
      }),
    ])
    expect(injectionTitleFromParts(parts, t)).toBe(
      "ui.message.injection.scheduledPrompt:name=新闻搜刮",
    )
  })

  test("falls back title when scheduled task name is missing", () => {
    const parts = selectInjectionParts([
      text({
        text: "body",
        synthetic: true,
        metadata: { kind: "scheduled-injection" },
      }),
    ])
    expect(injectionTitleFromParts(parts, t)).toBe("ui.message.injection.scheduledPromptFallback")
  })

  test("titles project-task injections with task name", () => {
    const parts = selectInjectionParts([
      text({
        text: "<project-task-context mode=\"full\">...",
        synthetic: true,
        metadata: { kind: "project-task-injection", taskName: "0805", taskID: "ptask_1" },
      }),
    ])
    expect(injectionTitleFromParts(parts, t)).toBe(
      "ui.message.injection.projectTaskPrompt:name=0805",
    )
  })

  test("join and preview helpers", () => {
    const parts = selectInjectionParts([
      text({
        id: "a",
        text: "line one\n\nline two",
        synthetic: true,
        metadata: { kind: "hook-injection", hook: "SessionStart" },
      }),
    ])
    expect(joinInjectionText(parts)).toBe("line one\n\nline two")
    expect(formatInjectionPreview(joinInjectionText(parts))).toBe("line one line two")
    expect(injectionPreviewFromParts(parts)).toBe("line one line two")
  })
})
