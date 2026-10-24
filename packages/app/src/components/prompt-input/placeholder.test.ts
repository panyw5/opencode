import { describe, expect, test } from "bun:test"
import { dict as en } from "../../i18n/en"
import { dict as zh } from "../../i18n/zh"
import { promptPlaceholder, promptPlaceholderSuggestions } from "./placeholder"

describe("promptPlaceholderSuggestions", () => {
  test.each([
    { desktop: true, remoteMode: false, tempAttachment: true, count: 33 },
    { desktop: true, remoteMode: false, tempAttachment: false, count: 32 },
    { desktop: true, remoteMode: true, tempAttachment: true, count: 30 },
    { desktop: true, remoteMode: true, tempAttachment: false, count: 29 },
    { desktop: false, remoteMode: false, tempAttachment: true, count: 30 },
    { desktop: false, remoteMode: false, tempAttachment: false, count: 29 },
    { desktop: false, remoteMode: true, tempAttachment: true, count: 29 },
    { desktop: false, remoteMode: true, tempAttachment: false, count: 28 },
  ])("filters unsupported tips for %j", (input) => {
    const suggestions = promptPlaceholderSuggestions({ ...input, remoteAccess: true })
    expect(suggestions).toHaveLength(input.count)
    expect(suggestions.includes("prompt.suggestion.hint.expandEditor")).toBe(input.desktop)
    expect(suggestions.includes("prompt.suggestion.hint.backgroundShell")).toBe(!input.remoteMode)
    expect(suggestions.includes("prompt.suggestion.hint.backgroundShellManager")).toBe(
      input.desktop && !input.remoteMode,
    )
    expect(suggestions.includes("prompt.suggestion.hint.tempAttachment")).toBe(input.tempAttachment)
    expect(suggestions.includes("prompt.suggestion.hint.remoteAccess")).toBe(input.desktop && !input.remoteMode)
    expect(suggestions).toContain("prompt.suggestion.hint.projectTasks")
    expect(suggestions).toContain("prompt.suggestion.hint.quickAssistant")
    expect(suggestions).toContain("prompt.suggestion.hint.sessionReferences")
    expect(suggestions).toContain("prompt.suggestion.hint.contextMenus")
    expect(suggestions).toContain("prompt.suggestion.hint.backgroundSubagent")
    expect(suggestions).toContain("prompt.suggestion.hint.readingMode")
    expect(new Set(suggestions).size).toBe(suggestions.length)
    for (const key of suggestions) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })

  test("hides remote access setup without the desktop capability", () => {
    const input = { desktop: true, tempAttachment: true }
    expect(promptPlaceholderSuggestions(input)).not.toContain("prompt.suggestion.hint.remoteAccess")
    expect(promptPlaceholderSuggestions({ ...input, remoteAccess: false })).not.toContain(
      "prompt.suggestion.hint.remoteAccess",
    )
  })

  test("preserves tip order and prepends temporary attachment only when available", () => {
    const input = { desktop: true, tempAttachment: false, remoteAccess: true }
    const base = promptPlaceholderSuggestions(input)
    expect(base[0]).toBe("prompt.suggestion.hint.sendKeepView")
    expect(promptPlaceholderSuggestions({ ...input, tempAttachment: true })).toEqual([
      "prompt.suggestion.hint.tempAttachment",
      ...base,
    ])
    expect(promptPlaceholderSuggestions({ ...input, desktop: false, remoteMode: true })).toEqual(
      base.filter(
        (key) =>
          key !== "prompt.suggestion.hint.expandEditor" &&
          key !== "prompt.suggestion.hint.backgroundShell" &&
          key !== "prompt.suggestion.hint.backgroundShellManager" &&
          key !== "prompt.suggestion.hint.remoteAccess",
      ),
    )
  })
})

describe("promptPlaceholder", () => {
  const t = (key: string, params?: Record<string, string>) =>
    `${key}${params?.suggestion ? `:${params.suggestion}` : ""}`

  test("returns shell placeholder in shell mode", () => {
    const value = promptPlaceholder({
      mode: "shell",
      commentCount: 0,
      suggestion: "example",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.shell")
  })

  test("returns summarize placeholders for comment context", () => {
    expect(promptPlaceholder({ mode: "normal", commentCount: 1, suggestion: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComment",
    )
    expect(promptPlaceholder({ mode: "normal", commentCount: 2, suggestion: "example", suggest: true, t })).toBe(
      "prompt.placeholder.summarizeComments",
    )
  })

  test("returns default placeholder with suggestion when suggestions enabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      suggestion: "translated-suggestion",
      suggest: true,
      t,
    })
    expect(value).toBe("prompt.placeholder.normal:translated-suggestion")
  })

  test("returns simple placeholder when suggestions disabled", () => {
    const value = promptPlaceholder({
      mode: "normal",
      commentCount: 0,
      suggestion: "translated-suggestion",
      suggest: false,
      t,
    })
    expect(value).toBe("prompt.placeholder.simple")
  })
})
