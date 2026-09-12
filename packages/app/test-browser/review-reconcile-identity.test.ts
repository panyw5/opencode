import { expect, test } from "bun:test"
import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2"
import { createReviewDataService } from "../src/pages/session/review-data-service"

/**
 * Runs under `--conditions=browser` (same solid-js/store build as the desktop
 * renderer): `reconcile(data, { key: "file" })` must keep the store node of
 * untouched files identical across a refresh so mounted diff bodies are not
 * rebuilt. The node-condition server build used by default `bun test` does
 * not preserve identity, which is why this lives in test-browser.
 */
test("review data reconcile preserves untouched file identity in the browser build", async () => {
  const calls: string[] = []
  let gate: { resolve: (value: FileDiff[]) => void } = { resolve: () => {} }
  const service = createReviewDataService({
    directory: () => "/repo",
    enabled: () => true,
    visible: () => true,
    fetch: (mode) => {
      calls.push(mode)
      return new Promise<FileDiff[]>((resolve) => {
        gate = { resolve }
      })
    },
  })

  service.ensure("git", "open")
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
  gate.resolve([
    { file: "a.ts", additions: 1, deletions: 0 },
    { file: "b.ts", additions: 2, deletions: 0 },
  ])
  await tick()
  await tick()

  const beforeA = service.state.git.data[0]
  expect(beforeA).toBeDefined()

  service.refresh("git", "manual")
  await tick()
  gate.resolve([
    { file: "a.ts", additions: 1, deletions: 0 },
    { file: "b.ts", additions: 9, deletions: 0 },
  ])
  await tick()
  await tick()

  expect(service.state.git.data[0]).toBe(beforeA)
  expect(service.state.git.data[1]?.additions).toBe(9)
  service.dispose()
})
