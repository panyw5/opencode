import { expect, test } from "bun:test"

test("session selection toolbar and its event chain are not mounted", async () => {
  const timeline = await Bun.file(new URL("../pages/session/timeline/message-timeline.tsx", import.meta.url)).text()
  const session = await Bun.file(new URL("../pages/session.tsx", import.meta.url)).text()
  const assistant = await Bun.file(new URL("./quick-assistant/index.tsx", import.meta.url)).text()
  expect(timeline).not.toContain("SessionSelectionToolbar")
  expect(timeline).not.toContain("onSelectionToPrompt")
  expect(session).not.toContain("appendSelectionToPrompt")
  expect(assistant).not.toContain("QUICK_ASSISTANT_SELECTION_EVENT")
})
