import { afterEach, describe, expect, test } from "bun:test"
import { createQuickAssistantReadingAnchor } from "./reading-anchor"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.body.replaceChildren()
})

function textGeometry(
  block: HTMLElement,
  point: (x: number, y: number) => Text,
  inset: (node: Text) => number,
  offset = 12,
) {
  const caretDescriptor = Object.getOwnPropertyDescriptor(document, "caretRangeFromPoint")
  const createRange = document.createRange
  Object.defineProperty(document, "caretRangeFromPoint", {
    configurable: true,
    value: (x: number, y: number) => ({ startContainer: point(x, y), startOffset: offset }),
  })
  let selected!: Text
  document.createRange = () =>
    ({
      setStart(node: Text) {
        selected = node
      },
      setEnd() {},
      getBoundingClientRect() {
        const box = block.getBoundingClientRect()
        return { ...box, top: box.top + inset(selected), bottom: box.top + inset(selected) + 20, width: 8, height: 20 }
      },
    }) as unknown as Range
  cleanups.push(() => {
    document.createRange = createRange
    if (caretDescriptor) Object.defineProperty(document, "caretRangeFromPoint", caretDescriptor)
    else Reflect.deleteProperty(document, "caretRangeFromPoint")
  })
}

function fixture() {
  const viewport = document.createElement("div")
  document.body.append(viewport)
  let height = 2000
  let top = 600
  let following = false
  let writes = 0
  let current: HTMLElement | undefined = viewport
  const positions = new Map<string, { top: number; height: number }>()
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 400 },
    clientTop: { get: () => 0 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => Math.max(0, Math.min(top, height - 400)),
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 400))
      },
    },
  })
  const rect = (start: number, size: number) =>
    ({
      top: start,
      bottom: start + size,
      left: 0,
      right: 500,
      width: 500,
      height: size,
      x: 0,
      y: start,
    }) as DOMRect
  viewport.getBoundingClientRect = () => rect(100, 400)
  const message = (id: string, start: number, size: number) => {
    const node = document.createElement("div")
    node.dataset.messageId = id
    viewport.append(node)
    node.getBoundingClientRect = () => rect(100 + start - viewport.scrollTop, size)
    return node
  }
  const block = (parent: HTMLElement, line: string, start: number, size = 100) => {
    const key = `${parent.dataset.messageId}:${line}`
    positions.set(key, { top: start, height: size })
    const node = document.createElement("p")
    node.dataset.sourceLine = line
    parent.append(node)
    node.getBoundingClientRect = () => {
      const value = positions.get(key)!
      return rect(100 + value.top - viewport.scrollTop, value.height)
    }
    return node
  }
  const first = message("first", 0, 500)
  block(first, "1", 0, 500)
  const reading = message("reading", 500, 1000)
  block(reading, "1", 500, 150)
  const selected = block(reading, "7", 650, 200)
  block(reading, "14", 850, 200)
  const below = message("below", 1500, 500)
  block(below, "1", 1500, 500)
  const logs: string[] = []
  const anchor = createQuickAssistantReadingAnchor({
    viewport: () => current,
    following: () => following,
    written: () => writes++,
    log: (line) => logs.push(line),
  })
  return {
    viewport,
    anchor,
    first,
    reading,
    below,
    selected,
    positions,
    logs,
    writes: () => writes,
    grow(delta: number) {
      height += delta
      positions.get("reading:7")!.top += delta
      positions.get("reading:14")!.top += delta
    },
    height: (next: number) => {
      height = next
    },
    follow: (next: boolean) => {
      following = next
    },
    replaceViewport: (next: HTMLElement | undefined) => {
      current = next
    },
    replaceBlock() {
      const replacement = block(reading, "7", positions.get("reading:7")!.top, 200)
      selected.replaceWith(replacement)
      return replacement
    },
  }
}

