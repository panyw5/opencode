import { expect, test } from "bun:test"
import {
  cellText,
  createEditorResizeQueue,
  createReloadGate,
  draftEdits,
  isLargeText,
  LARGE_CELL_CHARACTERS,
  listStartMargin,
  pinnedCellPositions,
  PREVIEW_CHARACTERS,
  textPreview,
  viewerContent,
  type ViewerCell,
} from "../src/viewer"

const cell = (index: number, text = "1 + 1"): ViewerCell => ({
  index,
  text,
  style: "Input",
  editable: true,
  runnable: true,
})

test("viewer document retains only projected fields and never retains a duplicate output map", () => {
  const output = { ok: true, text: "Graphic", printed: "", image: "large-base64" }
  const content = viewerContent({
    path: "/test.nb",
    revision: "r1",
    cells: [{ ...cell(0), raw: "large-source", start: 3, end: 100 } as ViewerCell],
    outputs: { 0: output },
  })
  expect(Object.keys(content).sort()).toEqual(["cells", "path", "revision"])
  expect(Object.keys(content.cells[0]).sort()).toEqual(["editable", "index", "runnable", "style", "text"])
  expect(content.cells[0].text).toBe("1 + 1")
})

test("large previews are display-only, saving and running always use original or draft text", () => {
  const original = "x".repeat(LARGE_CELL_CHARACTERS + 1)
  const giant = cell(4, original)
  expect(isLargeText(original)).toBe(true)
  expect(isLargeText(original.slice(1))).toBe(false)
  expect(textPreview(original)).toBe(original.slice(0, PREVIEW_CHARACTERS) + "…")
  expect(cellText(giant, {})).toBe(original)
  const draft = original + " + 1"
  expect(cellText(giant, { 4: draft })).toBe(draft)
  expect(draftEdits({ 4: draft })).toEqual([{ index: 4, text: draft }])
  expect(draftEdits({})).toEqual([])
  expect(cellText(giant, { 4: "" })).toBe("")
  expect(textPreview("small")).toBe("small")
})

test("focus and composition pin list positions, not notebook cell indexes", () => {
  const cells = [cell(2), cell(9), cell(25)]
  expect(pinnedCellPositions(cells, 9, 25)).toEqual([1, 2])
  expect(pinnedCellPositions(cells, 9, 9)).toEqual([1])
  expect(pinnedCellPositions(cells, undefined, 25)).toEqual([2])
  expect(pinnedCellPositions(cells, 99)).toEqual([])
  expect(pinnedCellPositions(cells)).toEqual([])
})

test("list offset uses real document geometry including scroll position and container border", () => {
  const scroller = {
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTop: 500,
    clientTop: 2,
  } as HTMLElement
  const anchor = { getBoundingClientRect: () => ({ top: -240 }) } as HTMLElement
  expect(listStartMargin(scroller, anchor)).toBe(158)
  scroller.scrollTop = 0
  expect(listStartMargin(scroller, anchor)).toBe(0)
})

test("reload gate aborts superseded reads and rejects stale completions even if RPC ignores abort", () => {
  const gate = createReloadGate()
  const first = gate.begin()
  expect(first.current()).toBe(true)
  const second = gate.begin()
  expect(first.signal.aborted).toBe(true)
  expect(first.current()).toBe(false)
  expect(second.current()).toBe(true)
  first.finish()
  gate.invalidate()
  expect(second.signal.aborted).toBe(true)
  expect(second.current()).toBe(false)
  const third = gate.begin()
  third.finish()
  expect(third.current()).toBe(true)
  gate.invalidate()
  expect(third.current()).toBe(false)
})

function resizeFixture() {
  let id = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const operations: string[] = []
  const logs: string[] = []
  const queue = createEditorResizeQueue((message) => logs.push(message), {
    request(callback) {
      callbacks.set(++id, callback)
      return id
    },
    cancel(id) {
      callbacks.delete(id)
    },
  })
  const field = (name: string, height: number, connected = true) =>
    ({
      isConnected: connected,
      style: {
        set height(value: string) {
          operations.push(`write ${name} ${value}`)
        },
      },
      get scrollHeight() {
        operations.push(`read ${name}`)
        return height
      },
    }) as unknown as HTMLTextAreaElement
  return {
    queue,
    field,
    operations,
    callbacks,
    logs,
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(0)
    },
  }
}

test("editor resize batches writes/reads/writes and coalesces requests and string logs", () => {
  const fixture = resizeFixture()
  const a = fixture.field("a", 50)
  const b = fixture.field("b", 900)
  fixture.queue.schedule({ field: a, syncScroll() {} })
  fixture.queue.schedule({ field: a, syncScroll() {} })
  fixture.queue.schedule({ field: b, syncScroll() {} })
  expect(fixture.callbacks.size).toBe(1)
  fixture.flush()
  expect(fixture.operations).toEqual([
    "write a auto",
    "write b auto",
    "read a",
    "read b",
    "write a 52px",
    "write b 600px",
  ])
  expect(fixture.logs).toEqual(["notebook editor layout cells=2 changed=2"])
})

test("editor resize cleanup cancels frames and drops disconnected or unmounted editors", () => {
  const fixture = resizeFixture()
  const a = fixture.field("a", 50)
  const disconnected = fixture.field("gone", 50, false)
  fixture.queue.schedule({ field: a, syncScroll() {} })
  fixture.queue.remove(a)
  expect(fixture.callbacks.size).toBe(0)
  fixture.queue.schedule({ field: disconnected, syncScroll() {} })
  fixture.flush()
  expect(fixture.operations).toEqual([])
  fixture.queue.schedule({ field: a, syncScroll() {} })
  fixture.queue.dispose()
  expect(fixture.callbacks.size).toBe(0)
  fixture.queue.schedule({ field: a, syncScroll() {} })
  expect(fixture.callbacks.size).toBe(0)
})
