import { describe, expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import {
  backgroundTaskInjectionPart,
  formatInjectionPreview,
  injectionPreviewFromParts,
  injectionTextLength,
  injectionTitleFromParts,
  isInjectionKind,
  isInjectionPartsPending,
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
  test("summarizes injected text without joining prompt bodies", () => {
    const parts = [
      text({ text: "first", synthetic: true, metadata: { kind: "scheduled-injection" } }),
      text({ text: "second", synthetic: true, metadata: { kind: "scheduled-injection" } }),
    ]

    expect(injectionTextLength(parts)).toBe("first\n\nsecond".length)
    expect(isInjectionPartsPending(parts)).toBe(false)
  })

  test("detects pending injected prompts without a joined text value", () => {
    const part = text({
      text: "",
      synthetic: true,
      metadata: { kind: "scheduled-injection", pending: true },
    })

    expect(isInjectionPartsPending([part])).toBe(true)
  })

  test("recognizes known injection kinds", () => {
    expect(isInjectionKind("scheduled-injection")).toBe(true)
    expect(isInjectionKind("hook-injection")).toBe(true)
    expect(isInjectionKind("command-injection")).toBe(true)
    expect(isInjectionKind("project-task-injection")).toBe(true)
    expect(isInjectionKind("background-task-injection")).toBe(true)
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
        id: "background",
        text: "Background task completed: inspect bug",
        synthetic: true,
        metadata: {
          kind: "background-task-injection",
          description: "inspect bug",
          childSessionID: "ses_child",
          state: "completed",
        },
      }),
      text({
        id: "shell",
        text: "Background shell completed",
        synthetic: true,
      }),
    ]

    const selected = selectInjectionParts(parts)
    expect(selected).toHaveLength(2)
    expect(selected.map((part) => part.text)).toEqual(["搜索新闻", "Background task completed: inspect bug"])
    expect(isInjectionTextPart(parts[1]!)).toBe(true)
    expect(isInjectionTextPart(parts[2]!)).toBe(true)
    expect(isInjectionTextPart(parts[3]!)).toBe(false)
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

  test("backgroundTaskInjectionPart builds the payload shape", () => {
    expect(
      backgroundTaskInjectionPart({
        text: "Background task completed: inspect bug",
        description: "inspect bug",
        childSessionID: "ses_child",
        state: "completed",
      }),
    ).toEqual({
      type: "text",
      text: "Background task completed: inspect bug",
      synthetic: true,
      metadata: {
        kind: "background-task-injection",
        description: "inspect bug",
        childSessionID: "ses_child",
        state: "completed",
      },
    })
  })

  test.each([
    {
      name: "completed with description",
      metadata: { description: "inspect bug", state: "completed" },
      title: "ui.message.injection.backgroundTaskCompleted:description=inspect bug",
    },
    {
      name: "completed without description",
      metadata: { state: "completed" },
      title: "ui.message.injection.backgroundTaskCompletedFallback",
    },
    {
      name: "failed with description",
      metadata: { description: "inspect bug", state: "error" },
      title: "ui.message.injection.backgroundTaskFailed:description=inspect bug",
    },
    {
      name: "failed without description",
      metadata: { state: "error" },
      title: "ui.message.injection.backgroundTaskFailedFallback",
    },
    {
      name: "unknown state",
      metadata: { description: "inspect bug", state: "cancelled" },
      title: "ui.message.injection.prompt",
    },
  ])("titles background task injections: $name", ({ metadata, title }) => {
    const parts = selectInjectionParts([
      text({
        text: "body",
        synthetic: true,
        metadata: { kind: "background-task-injection", childSessionID: "ses_child", ...metadata },
      }),
    ])
    expect(injectionTitleFromParts(parts, t)).toBe(title)
  })

  test("falls back when background task states conflict", () => {
    const parts = selectInjectionParts([
      text({
        id: "completed",
        text: "done",
        synthetic: true,
        metadata: { kind: "background-task-injection", description: "inspect bug", state: "completed" },
      }),
      text({
        id: "failed",
        text: "failed",
        synthetic: true,
        metadata: { kind: "background-task-injection", description: "inspect bug", state: "error" },
      }),
    ])
    expect(injectionTitleFromParts(parts, t)).toBe("ui.message.injection.prompt")
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
