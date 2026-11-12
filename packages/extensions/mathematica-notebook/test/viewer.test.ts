import { expect, test } from "bun:test"
import {
  applyOutline,
  cellText,
  createEditorResizeQueue,
  createReloadGate,
  draftEdits,
  isFoldable,
  isLargeText,
  LARGE_CELL_CHARACTERS,
  listStartMargin,
  pinnedCellPositions,
  PREVIEW_CHARACTERS,
  textPreview,
  viewerContent,
  visibleCells,
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

test("folded group headers hide their descendants, transitively", () => {
  const cells = [
    { ...cell(0), style: "Chapter", group: true },
    { ...cell(1), style: "Section", group: true, parent: 0 },
    { ...cell(2), parent: 1 },
    { ...cell(3), style: "Section", parent: 0 },
    cell(4),
  ]
  expect(visibleCells(cells, {}).map((item) => item.index)).toEqual([0, 1, 2, 3, 4])
  expect(visibleCells(cells, { 0: false }).map((item) => item.index)).toEqual([0, 1, 2, 3, 4])
  expect(visibleCells(cells, { 0: true }).map((item) => item.index)).toEqual([0, 4])
  expect(visibleCells(cells, { 1: true }).map((item) => item.index)).toEqual([0, 1, 3, 4])
})

test("the style fallback outlines ungrouped notebooks and only heads content", () => {
  const cells = [
    { ...cell(0), style: "Title" },
    { ...cell(1), style: "Section" },
    cell(2),
    { ...cell(3), style: "Subsection" },
    cell(4),
    { ...cell(5), style: "Section" },
  ]
  const outlined = applyOutline(cells)
  expect(outlined[0]).toMatchObject({ group: true })
  expect(outlined[1]).toMatchObject({ parent: 0, group: true })
  expect(outlined[2]).toMatchObject({ parent: 1 })
  expect(outlined[3]).toMatchObject({ parent: 1, group: true })
  expect(outlined[4]).toMatchObject({ parent: 3 })
  expect(outlined[5]).toMatchObject({ parent: 0 })
  // A trailing heading with no body gets no fold control.
  expect(outlined[5].group).toBeUndefined()
  expect(isFoldable(outlined[1])).toBe(true)
  expect(isFoldable(outlined[5])).toBe(false)
  // Once parsed or inferred grouping exists, the fallback never rewrites it.
  expect(applyOutline(outlined)).toEqual(outlined)
  const grouped = [{ ...cell(0), group: true }, { ...cell(1), parent: 0 }]
  expect(applyOutline(grouped)).toEqual(grouped)
  // Non-heading group headers (e.g. Input) are never foldable.
  expect(isFoldable({ ...cell(0), group: true })).toBe(false)
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
    "write b 902px",
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
