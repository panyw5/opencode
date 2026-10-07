import { describe, expect, test } from "bun:test"
import {
  disposeFileViewerTabState,
  fileViewerTabDirty,
  fileViewerTabKey,
  fileViewerTabState,
  fileViewerTarget,
  registerFileViewer,
  resolveFileViewers,
  saveFileViewerTab,
  type FileViewerEntry,
} from "./file-viewer-registry"

const component = () => null

function entry(input: Partial<FileViewerEntry> & { id: string }): FileViewerEntry {
  return { owner: "test", title: input.id, mode: "replace", component, ...input }
}

describe("file viewer registry", () => {
  test("derives name, extension and mime from a path", () => {
    expect(fileViewerTarget("src/data/Report.CSV", "text/csv; charset=utf-8")).toEqual({
      path: "src/data/Report.CSV",
      name: "Report.CSV",
      extension: "csv",
      mime: "text/csv",
    })
    expect(fileViewerTarget("dir.v2\\Makefile").extension).toBe("")
  })

  test("matches by extension, filename, mime pattern and test", () => {
    const dispose = [
      registerFileViewer(entry({ id: "t:ext", extensions: ["WLNB"] })),
      registerFileViewer(entry({ id: "t:name", filenames: ["Dockerfile"] })),
      registerFileViewer(entry({ id: "t:mime", mime: ["model/*"] })),
      registerFileViewer(entry({ id: "t:test", test: (target) => target.path.endsWith(".special.json") })),
    ]
    expect(resolveFileViewers(fileViewerTarget("a/b.wlnb")).map((item) => item.id)).toEqual(["t:ext"])
    expect(resolveFileViewers(fileViewerTarget("Dockerfile")).map((item) => item.id)).toEqual(["t:name"])
    expect(resolveFileViewers(fileViewerTarget("m.glb", "model/gltf-binary")).map((item) => item.id)).toEqual([
      "t:mime",
    ])
    expect(resolveFileViewers(fileViewerTarget("x.special.json")).map((item) => item.id)).toEqual(["t:test"])
    expect(resolveFileViewers(fileViewerTarget("x.json"))).toEqual([])
    for (const item of dispose) item()
  })

  test("orders by priority and keeps registration order for ties", () => {
    const dispose = [
      registerFileViewer(entry({ id: "t:low", extensions: ["pri"], priority: 0 })),
      registerFileViewer(entry({ id: "t:first", extensions: ["pri"], priority: 10 })),
      registerFileViewer(entry({ id: "t:second", extensions: ["pri"], priority: 10 })),
    ]
    expect(resolveFileViewers(fileViewerTarget("a.pri")).map((item) => item.id)).toEqual([
      "t:first",
      "t:second",
      "t:low",
    ])
    for (const item of dispose) item()
    expect(resolveFileViewers(fileViewerTarget("a.pri"))).toEqual([])
  })

  test("treats a throwing test as no match", () => {
    const dispose = registerFileViewer(
      entry({
        id: "t:throw",
        test: () => {
          throw new Error("boom")
        },
      }),
    )
    expect(resolveFileViewers(fileViewerTarget("a.any"))).toEqual([])
    dispose()
  })

  test("a newer registration restores the previous viewer when disposed", () => {
    const disposeOld = registerFileViewer(entry({ id: "t:dup", extensions: ["dup"], title: "old" }))
    const disposeNew = registerFileViewer(entry({ id: "t:dup", extensions: ["dup"], title: "new" }))
    disposeOld()
    expect(resolveFileViewers(fileViewerTarget("a.dup")).map((item) => item.title)).toEqual(["new"])
    disposeNew()
    expect(resolveFileViewers(fileViewerTarget("a.dup")).map((item) => item.title)).toEqual(["old"])
    disposeOld()
    expect(resolveFileViewers(fileViewerTarget("a.dup"))).toEqual([])
  })

  test("built-in table preview covers csv and tsv", async () => {
    await import("./file-table-preview")
    for (const path of ["a.csv", "b.TSV"]) {
      const hit = resolveFileViewers(fileViewerTarget(path)).find((item) => item.mode === "preview")
      expect(hit?.id).toBe("builtin:table")
    }
  })
})

