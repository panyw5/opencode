import { describe, expect, test } from "bun:test"
import { createWatcherInvalidator, createWorkspaceTreeWatcher, invalidateFromWatcher } from "./watcher"

describe("file watcher invalidation", () => {
  test("a scope invalidation reaches every cached file without scanning disk", () => {
    const loaded: string[] = []
    invalidateFromWatcher(
      { type: "file.watcher.invalidated", properties: { directory: "/repo/output" } },
      {
        normalize: (path) => path.replace("/repo/", ""),
        hasFile: () => true,
        files: () => ["output/1.svg", "output/2001.svg", "output-other/skip.svg"],
        loadFile: (path) => loaded.push(path),
        node: () => undefined,
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )
    expect(loaded).toEqual(["output/1.svg", "output/2001.svg"])
  })

  test("root invalidation dirties the workspace tree once", () => {
    let dirty = 0
    const watcher = createWorkspaceTreeWatcher({
      normalize: (p) => p,
      node: () => undefined,
      isDirLoaded: () => true,
      dirtyDir: () => {
        throw new Error("expected whole-tree dirty")
      },
      dirtyAll: () => {
        dirty++
      },
    })
    for (let i = 0; i < 100; i++)
      watcher.handle({ type: "file.watcher.invalidated", properties: { directory: "/repo" } })
    watcher.flush()
    expect(dirty).toBe(1)
    watcher.dispose()
  })

  test("reloads open files and refreshes loaded parent on add", () => {
    const loads: string[] = []
    const refresh: string[] = []
    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/new.ts",
          event: "add",
        },
      },
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/new.ts",
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(loads).toEqual(["src/new.ts"])
    expect(refresh).toEqual(["src"])
  })

  test("reloads files that are open in tabs", () => {
    const loads: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/open.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        isOpen: (path) => path === "src/open.ts",
        loadFile: (path) => loads.push(path),
        node: () => ({
          path: "src/open.ts",
          type: "file",
          name: "open.ts",
          absolute: "/repo/src/open.ts",
          ignored: false,
        }),
        isDirLoaded: () => false,
        refreshDir: () => {},
      },
    )

    expect(loads).toEqual(["src/open.ts"])
  })

  test("refreshes only changed loaded directory nodes", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({ path: "src", type: "directory", name: "src", absolute: "/repo/src", ignored: false }),
        isDirLoaded: (path) => path === "src",
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: "src/file.ts",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => ({
          path: "src/file.ts",
          type: "file",
          name: "file.ts",
          absolute: "/repo/src/file.ts",
          ignored: false,
        }),
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual(["src"])
  })

  test("ignores invalid or git watcher updates", () => {
    const refresh: string[] = []

    invalidateFromWatcher(
      {
        type: "file.watcher.updated",
        properties: {
          file: ".git/index.lock",
          event: "change",
        },
      },
      {
        normalize: (input) => input,
        hasFile: () => true,
        loadFile: () => {
          throw new Error("should not load")
        },
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    invalidateFromWatcher(
      {
        type: "project.updated",
        properties: {},
      },
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
    )

    expect(refresh).toEqual([])
  })

  test("batches bursts into one deduplicated action per target", async () => {
    const loads: string[] = []
    const refresh: string[] = []
    const invalidator = createWatcherInvalidator(
      {
        normalize: (input) => input,
        hasFile: (path) => path === "src/a.ts",
        isOpen: () => false,
        loadFile: (path) => loads.push(path),
        node: () => undefined,
        isDirLoaded: (path) => path === "src" || path === "lib",
        refreshDir: (path) => refresh.push(path),
      },
      1,
    )

    for (let i = 0; i < 1000; i++) {
      invalidator.handle({ type: "file.watcher.updated", properties: { file: `src/new${i}.ts`, event: "add" } })
      invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "change" } })
    }
    invalidator.handle({ type: "file.watcher.updated", properties: { file: "lib/x.ts", event: "unlink" } })

    await Bun.sleep(20)

    expect(loads).toEqual(["src/a.ts"])
    expect(refresh.sort()).toEqual(["lib", "src"])
    invalidator.dispose()
  })

  test("flush coalesces targets collected before the timer fires", async () => {
    const refresh: string[] = []
    const invalidator = createWatcherInvalidator(
      {
        normalize: (input) => input,
        hasFile: () => false,
        loadFile: () => {},
        node: () => undefined,
        isDirLoaded: () => true,
        refreshDir: (path) => refresh.push(path),
      },
      500,
    )

    invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/a.ts", event: "add" } })
    invalidator.handle({ type: "file.watcher.updated", properties: { file: "src/b.ts", event: "add" } })
    expect(refresh).toEqual([])

    invalidator.flush()
    expect(refresh).toEqual(["src"])

    invalidator.dispose()
  })

  test("workspace watcher dirties parent dirs once and ignore changes dirty loaded tree", async () => {
    const dirty: string[] = []
    let all = 0
    const watcher = createWorkspaceTreeWatcher(
      {
        normalize: (input) => input,
        node: () => undefined,
        isDirLoaded: (path) => path === "src" || path === "",
        dirtyDir: (path) => dirty.push(path),
        dirtyAll: () => all++,
      },
      1,
    )
    watcher.handle({ type: "file.watcher.updated", properties: { file: "src/new.ts", event: "add" } })
    watcher.handle({ type: "file.watcher.updated", properties: { file: "src/old.ts", event: "unlink" } })
    await Bun.sleep(10)
    expect(dirty).toEqual(["src"])
    watcher.handle({ type: "file.watcher.updated", properties: { file: ".gitignore", event: "change" } })
    await Bun.sleep(10)
    expect(all).toBe(1)
    watcher.handle({ type: "file.watcher.updated", properties: { file: "src/.ignore", event: "add" } })
    await Bun.sleep(10)
    expect(all).toBe(2)
    watcher.handle({ type: "file.watcher.updated", properties: { file: "src/.ignore", event: "unlink" } })
    await Bun.sleep(10)
    expect(all).toBe(3)
    watcher.dispose()
  })
})
