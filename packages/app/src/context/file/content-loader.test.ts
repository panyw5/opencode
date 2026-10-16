import { describe, expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { deferred } from "../global-sync/session-service-test-utils"
import { createFileContentLoader } from "./content-loader"

const content = (value: string) => ({ type: "text", content: value }) as FileContent
describe("file content requests", () => {
  test("hidden invalidation prevents cached reuse and an in-flight stale commit", async () => {
    const old = deferred<{ data: FileContent }>()
    let reads = 0
    const commits: string[] = []
    const loader = createFileContentLoader({
      scope: () => "/repo",
      normalize: (p) => p,
      loaded: () => true,
      read: () => (++reads === 1 ? old.promise : Promise.resolve({ data: content("fresh") })),
      onLoading: () => {},
      onContent: (_, value) => {
        commits.push(value!.content)
      },
      onError: () => {},
    })
    const loading = loader.load("a", { force: true })
    loader.invalidate("a")
    old.resolve({ data: content("stale") })
    await loading
    expect(commits).toEqual([])
    await loader.load("a")
    expect(commits).toEqual(["fresh"])
    await loader.load("a")
    expect(reads).toBe(2)
  })

  test("manual refresh bypasses loaded content without background reads", async () => {
    let calls = 0
    let value: FileContent | undefined
    const loader = createFileContentLoader({
      scope: () => "/project",
      normalize: (path) => path,
      loaded: () => !!value,
      read: async () => ({ data: content(++calls === 1 ? "old preview" : "updated preview") }),
      onLoading: () => {},
      onContent: (_, next) => {
        value = next
      },
      onError: (_, error) => {
        throw error
      },
    })
    await loader.load("image.svg")
    await loader.load("image.svg")
    expect(calls).toBe(1)
    expect(value?.content).toBe("old preview")
    await loader.load("image.svg", { force: true })
    expect(calls).toBe(2)
    expect(value?.content).toBe("updated preview")
  })

  test("coalesces watcher refreshes but never reuses the old response", async () => {
    const first = deferred<{ data: FileContent }>()
    const second = deferred<{ data: FileContent }>()
    let calls = 0
    let value: FileContent | undefined
    const loader = createFileContentLoader({
      scope: () => "/project",
      normalize: (path) => path,
      loaded: () => !!value,
      read: () => (++calls === 1 ? first.promise : second.promise),
      onLoading: () => {},
      onContent: (_, next) => {
        value = next
      },
      onError: () => {},
    })
    const old = loader.load("file.txt")
    const fresh = loader.load("file.txt", { force: true })
    expect(loader.load("file.txt", { force: true })).toBe(fresh)
    first.resolve({ data: content("stale") })
    await old
    expect(value).toBeUndefined()
    second.resolve({ data: content("fresh") })
    await fresh
    expect(value?.content).toBe("fresh")
    expect(calls).toBe(2)
  })

  test("same-path backend reset cannot accept an old success or old failure", async () => {
    const first = deferred<{ data: FileContent }>()
    const second = deferred<{ data: FileContent }>()
    let calls = 0
    let errors = 0
    let value: FileContent | undefined
    const loader = createFileContentLoader({
      scope: () => "/project",
      normalize: (path) => path,
      loaded: () => !!value,
      read: () => (++calls === 1 ? first.promise : second.promise),
      onLoading: () => {},
      onContent: (_, next) => {
        value = next
      },
      onError: () => {
        errors++
      },
    })
    const old = loader.load("file.txt")
    loader.reset()
    const fresh = loader.load("file.txt")
    first.reject(new Error("old backend"))
    await old
    expect(value).toBeUndefined()
    expect(errors).toBe(0)
    second.resolve({ data: content("new backend") })
    await fresh
    expect(value?.content).toBe("new backend")
  })
})
