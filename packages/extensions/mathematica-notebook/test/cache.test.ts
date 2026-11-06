import { expect, test } from "bun:test"
import { NotebookCache, cachedViewerCells, notebookBytes } from "../src/cache"
import { parseNotebook } from "../src/notebook"

function entry(text = "hello") {
  const source = `Notebook[{Cell["${text}", "Text"]}]`
  const notebook = parseNotebook(source)
  return { notebook, bytes: notebookBytes(notebook, source.length) }
}

test("parse cache hits refresh LRU order and entry count is bounded", () => {
  const cache = new NotebookCache(2, 10000)
  const first = entry("first")
  cache.set("a", first)
  cache.set("b", entry("second"))
  expect(cache.get("a")).toBe(first)
  cache.set("c", entry("third"))
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("a")).toBe(first)
  expect(cache.size).toBe(2)
})

test("parse cache enforces total estimated bytes and does not keep oversized results", () => {
  const first = entry()
  const cache = new NotebookCache(10, first.bytes * 2)
  cache.set("a", first)
  cache.set("b", entry())
  cache.set("c", entry())
  expect(cache.get("a")).toBeUndefined()
  expect(cache.size).toBe(2)
  expect(cache.bytes).toBe(first.bytes * 2)
  cache.set("large", { ...entry(), bytes: first.bytes * 3 })
  expect(cache.get("large")).toBeUndefined()
  expect(cache.size).toBe(2)
  cache.set("b", { ...first, bytes: first.bytes + 1 })
  expect(cache.get("c")).toBeUndefined()
  expect(cache.bytes).toBe(first.bytes + 1)
  cache.clear()
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
})

test("cached viewer DTO contains only public cell fields and parser result has no AST/spans", () => {
  const cached = entry()
  const cells = cachedViewerCells(cached)
  expect(cachedViewerCells(cached)).toBe(cells)
  expect(Object.keys(cells[0]).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(Object.keys(cached.notebook).sort()).toEqual(["cells", "empty", "insertAt"])
  expect(cells[0]).toEqual({ index: 0, style: "Text", text: "hello", editable: true, runnable: false })
  expect(cached.bytes).toBeGreaterThan(JSON.stringify(cached.notebook).length)
})