describe("file viewer tab save state", () => {
  test("keys are composed from the session and tab value", () => {
    expect(fileViewerTabKey("session-a", "file://src/a.ts")).toBe("session-a\nfile://src/a.ts")
  })

  test("one state per key, reused across calls", () => {
    const first = fileViewerTabState("t:state")
    const second = fileViewerTabState("t:state")
    expect(second).toBe(first)
    expect(fileViewerTabState("t:state-other")).not.toBe(first)
    disposeFileViewerTabState("t:state")
    disposeFileViewerTabState("t:state-other")
  })

  test("tracks the dirty flag per key", () => {
    const key = "t:dirty\nfile://a.ts"
    expect(fileViewerTabDirty(key)).toBe(false)

    const state = fileViewerTabState(key)
    expect(state.dirty()).toBe(false)
    state.setDirty(true)
    expect(state.dirty()).toBe(true)
    expect(fileViewerTabDirty(key)).toBe(true)
    expect(fileViewerTabDirty("t:dirty\nfile://b.ts")).toBe(false)

    disposeFileViewerTabState(key)
    expect(fileViewerTabDirty(key)).toBe(false)
  })

  test("save without handlers reports unhandled and keeps the tab clean", async () => {
    const key = "t:no-save\nfile://a.ts"
    const state = fileViewerTabState(key)
    state.setDirty(true)
    expect(state.hasSave()).toBe(false)
    expect(await state.save()).toBe(false)
    expect(state.dirty()).toBe(true)
    disposeFileViewerTabState(key)
  })

  test("save runs handlers in registration order and clears nothing itself", async () => {
    const key = "t:save-order\nfile://a.ts"
    const state = fileViewerTabState(key)
    const ran: string[] = []
    const disposeA = state.onSave(async () => {
      ran.push("a")
    })
    state.onSave(async () => {
      ran.push("b")
    })
    expect(state.hasSave()).toBe(true)
    expect(await state.save()).toBe(true)
    expect(ran).toEqual(["a", "b"])
    expect(state.dirty()).toBe(false)

    // The disposer removes exactly that handler; the other one stays.
    disposeA()
    ran.length = 0
    expect(await state.save()).toBe(true)
    expect(ran).toEqual(["b"])
    disposeFileViewerTabState(key)
  })

  test("a failing save handler aborts the run and propagates", async () => {
    const key = "t:save-fail\nfile://a.ts"
    const state = fileViewerTabState(key)
    let later = false
    state.onSave(async () => {
      throw new Error("disk full")
    })
    state.onSave(async () => {
      later = true
    })
    state.setDirty(true)
    expect(state.save()).rejects.toThrow("disk full")
    await Bun.sleep(0)
    expect(later).toBe(false)
    // The failed run leaves the dirty flag untouched.
    expect(state.dirty()).toBe(true)
    disposeFileViewerTabState(key)
  })

  test("disposing a state gives a fresh one on the next request", () => {
    const key = "t:dispose\nfile://a.ts"
    const first = fileViewerTabState(key)
    first.setDirty(true)
    disposeFileViewerTabState(key)
    const second = fileViewerTabState(key)
    expect(second).not.toBe(first)
    expect(second.dirty()).toBe(false)
    expect(second.hasSave()).toBe(false)
    disposeFileViewerTabState(key)
  })

  test("saveFileViewerTab clears the dirty flag after a successful save", async () => {
    const key = "t:policy\nfile://a.ts"
    const state = fileViewerTabState(key)
    let saved = false
    state.onSave(async () => {
      saved = true
    })
    state.setDirty(true)
    expect(await saveFileViewerTab(key)).toBe(true)
    expect(saved).toBe(true)
    expect(state.dirty()).toBe(false)
    disposeFileViewerTabState(key)
  })

  test("keeps edits made while an asynchronous save is running", async () => {
    const key = "t:policy-edit-during-save\nfile://a.ts"
    const state = fileViewerTabState(key)
    let complete!: () => void
    state.onSave(() => new Promise<void>((resolve) => { complete = resolve }))
    state.setDirty(true)
    const pending = saveFileViewerTab(key)
    state.setDirty(true)
    complete()
    expect(await pending).toBe(true)
    expect(state.dirty()).toBe(true)
    disposeFileViewerTabState(key)
  })

  test("saveFileViewerTab keeps the dirty flag when the save fails", async () => {
    const key = "t:policy-fail\nfile://a.ts"
    const state = fileViewerTabState(key)
    state.onSave(async () => {
      throw new Error("nope")
    })
    state.setDirty(true)
    expect(saveFileViewerTab(key)).rejects.toThrow("nope")
    await Bun.sleep(0)
    expect(state.dirty()).toBe(true)
    disposeFileViewerTabState(key)
  })

  test("saveFileViewerTab on a missing key resolves false", async () => {
    expect(await saveFileViewerTab("t:policy-missing")).toBe(false)
  })
})
