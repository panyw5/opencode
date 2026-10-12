import { expect, test } from "bun:test"

test("session selection toolbar and its event chain are mounted", async () => {
  const timeline = await Bun.file(new URL("../pages/session/timeline/message-timeline.tsx", import.meta.url)).text()
  const session = await Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()
  const assistant = await Bun.file(new URL("./quick-assistant/index.tsx", import.meta.url)).text()
  expect(timeline).toContain("<SessionSelectionToolbar")
  expect(timeline).toContain("onSelectionToPrompt: (text: string) => void")
  expect(session).toContain("appendSelectionToPrompt(prompt.current(), text)")
  expect(assistant).toContain("window.addEventListener(QUICK_ASSISTANT_SELECTION_EVENT")
})
