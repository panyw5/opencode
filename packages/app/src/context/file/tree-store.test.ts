import { describe, expect, test } from "bun:test"
import { createRenderEffect, createRoot, createSignal } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { deferred } from "../global-sync/session-service-test-utils"
import { createFileTreeStore } from "./tree-store"

const node = (path: string) => ({ path, name: path, type: "file", absolute: `/tmp/${path}` }) as FileNode

describe("file tree requests", () => {
  test("watcher refresh during a pending read fetches a fresh directory listing", async () => {
    const first = deferred<FileNode[]>()
    const second = deferred<FileNode[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project",
      normalizeDir: (path) => path,
      list: () => (++calls === 1 ? first.promise : second.promise),
      onError: () => {},
    })
    const old = tree.listDir("")
    const fresh = tree.listDir("", { force: true })
    first.resolve([node("deleted")])
    await old
    await Bun.sleep(0)
    expect(calls).toBe(2)
    second.resolve([node("fresh")])
    await fresh
    expect(tree.children("")).toEqual([node("fresh")])
  })

  test("reset prevents old results even after returning to the same directory", async () => {
    const request = deferred<FileNode[]>()
    let scope = "/project"
    const tree = createFileTreeStore({
      scope: () => scope,
      normalizeDir: (path) => path,
      list: () => request.promise,
      onError: () => {},
    })
    const loading = tree.listDir("")
    scope = "/other"
    tree.reset()
    scope = "/project"
    tree.reset()
    request.resolve([node("deleted")])
    await loading
    expect(tree.children("")).toEqual([])
  })

  test("reuses loaded and in-flight directories across consumer remounts and refreshes dirty once", async () => {
    const first = deferred<FileNode[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project@server-a",
      normalizeDir: (path) => path,
      list: () => (++calls === 1 ? first.promise : Promise.resolve([node("fresh")])),
      onError: () => {},
    })
    const firstConsumer = tree.listDir("")
    const secondConsumer = tree.listDir("")
    expect(calls).toBe(1)
    first.resolve([node("initial")])
    await Promise.all([firstConsumer, secondConsumer])
    await tree.listDir("")
    expect(calls).toBe(1)

    tree.markDirty("")
    expect(tree.dirState("")?.dirty).toBe(true)
    await tree.listDir("")
    await tree.listDir("")
    expect(calls).toBe(2)
    expect(tree.children("")).toEqual([node("fresh")])
  })

  test("reset isolates a changed connection with the same path", async () => {
    const old = deferred<FileNode[]>()
    let scope = "/project@server-a"
    const tree = createFileTreeStore({
      scope: () => scope,
      normalizeDir: (path) => path,
      list: () => old.promise,
      onError: () => {},
    })
    const pending = tree.listDir("")
    scope = "/project@server-b"
    tree.reset()
    old.resolve([node("from-old-server")])
    await pending
    expect(tree.children("")).toEqual([])
  })

  test("visible demand refreshes a directory dirtied during its first in-flight request", async () => {
    const first = deferred<FileNode[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project",
      normalizeDir: (path) => path,
      list: () => (++calls === 1 ? first.promise : Promise.resolve([node("updated")])),
      onError: () => {},
    })
    const release = tree.acquireDemand()
    let dispose = () => {}
    createRoot((stop) => {
      dispose = stop
      const [visible] = createSignal(true)
      createRenderEffect(() => {
        const state = tree.dirState("")
        if (!visible() || state?.loading || state?.error) return
        if (!state?.loaded || state.dirty) void tree.listDir("")
      })
    })
    await Bun.sleep(0)
    expect(calls).toBe(1)
    tree.markDirty("")
    await Bun.sleep(0)
    first.resolve([node("stale")])
    await Bun.sleep(10)
    expect(calls).toBe(2)
    await Bun.sleep(0)
    expect(tree.children("")).toEqual([node("updated")])
    dispose()
    release()
  })

  test("dirty trees stay idle without consumers and refresh when a picker acquires demand", async () => {
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project",
      normalizeDir: (path) => path,
      list: async () => [node(`entry-${++calls}`)],
      onError: () => {},
    })
    await tree.listDir("")
    tree.markDirty("")
    await Bun.sleep(0)
    expect(calls).toBe(1)
    const release = tree.acquireDemand()
    await Bun.sleep(0)
    expect(calls).toBe(2)
    expect(tree.children("")).toEqual([node("entry-2")])
    release()
  })

  test("a picker waits for a refresh already started by its demand lease", async () => {
    const refresh = deferred<FileNode[]>()
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project",
      normalizeDir: (path) => path,
      list: () => (++calls === 1 ? Promise.resolve([node("old")]) : refresh.promise),
      onError: () => {},
    })
    await tree.listDir("")
    tree.markDirty("")
    const release = tree.acquireDemand("picker")
    expect(tree.dirState("")?.loading).toBe(true)
    const pickerLoad = tree.listDir("")
    refresh.resolve([node("new")])
    await pickerLoad
    expect(tree.children("")).toEqual([node("new")])
    expect(calls).toBe(2)
    release()
  })

  test("picker demand refreshes root without waking expanded hidden directories", async () => {
    let calls = 0
    const tree = createFileTreeStore({
      scope: () => "/project",
      normalizeDir: (path) => path,
      list: async (dir) => {
        calls++
        if (dir === "") return [{ ...node("folder"), type: "directory" } as FileNode]
        return [node("child")]
      },
      onError: () => {},
    })
    await tree.listDir("")
    tree.expandDir("folder")
    await Bun.sleep(0)
    const beforePicker = calls
    tree.markDirty("")
    tree.markDirty("folder")
    const release = tree.acquireDemand("picker")
    await Bun.sleep(0)
    expect(calls).toBe(beforePicker + 1)
    release()
  })
})
