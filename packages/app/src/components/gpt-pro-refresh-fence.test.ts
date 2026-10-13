import { expect, test } from "bun:test"
import { createGptProRefreshFence } from "./gpt-pro-refresh-fence"

test("a delayed poll cannot overwrite a newer settings write", () => {
  const fence = createGptProRefreshFence()
  const poll = fence.begin()
  fence.invalidate()
  expect(fence.current(poll)).toBe(false)
  const confirmed = fence.begin()
  expect(fence.current(confirmed)).toBe(true)
})
test("out-of-order responses and disposed views reject stale reads", () => {
  const fence = createGptProRefreshFence()
  const first = fence.begin()
  const second = fence.begin()
  expect(fence.current(first)).toBe(false)
  expect(fence.current(second)).toBe(true)
  fence.invalidate()
  expect(fence.current(second)).toBe(false)
})
