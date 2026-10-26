import { describe, expect, test } from "bun:test"
import { createBottomElasticity } from "./bottom-elasticity"

function harness() {
  const root = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }
  let current: typeof root | undefined = root
  let enabled = true
  let time = 0
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  const writes: { offset: number; phase?: string }[] = []
  const elasticity = createBottomElasticity({
    root: () => current,
    enabled: () => enabled,
    write: (_, offset, phase) => writes.push({ offset, phase }),
    request: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancel: (id) => frames.delete(id),
    now: () => time,
  })
  return {
    root,
    frames,
    writes,
    elasticity,
    disable: () => (enabled = false),
    detach: () => (current = undefined),
    replace: () => (current = { ...root }),
    frame: (dt = 16) => {
      time += dt
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(time))
    },
  }
}

describe("bottom elasticity", () => {
  test("only pulls after reaching the physical bottom", () => {
    const h = harness()
    h.root.scrollTop = 590
    h.elasticity.pull(300)
    h.frame()
    expect(h.writes).toEqual([])
    h.root.scrollTop = 599.5
    h.elasticity.pull(40)
    h.frame()
    expect(h.writes.at(-1)?.phase).toBe("pulling")
    expect(h.writes.at(-1)!.offset).toBeLessThan(0)
    expect(h.root.scrollTop).toBe(599.5)
    expect(h.root.scrollHeight).toBe(1000)
  })

  test("short and hidden viewports never pull", () => {
    for (const clientHeight of [1000, 1200, 0]) {
      const h = harness()
      h.root.clientHeight = clientHeight
      h.elasticity.pull(500)
      h.frame()
      expect(h.writes).toEqual([])
    }
  })

  test("large and repeated deltas stay bounded and share one frame", () => {
    const h = harness()
    h.elasticity.pull(40)
    h.frame()
    const first = -h.writes.at(-1)!.offset
    h.elasticity.pull(40)
    h.frame()
    const second = -h.writes.at(-1)!.offset
    expect(second - first).toBeLessThan(first)
    for (let i = 0; i < 100; i++) h.elasticity.pull(100_000)
    expect(h.frames.size).toBe(1)
    h.frame()
    expect(h.writes.at(-1)!.offset).toBeGreaterThanOrEqual(-20)
    expect(h.writes.at(-1)!.offset).toBeLessThan(0)
  })

  test("idle wheel input eases to zero and releases the frame", () => {
    const h = harness()
    h.elasticity.pull(160)
    h.frame(79)
    expect(h.writes.at(-1)?.phase).toBe("pulling")
    h.frame(1)
    expect(h.writes.at(-1)?.phase).toBe("settling")
    const start = h.writes.at(-1)!.offset
    h.frame(125)
    expect(h.writes.at(-1)!.offset).toBeGreaterThan(start)
    expect(h.writes.at(-1)!.offset).toBeLessThan(0)
    h.frame(125)
    expect(h.writes.at(-1)).toEqual({ offset: 0, phase: undefined })
    expect(h.frames.size).toBe(0)
  })

  test("new input interrupts settling without jumping back to the old offset", () => {
    const h = harness()
    h.elasticity.pull(80)
    h.frame(80)
    h.frame(125)
    const offset = h.writes.at(-1)!.offset
    h.elasticity.pull(1)
    h.frame(1)
    expect(h.writes.at(-1)?.phase).toBe("pulling")
    expect(h.writes.at(-1)!.offset).toBeLessThan(offset)
    expect(h.writes.at(-1)!.offset).toBeGreaterThan(offset - 1)
  })

  test("touch stays pulled until release and then settles immediately", () => {
    const h = harness()
    h.elasticity.pull(60, "touch")
    h.frame(500)
    expect(h.writes.at(-1)?.phase).toBe("pulling")
    h.elasticity.release()
    h.frame(125)
    expect(h.writes.at(-1)?.phase).toBe("settling")
    h.frame(125)
    expect(h.writes.at(-1)?.offset).toBe(0)
    expect(h.frames.size).toBe(0)
  })

  test("reverse, zero, and invalid input cancel immediately", () => {
    for (const delta of [-1, 0, NaN, Infinity]) {
      const h = harness()
      h.elasticity.pull(40)
      h.frame()
      h.elasticity.pull(delta)
      expect(h.writes.at(-1)).toEqual({ offset: 0, phase: undefined })
      expect(h.frames.size).toBe(0)
    }
  })

  test("growth, motion preference, navigation and root changes cancel before painting", () => {
    for (const reason of ["growth", "disabled", "detach", "replace", "reading"] as const) {
      const h = harness()
      h.elasticity.pull(40)
      h.frame()
      if (reason === "growth") h.root.scrollHeight += 20
      if (reason === "disabled") h.disable()
      if (reason === "detach") h.detach()
      if (reason === "replace") h.replace()
      if (reason === "reading") h.root.scrollTop -= 20
      h.frame()
      expect(h.writes.at(-1)).toEqual({ offset: 0, phase: undefined })
      expect(h.frames.size).toBe(0)
    }
  })

  test("disabled motion and programmatic scrolling cannot start an animation", () => {
    const h = harness()
    h.disable()
    h.elasticity.pull(100)
    h.frame()
    h.root.scrollTop = 600
    h.frame()
    expect(h.writes).toEqual([])
    expect(h.frames.size).toBe(0)
  })

  test("cleanup cancels pending frames without writing again", () => {
    const h = harness()
    h.elasticity.pull(100)
    h.elasticity.cancel()
    const count = h.writes.length
    h.frame(1000)
    expect(h.frames.size).toBe(0)
    expect(h.writes.length).toBe(count)
    expect(h.writes.at(-1)?.offset).toBe(0)
  })
})
