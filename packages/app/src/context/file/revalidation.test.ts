import { expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { createFileRevalidation } from "./revalidation"
import { createFileContentLoader } from "./content-loader"
import { createFileWatchRegistry } from "./watch-policy"

test("all sources coalesce; hidden entries are dirtied without reads", () => {
  let visible = ["image.svg"]
  const stale = new Set<string>()
  const reads: string[] = []
  const service = createFileRevalidation({
    visible: () => visible,
    stale: (file) => {
      stale.add(file)
    },
    load: async (file) => {
      reads.push(file)
    },
  })
  for (const reason of ["native", "tool", "flood", "foreground", "reconnect"]) {
    service.invalidate("image.svg", reason)
    service.invalidate("hidden.svg", reason)
  }
  service.flush()
  expect(reads).toEqual(["image.svg"])
  expect([...stale]).toEqual(["image.svg", "hidden.svg"])
  service.visible("reconnect")
  visible = []
  service.flush()
  expect(reads).toEqual(["image.svg"])
  service.reset()
})

test("scope reset and manual refresh cannot leave a delayed duplicate read", async () => {
  const reads: string[] = []
  const service = createFileRevalidation({
    visible: () => ["a"],
    stale: () => {},
    load: async (file) => {
      reads.push(file)
    },
  })
  service.visible("reconnect")
  service.reset()
  service.flush()
  expect(reads).toEqual([])
  service.visible("foreground")
  await service.refresh("a")
  service.flush()
  expect(reads).toEqual(["a"])
  service.reset()
})

test("self watcher, focus, reconnect and manual changes notify without full-text reads", async () => {
  const reads: string[] = []
  const stale: string[] = []
  const changed: string[] = []
  const service = createFileRevalidation({
    visible: () => ["notebook.nb"],
    content: () => "self",
    stale: (file) => {
      stale.push(file)
    },
    changed: (file) => {
      changed.push(file)
    },
    load: async (file) => {
      reads.push(file)
    },
  })
  service.resume()
  service.flush()
  expect(changed).toEqual([])
  for (const reason of ["watcher", "foreground", "online", "reconnect"]) {
    service.invalidate("notebook.nb", reason)
  }
  service.flush()
  expect(changed).toEqual(["notebook.nb"])
  expect(stale).toHaveLength(4)
  expect(reads).toEqual([])
  service.invalidate("notebook.nb", "watcher")
  await service.refresh("notebook.nb")
  service.flush()
  expect(changed).toEqual(["notebook.nb", "notebook.nb"])
  expect(reads).toEqual([])
  service.reset()
})

test("a shared text watch wins and releasing it returns to self-only invalidation", () => {
  const watches = createFileWatchRegistry(() => {})
  watches.acquire("same.nb", "self")
  const text = watches.acquire("same.nb", "text")
  const reads: string[] = []
  const revisions: string[] = []
  const service = createFileRevalidation({
    visible: () => ["same.nb"],
    content: (file) => watches.mode(file) ?? "text",
    stale: () => {},
    changed: (file) => {
      revisions.push(file)
    },
    load: async (file) => {
      reads.push(file)
    },
  })
  service.invalidate("same.nb", "watcher")
  service.flush()
  expect(reads).toEqual(["same.nb"])
  expect(revisions).toEqual(["same.nb"])
  service.invalidate("same.nb", "watcher")
  text()
  service.flush()
  expect(reads).toEqual(["same.nb"])
  expect(revisions).toEqual(["same.nb", "same.nb"])
  service.reset()
})

test("hidden self invalidations replay once when visible, without first-watch storms", async () => {
  let visible: string[] = []
  let revision = 0
  let reads = 0
  let stale = 0
  const service = createFileRevalidation({
    visible: () => visible,
    content: () => "self",
    stale: () => {
      stale++
    },
    changed: () => {
      revision++
    },
    load: async () => {
      reads++
    },
  })
  visible = ["a.nb"]
  service.resume()
  service.resume()
  service.flush()
  expect(revision).toBe(0)
  visible = []
  service.invalidate("a.nb", "watcher")
  service.invalidate("a.nb", "reconnect")
  await service.refresh("a.nb")
  service.flush()
  expect(revision).toBe(0)
  expect(reads).toBe(0)
  expect(stale).toBe(3)
  visible = ["a.nb"]
  service.resume()
  service.resume()
  service.flush()
  expect(revision).toBe(1)
  service.resume()
  service.flush()
  expect(revision).toBe(1)
  expect(reads).toBe(0)
  service.reset()
})

test("hidden between scheduling and flush retains self notification; reset discards it", () => {
  let visible = ["a.nb"]
  let revision = 0
  const service = createFileRevalidation({
    visible: () => visible,
    content: () => "self",
    stale: () => {},
    changed: () => {
      revision++
    },
    load: async () => {
      throw new Error("self must not read")
    },
  })
  service.invalidate("a.nb", "watcher")
  visible = []
  service.flush()
  expect(revision).toBe(0)
  visible = ["a.nb"]
  service.resume()
  service.flush()
  expect(revision).toBe(1)
  visible = []
  service.invalidate("a.nb", "watcher")
  service.reset()
  visible = ["a.nb"]
  service.resume()
  service.flush()
  expect(revision).toBe(1)
})

test("hidden text invalidation queues a fresh read when resumed before an obsolete read settles", async () => {
  let visible = ["source.txt"]
  let loaded = false
  let loading = false
  const values: string[] = []
  const pending: Array<(value: { data: FileContent }) => void> = []
  const loader = createFileContentLoader({
    scope: () => "/repo",
    normalize: (value) => value,
    loaded: () => loaded,
    read: () => new Promise((resolve) => pending.push(resolve)),
    onLoading: () => {
      loading = true
    },
    onContent: (_, content) => {
      values.push(content!.content)
      loaded = true
      loading = false
    },
    onError: () => {
      loading = false
    },
  })
  const service = createFileRevalidation({
    visible: () => visible,
    content: () => "text",
    stale: loader.invalidate,
    load: (file) => loader.load(file, { force: true }),
  })
  const original = loader.load("source.txt")
  visible = []
  service.invalidate("source.txt", "watcher")
  visible = ["source.txt"]
  service.resume()
  const ordinary = loader.load("source.txt")
  service.flush()
  pending[0]({ data: { type: "text", content: "old" } })
  await original
  for (let index = 0; index < 10 && pending.length < 2; index++) await Promise.resolve()
  expect(pending).toHaveLength(2)
  pending[1]({ data: { type: "text", content: "fresh" } })
  await ordinary
  for (let index = 0; index < 10 && loading; index++) await Promise.resolve()
  expect(values).toEqual(["fresh"])
  expect(loaded).toBe(true)
  expect(loading).toBe(false)
  service.reset()
})

test("text manual refresh retains explicit hidden force read behavior", async () => {
  const reads: string[] = []
  const service = createFileRevalidation({
    visible: () => [],
    content: () => "text",
    stale: () => {},
    load: async (file) => {
      reads.push(file)
    },
  })
  service.invalidate("source.txt", "watcher")
  service.resume()
  service.flush()
  expect(reads).toEqual([])
  await service.refresh("source.txt")
  expect(reads).toEqual(["source.txt"])
  service.reset()
})
