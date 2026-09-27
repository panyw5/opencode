import { describe, expect, test } from "bun:test"
import { fileViewerTarget, registerFileViewer, resolveFileViewers, type FileViewerEntry } from "./file-viewer-registry"

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

  test("re-registering an id replaces it and a stale dispose is a no-op", () => {
    const disposeOld = registerFileViewer(entry({ id: "t:dup", extensions: ["dup"], title: "old" }))
    const disposeNew = registerFileViewer(entry({ id: "t:dup", extensions: ["dup"], title: "new" }))
    disposeOld()
    expect(resolveFileViewers(fileViewerTarget("a.dup")).map((item) => item.title)).toEqual(["new"])
    disposeNew()
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
