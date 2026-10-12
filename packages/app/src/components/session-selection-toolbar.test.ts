import { expect, test } from "bun:test"
import { createSelectionFrameScheduler, readSessionSelection } from "./session-selection-state"

function selected(root: HTMLElement, range: Range) {
  return readSessionSelection({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }, root)
}

test("empty selections do not inspect a range or schedule layout", () => {
  const root = document.createElement("div")
  const selection = {
    rangeCount: 0,
    get isCollapsed(): boolean {
      throw new Error("unnecessary selection read")
    },
  } as Selection
  expect(readSessionSelection(selection, root)).toBeUndefined()
  expect(readSessionSelection(null, root)).toBeUndefined()
  expect(readSessionSelection({ rangeCount: 1, isCollapsed: true } as Selection, root)).toBeUndefined()
})

test("valid selection text and Range are captured once", () => {
  const root = document.createElement("div")
  root.innerHTML = '<div data-component="markdown"><p>selected words</p></div>'
  const range = document.createRange()
  range.selectNodeContents(root.querySelector("p")!)
  let reads = 0
  const text = range.toString.bind(range)
  range.toString = () => {
    reads++
    return text()
  }
  const result = selected(root, range)
  expect(reads).toBe(1)
  expect(result?.length).toBe(14)
  expect(result?.range).not.toBe(range)
  expect(result?.range.toString()).toBe("selected words")
})

test("outside and interactive selections never extract text", () => {
  const root = document.createElement("div")
  root.innerHTML = '<div data-component="markdown"><button>button</button><div contenteditable="true">draft</div></div>'
  const range = document.createRange()
  range.toString = () => {
    throw new Error("unexpected text extraction")
  }
  range.selectNodeContents(document.createElement("p"))
  expect(selected(root, range)).toBeUndefined()
  range.selectNodeContents(root.querySelector("button")!)
  expect(selected(root, range)).toBeUndefined()
  range.selectNodeContents(root.querySelector("[contenteditable]")!)
  expect(selected(root, range)).toBeUndefined()
})

test("whitespace-only content is rejected", () => {
  const root = document.createElement("div")
  root.innerHTML = '<div data-component="markdown">   </div>'
  const range = document.createRange()
  range.selectNodeContents(root.firstElementChild!)
  expect(selected(root, range)).toBeUndefined()
})

test("scroll bursts share one frame and future frames remain schedulable", () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextID = 0
  let updates = 0
  const scheduler = createSelectionFrameScheduler(() => updates++, {
    request: (callback) => {
      const id = nextID++
      callbacks.set(id, callback)
      return id
    },
    cancel: (id) => {
      callbacks.delete(id)
    },
  })
  for (let i = 0; i < 100; i++) scheduler.schedule()
  expect(callbacks.size).toBe(1)
  callbacks.get(0)!(0)
  callbacks.delete(0)
  expect(updates).toBe(1)
  scheduler.schedule()
  expect(callbacks.size).toBe(1)
  scheduler.cancel()
  expect(callbacks.size).toBe(0)
  expect(updates).toBe(1)
  scheduler.schedule()
  callbacks.get(2)!(0)
  expect(updates).toBe(2)
})
