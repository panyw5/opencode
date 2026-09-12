import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2"
import { createReviewDataService } from "./review-data-service"

const file = (path: string, additions = 1, deletions = 0, status?: "added" | "deleted" | "modified"): FileDiff => ({
  file: path,
  additions,
  deletions,
  ...(status ? { status } : {}),
})

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createService(overrides?: Partial<{
  directory: () => string | undefined
  enabled: () => boolean
  visible: () => boolean
  active: () => "git" | "branch" | undefined
}>) {
  const calls: Array<{ mode: "git" | "branch" }> = []
  let gate = deferred<FileDiff[]>()
  const next = (mode: "git" | "branch") => {
    calls.push({ mode })
    return gate.promise
  }
  const service = createReviewDataService({
    directory: () => "/repo",
    enabled: () => true,
    visible: () => true,
    active: () => "git",
    fetch: next,
    ...overrides,
  })
  return {
    service,
    calls,
    resolve: (value: FileDiff[]) => gate.resolve(value),
    reject: (error: unknown) => gate.reject(error),
    resetGate: () => {
      gate = deferred<FileDiff[]>()
    },
  }
}

const settle = () => wait(250)

describe("review data service", () => {
  test("1000 events coalesce into one serial refresh per key", async () => {
    const { service, calls, resolve } = createService()
    service.ensure("git", "open")
    await wait(0)
    expect(calls.length).toBe(1)

    for (let i = 0; i < 1000; i++) service.notifyEvents()
    expect(calls.length).toBe(1) // nothing concurrent; request still in flight

    resolve([file("a.ts")])
    await settle()
    // After the response committed, the merged dirty state triggers exactly
    // one follow-up flush, not a second concurrent request.
    await wait(500)
    expect(calls.length).toBe(2)
    expect(service.state.git.data.length).toBe(1)
    expect(service.state.git.dirty).toBe(false)
    expect(service.state.git.initialLoading).toBe(false)
    service.dispose()
  })

  test("refresh during flight never runs concurrent requests", async () => {
    const { service, calls, resolve } = createService()
    service.refresh("git", "turn-idle")
    service.refresh("git", "turn-idle")
    service.refresh("git", "turn-idle")
    await wait(0)
    expect(calls.length).toBe(1) // still the first request; later ones merged
    resolve([file("a.ts")])
    await settle()
    // The merged refresh intent runs as exactly ONE serial follow-up.
    await wait(400)
    expect(calls.length).toBe(2)
    expect(service.state.git.dirty).toBe(false)
    service.dispose()
  })

  test("responses only commit to the workspace epoch they requested", async () => {
    let directory = "/repo"
    const { service, resolve } = createService({ directory: () => directory })
    service.ensure("git", "open")
    await wait(0)
    directory = "/other"
    resolve([file("a.ts")])
    await settle()
    // The response raced a workspace switch and must be dropped.
    expect(service.state.git.data.length).toBe(0)
    expect(service.state.git.initialLoading).toBe(true)
    service.dispose()
  })

  test("errors keep old data and back off instead of spinning", async () => {
    const { service, calls, resolve, reject, resetGate } = createService()
    service.ensure("git", "open")
    resolve([file("a.ts", 5)])
    await settle()
    expect(service.state.git.data[0]?.additions).toBe(5)

    resetGate()
    service.refresh("git", "manual")
    reject(new Error("boom"))
    await settle()
    expect(service.state.git.error).toBe("boom")
    expect(service.state.git.data[0]?.additions).toBe(5) // old data survives
    expect(service.state.git.dirty).toBe(true)
    const afterError = calls.length

    // Inside the backoff window neither flushes nor ensure() spin requests.
    service.notifyEvents()
    service.ensure("git", "open")
    await wait(100)
    expect(calls.length).toBe(afterError)

    // The bounded backoff retry eventually runs once.
    await wait(1200)
    expect(calls.length).toBe(afterError + 1)
    service.dispose()
  })

  test("reconcile updates only changed files without clearing the list", async () => {
    // Object identity of untouched items is asserted in
    // test-browser/review-reconcile-identity.test.ts: bun's node-condition
    // server build of solid-js/store does not preserve it, while the browser
    // build used by the desktop renderer does.
    const { service, resolve, resetGate } = createService()
    service.ensure("git", "open")
    resolve([file("a.ts", 1), file("b.ts", 2)])
    await settle()

    resetGate()
    service.refresh("git", "manual")
    resolve([file("a.ts", 1), file("b.ts", 9)])
    await settle()
    expect(service.state.git.data.length).toBe(2)
    expect(service.state.git.data[0]?.additions).toBe(1) // untouched
    expect(service.state.git.data[1]?.additions).toBe(9)
    service.dispose()
  })

  test("hidden panels keep dirty but never schedule work", async () => {
    let visible = false
    const { service, calls, resolve } = createService({ visible: () => visible })
    service.ensure("git", "open")
    resolve([file("a.ts")])
    await settle()

    service.notifyEvents()
    await wait(400)
    expect(calls.length).toBe(1) // flush fired but visible=false → no request
    expect(service.state.git.dirty).toBe(true)

    visible = true
    service.ensure("git", "open")
    await wait(0)
    expect(calls.length).toBe(2)
    resolve([file("a.ts"), file("b.ts")])
    await settle()
    expect(service.state.git.dirty).toBe(false)
    service.dispose()
  })

  test("event flushes only refresh the active mode", async () => {
    const { service, calls, resolve } = createService({ active: () => "git" })
    service.ensure("git", "open")
    resolve([file("a.ts")])
    await settle()
    // Make branch non-fresh so it participates in dirty marking.
    service.refresh("branch", "manual")
    resolve([file("b.ts")])
    await settle()

    service.notifyEvents()
    await wait(400)
    const gitCalls = calls.filter((c) => c.mode === "git").length
    const branchCalls = calls.filter((c) => c.mode === "branch").length
    expect(gitCalls).toBe(2)
    expect(branchCalls).toBe(1) // stayed dirty, refreshed on ensure()
    expect(service.state.branch.dirty).toBe(true)

    service.ensure("branch", "open")
    resolve([file("b.ts", 2)])
    await settle()
    expect(service.state.branch.dirty).toBe(false)
    service.dispose()
  })

  test("reset isolates the workspace: dirty state cleared, stale work dropped", async () => {
    const { service, calls, resolve } = createService()
    service.ensure("git", "open")
    service.notifyEvents()
    service.reset("workspace")
    expect(service.state.git.dirty).toBe(false)
    expect(service.state.git.initialLoading).toBe(true)

    resolve([file("a.ts")])
    await settle()
    // The response belonged to the pre-reset epoch; it never lands.
    expect(service.state.git.data.length).toBe(0)
    expect(calls.length).toBe(1)
    service.dispose()
  })

  test("disabled service never fetches", async () => {
    const { service, calls } = createService({ enabled: () => false })
    service.ensure("git", "open")
    service.notifyEvents()
    service.refresh("git", "manual")
    await settle()
    expect(calls.length).toBe(0)
    service.dispose()
  })
})
