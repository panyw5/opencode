import { expect, test } from "bun:test"
import { createGptProRefreshFence, createGptProRuntimeFence } from "./gpt-pro-refresh-fence"

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

test("a subscription event fences an older runtime snapshot response", () => {
  const fence = createGptProRuntimeFence()
  expect(fence.accept({ sourceID: "main", sequence: 2 })).toBe(true)
  expect(fence.accept({ sourceID: "main", sequence: 1 })).toBe(false)
  expect(fence.accept({ sourceID: "main", sequence: 3 })).toBe(true)
  expect(fence.accept({ sourceID: "restarted", sequence: 0 })).toBe(true)
})
