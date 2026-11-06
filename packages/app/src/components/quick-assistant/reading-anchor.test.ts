import { afterEach, describe, expect, test } from "bun:test"
import { createScrollLedger } from "../../pages/session/timeline/scroll-ledger"
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
  let clientHeight = 400
  let top = 600
  let isReading = true
  let userDisplacement = 0
  let writes = 0
  const ledger = createScrollLedger({ initialTop: top })
  const positions = new Map<string, { top: number; height: number }>()
  const maximum = () => Math.max(0, height - clientHeight)
  Object.defineProperties(viewport, {
    clientHeight: { get: () => clientHeight },
    clientTop: { get: () => 0 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, maximum()))
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
  viewport.getBoundingClientRect = () => rect(100, clientHeight)
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
  const write = (root: HTMLElement, target: number) => {
    const before = root.scrollTop
    root.scrollTop = target
    const after = root.scrollTop
    ledger.recordWrite(before, after, "layout")
    writes++
    return after - before
  }
  const anchor = createQuickAssistantReadingAnchor({
    viewport: () => viewport,
    reading: () => isReading,
    userDisplacement: () => userDisplacement,
    write,
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
    shrinkClamp() {
      const before = viewport.scrollTop
      // Model the browser's native clamp separately from the sole application write adapter.
      top = Math.min(top, maximum())
      ledger.recordWrite(before, top, "layout")
    },
    userScroll(next: number) {
      viewport.scrollTop = next
      const motion = ledger.observe(viewport.scrollTop, { user: true })
      userDisplacement += motion.userDisplacement
      return motion.userDisplacement
    },
    setReading: (next: boolean) => {
      isReading = next
    },
    clientHeight: (next: number) => {
      clientHeight = next
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
    const captured = f.anchor.snapshot()
    f.grow(300)
    expect(f.anchor.restoreSnapshot(captured)).toBe(300)
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
    const captured = f.anchor.snapshot()
    f.grow(200)
    const replacement = f.replaceBlock()
    f.anchor.restoreSnapshot(captured)
    expect(replacement.getBoundingClientRect().top).toBe(150)
  })

  test("content growth below the reading block does not write the viewport", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.height(2500)
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
    expect(f.viewport.scrollTop).toBe(600)
    expect(f.writes()).toBe(0)
  })

  test("preserves actual user movement between a saved snapshot and a resize", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    expect(f.userScroll(650)).toBe(50)
    f.grow(200)
    f.anchor.restoreSnapshot(captured)
    expect(f.viewport.scrollTop).toBe(850)
    expect(f.selected.getBoundingClientRect().top).toBe(100)
  })

  test("the shared ledger excludes anchor writes from subsequent user movement", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.grow(200)
    f.anchor.restoreSnapshot(captured)
    expect(f.userScroll(770)).toBe(-30)
    f.grow(100)
    expect(f.anchor.restoreSnapshot(captured)).toBe(100)
    expect(f.viewport.scrollTop).toBe(870)
    expect(f.selected.getBoundingClientRect().top).toBe(180)
  })

  test("does not restore a missing block or detached viewport", () => {
    for (const change of ["block", "detach"]) {
      const f = fixture()
      const captured = f.anchor.snapshot()
      f.grow(200)
      if (change === "block") f.selected.remove()
      if (change === "detach") f.viewport.remove()
      expect(f.anchor.restoreSnapshot(captured)).toBe(0)
      expect(f.writes()).toBe(0)
      f.viewport.remove()
    }
  })

  test("does not capture or restore outside reading mode", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.setReading(false)
    expect(f.anchor.snapshot()).toBeUndefined()
    f.grow(200)
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
    expect(f.writes()).toBe(0)
  })

  test("does not capture or restore a hidden viewport with zero clientHeight", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.clientHeight(0)
    expect(f.anchor.snapshot()).toBeUndefined()
    f.grow(200)
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
    expect(f.writes()).toBe(0)
  })

  test("delegates out-of-range corrections to the write adapter", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.grow(-800)
    expect(f.anchor.restoreSnapshot(captured)).toBe(-600)
    expect(f.viewport.scrollTop).toBe(0)
    expect(f.writes()).toBe(1)
  })

  test("does not confuse a synchronous layout clamp with user scroll intent", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.grow(-450)
    f.height(800)
    f.shrinkClamp()
    expect(f.viewport.scrollTop).toBe(400)
    f.anchor.restoreSnapshot(captured)
    expect(f.viewport.scrollTop).toBe(150)
    expect(f.selected.getBoundingClientRect().top).toBe(150)
  })

  test("does not restore stale asynchronous snapshots after the reader passes the block", () => {
    const f = fixture()
    const captured = f.anchor.snapshot()
    f.userScroll(1000)
    f.grow(200)
    expect(f.anchor.restoreSnapshot(captured)).toBe(0)
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
    f.userScroll(630)
    inset = 10
    expect(f.anchor.restoreSnapshot(captured)).toBe(-20)
    expect(f.viewport.scrollTop).toBe(610)
    expect(f.selected.getBoundingClientRect().top + inset).toBe(150)
  })

  test("recognizes delayed layout clamping before ResizeObserver restores its snapshot", () => {
    const f = fixture()
    f.userScroll(800)
    const captured = f.anchor.snapshot()
    f.grow(-450)
    f.height(1000)
    f.shrinkClamp()
    expect(f.viewport.scrollTop).toBe(600)
    expect(f.anchor.restoreSnapshot(captured)).toBe(-250)
    expect(f.viewport.scrollTop).toBe(350)
  })

  test("counts only actual user movement when a delayed clamp and wheel event coalesce", () => {
    const f = fixture()
    f.userScroll(800)
    const captured = f.anchor.snapshot()
    f.grow(-450)
    f.height(1000)
    f.shrinkClamp()
    expect(f.userScroll(550)).toBe(-50)
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
