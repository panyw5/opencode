import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createNotebookService } from "../src/server"
import type { ViewerDocument } from "../src/document"
import type { CellsResponse } from "../src/preview-protocol"
import { host } from "./helpers"
import { NotebookPreviews } from "../src/preview-service"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function setup(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "nb-preview-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "preview.nb")
  await writeFile(path, source)
  const service = createNotebookService(host())
  cleanup.push(() => service.dispose!())
  const call = (method: string, data: object = {}, signal = new AbortController().signal) =>
    service.rpc![method]({ path, ...data }, { directory: dir, signal })
  return { dir, path, call }
}

test("worker-backed open sends only summaries; batch renders exact immutable revision", async () => {
  const source = `Notebook[{Cell[BoxData[InterpretationBox[FractionBox["1","2"], CompressedData["${"z".repeat(2_000_000)}"]]],"Output"],Cell["${"a".repeat(120000)}","Text"]}]`
  const { path, call } = await setup(source)
  const doc = (await call("notebook.open")) as ViewerDocument
  expect(JSON.stringify(doc).length).toBeLessThan(9000)
  expect(doc.cells[0]).toMatchObject({ editable: false, runnable: false, text: "" })
  expect(doc.cells[1]).toMatchObject({ deferred: true, characters: 120000 })
  await writeFile(path, 'Notebook[{Cell["new","Text"]}]')
  const rendered = (await call("notebook.cells", {
    revision: doc.revision,
    indexes: [0],
    kind: "preview",
  })) as CellsResponse
  expect(rendered.cells[0].preview?.box.kind).toBe("frac")
  expect(rendered.cells[0].preview?.status).toBe("complete")
  const sourceChunk = (await call("notebook.cells", {
    revision: doc.revision,
    indexes: [0],
    kind: "source",
    offset: 0,
  })) as CellsResponse
  expect(sourceChunk.cells[0].text!.length).toBe(16000)
  expect(sourceChunk.cells[0].total).toBeGreaterThan(2_000_000)
  const chunk = (await call("notebook.cells", {
    revision: doc.revision,
    indexes: [1],
    kind: "text",
    offset: 16000,
  })) as CellsResponse
  expect(chunk.cells[0].text).toBe("a".repeat(16000))
  const fresh = (await call("notebook.open")) as ViewerDocument
  expect(fresh.revision).not.toBe(doc.revision)
  await expect(call("notebook.save", { revision: doc.revision, edits: [] })).rejects.toThrow("changed on disk")
  expect(await readFile(path, "utf8")).toContain("new")
})

test("invalid requests, cross-file snapshots and disposed services reject", async () => {
  const { path, call } = await setup('Notebook[{Cell[BoxData[FractionBox["1","2"]],"Input"]}]')
  const doc = (await call("notebook.open")) as ViewerDocument
  for (const data of [
    { indexes: [-1], kind: "preview" },
    { indexes: Array(9).fill(0), kind: "preview" },
    { indexes: [0], kind: "eval" },
    { indexes: [0], kind: "source", offset: -1 },
  ])
    await expect(call("notebook.cells", { revision: doc.revision, ...data })).rejects.toThrow(
      "Invalid notebook preview request",
    )
  await expect(call("notebook.cells", { revision: "a".repeat(64), indexes: [0], kind: "preview" })).rejects.toThrow(
    "snapshot_expired",
  )
  const other = path.replace("preview.nb", "other.nb")
  await writeFile(other, "Notebook[{}]")
  await expect(
    call("notebook.cells", { path: other, revision: doc.revision, indexes: [0], kind: "preview" }),
  ).rejects.toThrow("snapshot_expired")
  await expect(call("notebook.run", { revision: doc.revision, index: 0 })).rejects.toThrow("not a supported")
})

test("save can return a compact preview snapshot without changing legacy read", async () => {
  const { call } = await setup('Notebook[{Cell["before","Text"],Cell[BoxData[FractionBox["1","2"]],"Output"]}]')
  const doc = (await call("notebook.open")) as ViewerDocument
  const next = (await call("notebook.save", {
    revision: doc.revision,
    edits: [{ index: 0, text: "after" }],
    preview: true,
  })) as ViewerDocument
  expect(next.cells[0].text).toBe("after")
  expect(next.cells[1].text).toBe("")
  const rendered = (await call("notebook.cells", {
    revision: next.revision,
    indexes: [1],
    kind: "preview",
  })) as CellsResponse
  expect(rendered.cells[0].preview?.status).toBe("complete")
  const legacy = (await call("notebook.read")) as ViewerDocument
  expect(legacy.cells[1].text).toContain("FractionBox")
})

test("snapshot LRU expires old paths and reopening restores the exact revision", async () => {
  const { call, dir } = await setup('Notebook[{Cell[BoxData[FractionBox["1","2"]],"Output"]}]')
  const first = (await call("notebook.open")) as ViewerDocument
  for (let i = 0; i < 5; i++) {
    const path = join(dir, `other-${i}.nb`)
    await writeFile(path, `Notebook[{Cell["${i}","Text"]}]`)
    await call("notebook.open", { path })
  }
  await expect(call("notebook.cells", { revision: first.revision, indexes: [0], kind: "preview" })).rejects.toThrow(
    "snapshot_expired",
  )
  const restored = (await call("notebook.open")) as ViewerDocument
  expect(restored.revision).toBe(first.revision)
  const result = (await call("notebook.cells", {
    revision: restored.revision,
    indexes: [0],
    kind: "preview",
  })) as CellsResponse
  expect(result.cells[0].preview?.status).toBe("complete")
})

test("worker cancellation does not poison later previews and disposal rejects new work", async () => {
  const { path } = await setup('Notebook[{Cell[BoxData[FractionBox["1","2"]],"Output"]}]')
  const manager = new NotebookPreviews(host().log)
  cleanup.push(() => manager.dispose())
  const controller = new AbortController()
  const pending = manager.call("open", path, {}, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow("cancelled")
  const doc = await manager.call<ViewerDocument>("open", path, {}, new AbortController().signal)
  const result = await manager.call<CellsResponse>(
    "cells",
    path,
    { revision: doc.revision, indexes: [0], kind: "preview" },
    new AbortController().signal,
  )
  expect(result.cells[0].preview?.status).toBe("complete")
  await manager.dispose()
  await expect(manager.call("open", path, {}, new AbortController().signal)).rejects.toThrow("stopped")
})

test("deep display content degrades locally and does not reject following cells", async () => {
  const deep = `${"RowBox[{".repeat(160)}"x"${"}]".repeat(160)}`
  const { call } = await setup(`Notebook[{Cell[BoxData[${deep}],"Output"],Cell["still visible","Text"]}]`)
  const doc = (await call("notebook.open")) as ViewerDocument
  expect(doc.cells[1].text).toBe("still visible")
  const result = (await call("notebook.cells", {
    revision: doc.revision,
    indexes: [0],
    kind: "preview",
  })) as CellsResponse
  expect(result.cells[0].preview?.status).toBe("limited")
})
