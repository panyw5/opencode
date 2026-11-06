import { expect, test } from "bun:test"
import { createFileWatchRegistry } from "./watch-policy"

test("path leases count content modes independently, with text taking priority", () => {
  const counts: Array<[string, number]> = []
  const watches = createFileWatchRegistry((file, count) => counts.push([file, count]))
  const self = watches.acquire("notebook.nb", "self")
  expect(watches.mode("notebook.nb")).toBe("self")
  const text = watches.acquire("notebook.nb")
  const other = watches.acquire("other.nb", "self")
  expect(watches.mode("notebook.nb")).toBe("text")
  expect(watches.mode("other.nb")).toBe("self")
  text()
  expect(watches.mode("notebook.nb")).toBe("self")
  text()
  self()
  other()
  expect(watches.mode("notebook.nb")).toBeUndefined()
  expect(counts).toEqual([
    ["notebook.nb", 1],
    ["notebook.nb", 2],
    ["other.nb", 1],
    ["notebook.nb", 1],
    ["notebook.nb", 0],
    ["other.nb", 0],
  ])
})

test("old scope releases cannot decrement a new same-path watch", () => {
  const counts: number[] = []
  const watches = createFileWatchRegistry((_, count) => counts.push(count))
  const old = watches.acquire("same.nb", "text")
  watches.reset()
  const fresh = watches.acquire("same.nb", "self")
  old()
  expect(watches.mode("same.nb")).toBe("self")
  expect(counts).toEqual([1, 1])
  fresh()
  expect(watches.mode("same.nb")).toBeUndefined()
  expect(counts).toEqual([1, 1, 0])
})
