import { expect, test } from "bun:test"
import { extensionRuntimeState, extensionRuntimeRetryable } from "./runtime-state"
import type { ExtensionInfo } from "./types"

const item: ExtensionInfo = {
  id: "test.runtime",
  version: "1",
  displayName: "Runtime",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
}

test("backend failures take precedence over enabled status without changing manifest health", () => {
  expect(extensionRuntimeState(item)).toBe("ready")
  expect(
    extensionRuntimeState({
      ...item,
      server: { hasService: false, hasInstanceHooks: false, runtime: "error", needsRestart: false },
    }),
  ).toBe("error")
  expect(
    extensionRuntimeState({
      ...item,
      server: { hasService: false, hasInstanceHooks: false, runtime: "idle", needsRestart: true },
    }),
  ).toBe("blocked")
})

test("only an enabled runtime error is retryable, never a restart blocker", () => {
  const failed: ExtensionInfo = {
    ...item,
    server: { hasService: false, hasInstanceHooks: false, runtime: "error", needsRestart: false },
  }
  expect(extensionRuntimeRetryable(failed)).toBe(true)
  expect(extensionRuntimeRetryable({ ...failed, enabled: false })).toBe(false)
  expect(extensionRuntimeRetryable({ ...failed, server: { ...failed.server!, needsRestart: true } })).toBe(false)
  expect(extensionRuntimeRetryable({ ...failed, server: { ...failed.server!, runtime: "blocked" } })).toBe(false)
  expect(extensionRuntimeRetryable(item)).toBe(false)
})
