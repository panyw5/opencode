import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./session-composer-region.tsx", import.meta.url)).text()

test("child-agent list refreshes do not key the menu lifetime to a new data object", () => {
  const branch = source.match(/<Show\s+when=\{childAgentMenu\(\)\}([^>]*)>([\s\S]*?)<\/Show>/)
  expect(branch).not.toBeNull()
  expect(branch![1]).not.toMatch(/\bkeyed\b/)
  // A non-keyed Show supplies an accessor so the mounted menu still receives updates.
  expect(branch![2]).toContain("entries={menu().entries}")
  expect(branch![2]).toContain("onOpen={menu().onOpen}")
})
