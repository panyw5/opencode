import { describe, expect, test } from "bun:test"
import {
  bindBottomFollowWheel,
  createBottomFollow,
  observeBottomFollowTargets,
  replaceBottomFollowContent,
} from "./bottom-follow"

const metrics = (scrollTop: number, scrollHeight = 1000, clientHeight = 200) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})

function wheelTarget() {
  const listeners = new Set<(event: WheelEvent) => void>()
  let passive = false
  const target = {
    addEventListener(
      _type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      listeners.add(listener as (event: WheelEvent) => void)
      if (typeof options === "object") passive = options.passive ?? false
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener as (event: WheelEvent) => void)
    },
  } as unknown as HTMLElement
  return {
    target,
    passive: () => passive,
    count: () => listeners.size,
    emit(deltaY: number) {
      for (const listener of listeners) listener({ deltaY } as WheelEvent)
    },
  }
}

describe("quick assistant bottom follow", () => {
  test("content growth does not detach even when it exceeds bottom tolerance", () => {
    const follow = createBottomFollow()
    follow.written(metrics(800))
    expect(follow.scrolled(metrics(800, 1400))).toBe(true)
  })
  test("user scrolling up pauses until they return to bottom", () => {
    const follow = createBottomFollow()
    follow.written(metrics(800))
    expect(follow.scrolled(metrics(700))).toBe(false)
    expect(follow.scrolled(metrics(750, 1400))).toBe(false)
    expect(follow.scrolled(metrics(1200, 1400))).toBe(true)
  })
  test("layout shrinkage clamps without detaching", () => {
    const follow = createBottomFollow()
    follow.written(metrics(800))
    expect(follow.scrolled(metrics(400, 600))).toBe(true)
  })
  test("upward intent pauses before a pending scroll write", () => {
    const follow = createBottomFollow()
    follow.written(metrics(800))
    let writes = 0
    const target = wheelTarget()
    const dispose = bindBottomFollowWheel(target.target, follow, () => {})
    target.emit(-1)
    if (follow.following()) writes++
    expect(writes).toBe(0)
    expect(follow.following()).toBe(false)
    dispose()
  })

  test("passive wheel binding ignores downward and zero deltas and logs only state transitions", () => {
    const follow = createBottomFollow()
    const target = wheelTarget()
    let pausedLogs = 0
    const dispose = bindBottomFollowWheel(target.target, follow, () => pausedLogs++)
    expect(target.passive()).toBe(true)

    target.emit(1)
    target.emit(0)
    expect(follow.following()).toBe(true)
    expect(pausedLogs).toBe(0)

    target.emit(-1)
    target.emit(-2)
    expect(follow.following()).toBe(false)
    expect(pausedLogs).toBe(1)
    dispose()
  })

  test("bottom recovery permits the next upward wheel to pause again", () => {
    const follow = createBottomFollow()
    const target = wheelTarget()
    let pausedLogs = 0
    const dispose = bindBottomFollowWheel(target.target, follow, () => pausedLogs++)
    follow.written(metrics(800))

    target.emit(-1)
    target.emit(-1)
    expect(pausedLogs).toBe(1)
    expect(follow.scrolled(metrics(800))).toBe(true)
    target.emit(-1)
    expect(follow.following()).toBe(false)
    expect(pausedLogs).toBe(2)
    dispose()
  })

  test("disposing and rebinding does not retain a stale wheel listener", () => {
    const follow = createBottomFollow()
    const target = wheelTarget()
    let pausedLogs = 0
    const first = bindBottomFollowWheel(target.target, follow, () => pausedLogs++)
    expect(target.count()).toBe(1)
    first()
    first()
    expect(target.count()).toBe(0)
    target.emit(-1)
    expect(pausedLogs).toBe(0)

    follow.reset()
    const second = bindBottomFollowWheel(target.target, follow, () => pausedLogs++)
    expect(target.count()).toBe(1)
    target.emit(-1)
    expect(pausedLogs).toBe(1)
    second()
    expect(target.count()).toBe(0)
  })

  test("observes content whether the child ref runs before or after the viewport ref", () => {
    const observed = new Set<Element>()
    const unobserved: Element[] = []
    const observer = {
      observe: (target: Element) => observed.add(target),
      unobserve: (target: Element) => {
        observed.delete(target)
        unobserved.push(target)
      },
    }
    const viewport = {} as Element
    const childFirst = {} as Element
    let content: Element | undefined

    content = replaceBottomFollowContent(undefined, content, childFirst)
    observeBottomFollowTargets(observer, viewport, content)
    expect(observed.has(viewport)).toBe(true)
    expect(observed.has(childFirst)).toBe(true)

    const childAfter = {} as Element
    content = replaceBottomFollowContent(observer, content, childAfter)
    expect(unobserved).toEqual([childFirst])
    expect(observed.has(childFirst)).toBe(false)
    expect(observed.has(childAfter)).toBe(true)
  })
})
