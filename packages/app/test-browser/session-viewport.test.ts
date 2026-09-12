import { expect, test } from "bun:test"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createRoot, createSignal } from "solid-js"
import { captureVirtualViewportAnchor, restoreVirtualViewportAnchor } from "../src/pages/session/timeline/measure"
import { createScrollLedger } from "../src/pages/session/timeline/scroll-ledger"
import { createMessageNavigation } from "../src/pages/session/message-navigation"

const rootWithTop = (top: number, height = 300) => {
  const root = document.createElement("div")
  Object.defineProperty(root, "scrollTop", { configurable: true, get: () => top, set: (value) => (top = value) })
  Object.defineProperty(root, "clientHeight", { configurable: true, value: height })
  return { root, top: () => top }
}

test("barcode to find keeps the newest token through late virtual geometry", () => {
  createRoot((dispose) => {
    const navigation = createMessageNavigation()
    navigation.reset("session", "")
    const barcode = navigation.request({ kind: "message", id: "barcode", behavior: "auto" })
    const find = navigation.requestFind({
      kind: "find",
      rowKey: "row-find",
      messageID: "m",
      partID: "p",
      occurrence: 0,
      query: "needle",
      queryVersion: 1,
    })
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 3,
      getScrollElement: () => null,
      estimateSize: () => 100,
      initialRect: { width: 800, height: 300 },
    })
    virtualizer.resizeItem(1, 180)
    const geometry = virtualizer.getVirtualItems().find((item) => String(item.key) === "1")
    console.info("viewport lease", { barcode, find, geometry: geometry?.start })
    expect(navigation.current(barcode)).toBe(false)
    expect(navigation.current(find)).toBe(true)
    expect(geometry?.start).toBe(100)
    dispose()
  })
})

test("find supersedes barcode even when the old target lands late", () => {
  const navigation = createMessageNavigation()
  navigation.reset("session", "")
  const oldToken = navigation.request({ kind: "message", id: "barcode", behavior: "auto" })
  const newToken = navigation.requestFind({
    kind: "find",
    rowKey: "find",
    messageID: "m",
    partID: "p",
    occurrence: 0,
    query: "x",
    queryVersion: 1,
  })
  expect(navigation.finishSeek(oldToken, true)).toBe(false)
  expect(navigation.current(newToken)).toBe(true)
})

test("navigation jump is rebased before small user movement in a real virtualizer", () => {
  createRoot((dispose) => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 40,
      getScrollElement: () => null,
      estimateSize: () => 50,
      initialOffset: 1500,
      initialRect: { width: 800, height: 300 },
    })
    const scroll = rootWithTop(0)
    ledger.observe(0)
    ledger.recordWrite(0, 1500, "navigation")
    scroll.root.scrollTop = 1500
    virtualizer.scrollToOffset(1500)
    time += 33.5
    scroll.root.scrollTop = 1533.5
    const movement = ledger.observe(scroll.root.scrollTop, { user: true })
    console.info("navigation rebase", { virtualOffset: virtualizer.scrollOffset, movement })
    expect(virtualizer.scrollOffset).toBe(1500)
    expect(movement.userDisplacement).toBeCloseTo(33.5)
    expect(movement.fast).toBe(false)
    dispose()
  })
})

test("history prepend restores the captured anchor while preserving user displacement", () => {
  createRoot((dispose) => {
    const scroll = rootWithTop(500)
    const ledger = createScrollLedger({ initialTop: 500 })
    const before = [
      { key: "a", start: 0, size: 500 },
      { key: "b", start: 500, size: 300 },
      { key: "c", start: 800, size: 300 },
    ]
    const anchor = captureVirtualViewportAnchor(scroll.root, before, ledger.snapshot().systemCompensation)
    scroll.root.scrollTop = 540
    const user = ledger.observe(540, { user: true })
    const after = [
      { key: "old", start: 0, size: 400 },
      { key: "a", start: 400, size: 500 },
      { key: "b", start: 900, size: 300 },
      { key: "c", start: 1200, size: 300 },
    ]
    const delta = restoreVirtualViewportAnchor({
      root: scroll.root,
      anchor: anchor!,
      itemByKey: (key) => after.find((item) => String(item.key) === key),
      userScrollDelta: user.userDisplacement,
    })
    console.info("history prepend", { userDelta: user.userDisplacement, restoreDelta: delta, top: scroll.top() })
    expect(user.userDisplacement).toBe(40)
    expect(delta).toBe(400)
    expect(scroll.top()).toBe(940)
    dispose()
  })
})

test("reactive prepend resolves a shifted anchor by stable key across restore frames", () => {
  createRoot((dispose) => {
    const [keys, setKeys] = createSignal(["old", "a", "b"])
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return keys().length
      },
      getItemKey: (index) => keys()[index] ?? `missing-${index}`,
      getScrollElement: () => null,
      estimateSize: () => 100,
      initialRect: { width: 800, height: 200 },
    })
    const scroll = rootWithTop(50, 200)
    virtualizer.getTotalSize()
    const before = virtualizer.getVirtualItems()
    const anchor = captureVirtualViewportAnchor(scroll.root, before, 0)
    expect(anchor?.key).toBe("old")

    // Prepending changes every subsequent start while preserving row identity.
    setKeys(["new", "old", "a", "b"])
    const after = virtualizer.getVirtualItems()
    const filtered = after.filter((item) => String(item.key) !== "old")
    const indexByKey = new Map(keys().map((key, index) => [key, index]))
    const direct = virtualizer.measurementsCache[indexByKey.get("old")!]
    console.info("reactive prepend", {
      filteredHasAnchor: filtered.some((item) => String(item.key) === anchor?.key),
      directKey: direct?.key,
      total: virtualizer.getTotalSize(),
    })
    expect(filtered.some((item) => String(item.key) === anchor?.key)).toBe(false)
    expect(String(direct?.key)).toBe("old")

    // The user moves +40 while the prepend shifts the anchor by +100.
    scroll.root.scrollTop = 90
    const first = restoreVirtualViewportAnchor({
      root: scroll.root,
      anchor: anchor!,
      itemByKey: (key) => {
        const index = indexByKey.get(key)
        const item = index === undefined ? undefined : virtualizer.measurementsCache[index]
        return item && String(item.key) === key ? item : undefined
      },
      userScrollDelta: 40,
    })
    expect(first).toBe(100)
    expect(scroll.top()).toBe(190)

    // Recapture after restore: the next frame must not reverse the user's +40.
    const recaptured = captureVirtualViewportAnchor(scroll.root, virtualizer.getVirtualItems(), 100)
    const second = restoreVirtualViewportAnchor({
      root: scroll.root,
      anchor: recaptured!,
      itemByKey: (key) => {
        const index = indexByKey.get(key)
        return index === undefined ? undefined : virtualizer.measurementsCache[index]
      },
      userScrollDelta: 0,
    })
    expect(second).toBe(0)
    expect(scroll.top()).toBe(190)
    dispose()
  })
})