describe("quick assistant reading anchor", () => {
  test("compensates growth above the reading block inside a message spanning the viewport top", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.reading)
    f.grow(300)
    restore()
    expect(f.viewport.scrollTop).toBe(900)
    expect(f.selected.getBoundingClientRect().top).toBe(150)
    expect(f.writes()).toBe(1)
    expect(f.logs.some((line) => line.includes("delta=300"))).toBe(true)
  })

  test("handles shrinkage as well as growth", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.grow(-200)
    expect(f.anchor.restoreSnapshot(captured)).toBe(-200)
    expect(f.viewport.scrollTop).toBe(400)
    expect(f.selected.getBoundingClientRect().top).toBe(150)
  })

  test("finds replacement blocks by message and source line after morphing", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.reading)
    f.grow(200)
    const replacement = f.replaceBlock()
    restore()
    expect(replacement.getBoundingClientRect().top).toBe(150)
  })

  test("content growth below the reading block does not write the viewport", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.below)
    f.height(2500)
    restore()
    expect(f.viewport.scrollTop).toBe(600)
    expect(f.writes()).toBe(0)
  })

  test("preserves actual user movement between a saved snapshot and a resize", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.viewport.scrollTop = 650
    expect(f.anchor.scrolled(f.viewport)).toBe(false)
    f.grow(200)
    f.anchor.restoreSnapshot(captured)
    expect(f.viewport.scrollTop).toBe(850)
    expect(f.selected.getBoundingClientRect().top).toBe(100)
  })

  test("recognizes only unchanged programmatic scroll acknowledgments", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.reading)
    f.grow(200)
    restore()
    expect(f.anchor.scrolled(f.viewport)).toBe(true)
    f.viewport.scrollTop -= 30
    expect(f.anchor.scrolled(f.viewport)).toBe(false)

    const snapshot = f.anchor.snapshot()
    f.grow(100)
    f.anchor.restoreSnapshot(snapshot)
    f.viewport.scrollTop -= 40
    expect(f.anchor.scrolled(f.viewport)).toBe(false)
  })

  test("does not restore a missing block, detached root, replaced root, or reset generation", () => {
    for (const change of ["block", "detach", "replace", "reset"]) {
      const f = fixture()
      const restore = f.anchor.beforeUpdate(f.reading)
      f.grow(200)
      if (change === "block") f.selected.remove()
      if (change === "detach") f.viewport.remove()
      if (change === "replace") f.replaceViewport(document.createElement("div"))
      if (change === "reset") f.anchor.reset()
      restore()
      expect(f.writes()).toBe(0)
      f.viewport.remove()
    }
  })

  test("pins following mode to the actual new bottom", () => {
    const f = fixture()
    f.follow(true)
    f.viewport.scrollTop = 1600
    const restore = f.anchor.beforeUpdate(f.below)
    f.height(2300)
    restore()
    expect(f.viewport.scrollTop).toBe(1900)
    expect(f.anchor.scrolled(f.viewport)).toBe(true)
  })

  test("an upward takeover cancels a pending bottom restore", () => {
    const f = fixture()
    f.follow(true)
    const restore = f.anchor.beforeUpdate(f.below)
    f.follow(false)
    f.height(2300)
    restore()
    expect(f.writes()).toBe(0)
  })

  test("clips corrections to the scroll range and applies a restore only once", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.reading)
    f.grow(-800)
    restore()
    expect(f.viewport.scrollTop).toBe(0)
    expect(f.writes()).toBe(1)
    restore()
    expect(f.writes()).toBe(1)
  })

  test("does not confuse a synchronous layout clamp with user scroll intent", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(f.reading)
    f.grow(-450)
    f.height(800)
    restore()
    expect(f.viewport.scrollTop).toBe(150)
    expect(f.selected.getBoundingClientRect().top).toBe(150)
  })

  test("does not restore stale asynchronous snapshots after the reader passes the block", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.viewport.scrollTop = 1000
    f.anchor.scrolled(f.viewport)
    f.grow(200)
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
    expect(f.writes()).toBe(0)
  })

  test("ignores an update outside the active viewport", () => {
    const f = fixture()
    const restore = f.anchor.beforeUpdate(document.createElement("div"))
    f.grow(200)
    restore()
    expect(f.writes()).toBe(0)
  })

  test("keeps a visible character fixed when inline math reflows inside a long paragraph", () => {
    const f = fixture()
    f.selected.textContent = "A stable prose marker after many inline fractions remains visible."
    let inset = 30
    textGeometry(
      f.selected,
      () => f.selected.firstChild as Text,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    expect(captured?.text?.character).toBe(12)
    expect(captured?.text?.offset).toBe(80)
    inset = 130
    expect(f.anchor.restoreSnapshot(captured)).toBe(100)
    expect(f.viewport.scrollTop).toBe(700)
    expect(f.selected.getBoundingClientRect().top + inset).toBe(180)
  })

  test("resolves characters after text runs split around KaTeX and excludes controls", () => {
    const f = fixture()
    f.selected.textContent = "before the stable marker and after"
    let inset = 30
    textGeometry(
      f.selected,
      () => f.selected.firstChild as Text,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    const before = document.createTextNode("before the ")
    const math = document.createElement("span")
    math.className = "katex"
    math.textContent = "extra duplicated mathml fraction"
    const after = document.createElement("strong")
    after.textContent = "stable marker and after"
    const button = document.createElement("button")
    button.textContent = "Copy"
    f.selected.replaceChildren(before, math, after, button)
    inset = 90
    expect(f.anchor.restoreSnapshot(captured)).toBe(60)
    expect(f.selected.getBoundingClientRect().top + inset).toBe(180)
  })

  test("falls back to block geometry rather than a stale character when prose changes", () => {
    const f = fixture()
    f.selected.textContent = "The original prose marker remains visible."
    let inset = 30
    textGeometry(
      f.selected,
      () => f.selected.firstChild as Text,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    f.selected.textContent = "A different answer was streamed or edited."
    inset = 130
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
    expect(f.writes()).toBe(0)
  })

  test("excludes unrendered native math placeholders before a formula upgrade", () => {
    const f = fixture()
    const prose = document.createTextNode("A stable prose marker follows the inline formula.")
    const placeholder = document.createElement("span")
    placeholder.dataset.mathStyle = "inline"
    placeholder.textContent = "\\frac{x}{y}"
    f.selected.replaceChildren(placeholder, prose)
    let inset = 30
    textGeometry(
      f.selected,
      () => prose,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    expect(captured?.text?.text).toBe(prose.textContent)
    placeholder.removeAttribute("data-math-style")
    placeholder.className = "katex"
    placeholder.textContent = "different HTML and MathML math rendering"
    inset = 90
    expect(f.anchor.restoreSnapshot(captured)).toBe(60)
  })

  test("preserves a character across font-driven line shrinkage and simultaneous user scrolling", () => {
    const f = fixture()
    f.selected.textContent = "The stable marker inside this paragraph survives the font reflow."
    let inset = 30
    textGeometry(
      f.selected,
      () => f.selected.firstChild as Text,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    f.viewport.scrollTop = 630
    f.anchor.scrolled(f.viewport)
    inset = 10
    expect(f.anchor.restoreSnapshot(captured)).toBe(-20)
    expect(f.viewport.scrollTop).toBe(610)
    expect(f.selected.getBoundingClientRect().top + inset).toBe(150)
  })

  test("recognizes delayed layout clamping before ResizeObserver restores its snapshot", () => {
    const f = fixture()
    f.viewport.scrollTop = 800
    f.anchor.scrolled(f.viewport)
    const captured = f.anchor.snapshot()
    f.grow(-450)
    f.height(1000)
    expect(f.viewport.scrollTop).toBe(600)
    expect(f.anchor.scrolled(f.viewport)).toBe(true)
    expect(f.anchor.restoreSnapshot(captured)).toBe(-250)
    expect(f.viewport.scrollTop).toBe(350)
  })

  test("counts only actual user movement when a delayed clamp and wheel event coalesce", () => {
    const f = fixture()
    f.viewport.scrollTop = 800
    f.anchor.scrolled(f.viewport)
    const captured = f.anchor.snapshot()
    f.grow(-450)
    f.height(1000)
    f.viewport.scrollTop = 550
    expect(f.anchor.scrolled(f.viewport)).toBe(false)
    expect(f.anchor.restoreSnapshot(captured)).toBe(-250)
    expect(f.viewport.scrollTop).toBe(300)
  })

  test("uses a nearby visible character when the reading line falls in an interline gap", () => {
    const f = fixture()
    f.selected.textContent = "A stable prose marker remains below the interline gap."
    f.selected.style.lineHeight = "28px"
    let inset = 38
    textGeometry(
      f.selected,
      () => f.selected.firstChild as Text,
      () => inset,
    )
    const captured = f.anchor.snapshot()
    expect(captured?.text?.offset).toBe(88)
    inset += 100
    expect(f.anchor.restoreSnapshot(captured)).toBe(100)
    expect(f.selected.getBoundingClientRect().top + inset).toBe(188)
  })

  test("prefers an exact reading-line glyph over a nearer x probe's interline fallback", () => {
    const f = fixture()
    const near = document.createTextNode("A nearby prose marker.")
    const exact = document.createTextNode("The exact reading-line marker.")
    f.selected.replaceChildren(near, exact)
    f.selected.style.lineHeight = "28px"
    textGeometry(
      f.selected,
      (x) => (x < 100 ? near : exact),
      (node) => (node === near ? 38 : 25),
    )
    const captured = f.anchor.snapshot()
    expect(captured?.text?.character).toBe(near.length + 12)
    expect(captured?.text?.offset).toBe(75)
  })

  test("tries bounded y probes when inline math covers all original reading-line probes", () => {
    const f = fixture()
    const math = document.createElement("span")
    math.className = "katex"
    math.textContent = "A tall fraction"
    const prose = document.createTextNode("The stable plain prose immediately below the inline math.")
    f.selected.replaceChildren(math, prose)
    f.selected.style.lineHeight = "28px"
    let inset = 38
    textGeometry(
      f.selected,
      (_, y) => (y > 185 ? prose : (math.firstChild as Text)),
      () => inset,
    )
    const captured = f.anchor.snapshot()
    expect(captured?.text?.character).toBe(12)
    expect(captured?.text?.offset).toBe(88)
    inset += 100
    expect(f.anchor.restoreSnapshot(captured)).toBe(100)
  })

  test("does not select distant or offscreen glyphs as character anchors", () => {
    for (const inset of [90, -80, 360]) {
      const f = fixture()
      f.selected.textContent = "A stable prose marker must not be chosen far from the reading line."
      f.selected.style.lineHeight = "28px"
      textGeometry(
        f.selected,
        () => f.selected.firstChild as Text,
        () => inset,
      )
      expect(f.anchor.snapshot()?.text).toBeUndefined()
      f.viewport.remove()
    }
  })
})
