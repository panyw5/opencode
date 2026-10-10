import { describe, expect, test } from "bun:test"
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
    await Promise.resolve()
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
})
