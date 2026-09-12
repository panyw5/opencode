import { describe, expect, test } from "bun:test"
import { createLiveBottomFollow, liveBottomStep } from "./live-bottom"

function harness(motionOverride = true) {
  let enabled = true
  let reduced = false
  let id = 0
  let time = 0
  const frames = new Map<number, FrameRequestCallback>()
  const root = { scrollTop: 0, scrollHeight: 420, clientHeight: 400 }
  let current: typeof root | undefined = root
  const writes: number[] = []
  const logs: string[] = []
  const follow = createLiveBottomFollow({
    root: () => current,
    enabled: () => enabled,
    ...(motionOverride ? { reducedMotion: () => reduced } : {}),
    write: (root, top) => {
      root.scrollTop = top
      writes.push(top)
    },
    request: (callback) => {
      frames.set(++id, callback)
      return id
    },
    cancel: (id) => frames.delete(id),
    log: (line) => logs.push(line),
  })
  return {
    root,
    frames,
    writes,
    logs,
    follow,
    disable: () => (enabled = false),
    detach: () => (current = undefined),
    reduce: () => (reduced = true),
    frame: (dt = 1000 / 60) => {
      time += dt
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(time))
    },
  }
}

describe("live bottom follow", () => {
  test("small streaming lines ease across frames instead of snapping", () => {
    const h = harness()
    h.follow.follow()
    h.frame()
    expect(h.root.scrollTop).toBeGreaterThan(0)
    expect(h.root.scrollTop).toBeLessThan(20)
    for (let i = 0; i < 40; i++) h.frame()
    expect(20 - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(h.frames.size).toBe(0)
    expect(h.follow.active()).toBe(false)
    expect(h.logs.at(-1)).toBe("stop reason=settled")
  })

  test("the session's default follow path always animates without a motion override", () => {
    const h = harness(false)
    expect(liveBottomStep(20, 1000 / 60)).toBeLessThan(3)
    h.follow.follow()
    h.frame()
    console.debug(`[live-bottom-test] default-follow first-step=${h.root.scrollTop}`)
    expect(h.root.scrollTop).toBeLessThan(3)
    expect(h.follow.active()).toBe(true)
  })

  test("multiple resize and scroll callbacks share a single frame", () => {
    const h = harness()
    for (let i = 0; i < 10; i++) h.follow.follow()
    expect(h.frames.size).toBe(1)
    h.frame()
    expect(h.writes.length).toBe(1)
    expect(h.frames.size).toBe(1)
  })

  test("retargets growing output and finishes even without another resize", () => {
    const h = harness()
    h.follow.follow()
    h.frame()
    h.root.scrollHeight += 80
    for (let i = 0; i < 60; i++) h.frame()
    expect(100 - h.root.scrollTop).toBeLessThanOrEqual(1)
    expect(h.writes.every((top, i, all) => i === 0 || top >= all[i - 1])).toBe(true)
    expect(h.follow.active()).toBe(false)
  })

  test("user takeover cancels before the next write", () => {
    const h = harness()
    h.follow.follow()
    h.frame()
    const top = h.root.scrollTop
    h.disable()
    h.frame()
    expect(h.root.scrollTop).toBe(top)
    expect(h.frames.size).toBe(0)
    expect(h.logs.at(-1)).toBe("stop reason=takeover")
  })

  test("session changes and cleanup do not write to an old viewport", () => {
    const h = harness()
    h.follow.follow()
    h.detach()
    h.frame()
    expect(h.writes).toEqual([])
    const other = harness()
    other.follow.follow()
    other.follow.cancel("cleanup")
    other.frame()
    expect(other.writes).toEqual([])
    expect(other.frames.size).toBe(0)
  })

  test("reduced motion and large initial gaps snap immediately", () => {
    const h = harness()
    h.reduce()
    h.follow.follow()
    h.frame()
    expect(h.root.scrollTop).toBe(20)
    expect(liveBottomStep(1200, 16)).toBe(1200)
  })

  test("easing is time-based at 60Hz and 120Hz", () => {
    const duration = 1000 / 60
    const full = liveBottomStep(500, duration)
    const half = liveBottomStep(500, duration / 2)
    expect(half + liveBottomStep(500 - half, duration / 2)).toBeCloseTo(full, 8)
    expect(liveBottomStep(500, 200)).toBe(liveBottomStep(500, 64))
  })

  test("height shrink during an animation cannot scroll beyond the new bottom", () => {
    const h = harness()
    h.follow.follow()
    h.frame()
    h.root.scrollHeight = 400
    h.frame()
    expect(h.root.scrollTop).toBe(0)
    expect(h.follow.active()).toBe(false)
  })
})
