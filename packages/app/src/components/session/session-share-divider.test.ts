import { expect, test } from "bun:test"
import { shareMarkdown } from "./session-share-model"

test("share preview gives Markdown separators an explicit theme-aware border", async () => {
  const css = await Bun.file(new URL("./session-share-dialog.css", import.meta.url)).text()
  expect(css).toMatch(/\.session-share-paper \[data-component="markdown"\] hr\s*\{[^}]*border-top:\s*1px solid var\(--border-base, currentColor\)/)
})

test("separates selected messages only when their roles change", () => {
  const messages = [
    { id: "1", role: "user" as const, markdown: "question" },
    { id: "2", role: "assistant" as const, markdown: "answer" },
    { id: "3", role: "assistant" as const, markdown: "continued" },
    { id: "4", role: "user" as const, markdown: "follow-up" },
  ]
  const result = shareMarkdown(messages, messages.map((item) => item.id), "Chat")
  expect(result.match(/\n\n---\n\n/g)).toHaveLength(2)
  expect(result).toContain("answer\n\n## Assistant\n\ncontinued")
  expect(shareMarkdown(messages, ["2", "3"], "Chat")).not.toContain("\n\n---\n\n")
})
