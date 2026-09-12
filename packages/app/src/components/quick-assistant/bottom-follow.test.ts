import { describe, expect, test } from "bun:test"
import { createBottomFollow } from "./bottom-follow"

const metrics = (scrollTop: number, scrollHeight = 1000, clientHeight = 200) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
})

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
    follow.pause()
    expect(follow.following()).toBe(false)
    follow.reset()
    expect(follow.following()).toBe(true)
  })
})
