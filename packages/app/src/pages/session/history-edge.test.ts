import { describe, expect, test } from "bun:test"
import { createHistoryEdgeController } from "./history-edge"

describe("history edge controller", () => {
  test("input updates the cursor without requiring a preceding position event", () => {
    const edge = createHistoryEdgeController()
    expect(edge.noteUserInput({ delta: -20, top: 0, cursor: "page-2", gestureId: "g" }).shouldRequest).toBe(true)
    expect(edge.state().cursor).toBe("page-2")
  })
  test("requests from top on an outward input, including zero movement", () => {
    const edge = createHistoryEdgeController()
    expect(edge.noteUserInput({ delta: 0, top: 0, outward: true, gestureId: "wheel-1" }).shouldRequest).toBe(true)
    expect(edge.beginLoad()).toBe(true)
  })

  test("deduplicates repeated observations and input in one gesture/cursor", () => {
    const edge = createHistoryEdgeController()
    expect(edge.noteUserInput({ delta: -20, top: 0, gestureId: "g" }).shouldRequest).toBe(true)
    edge.beginLoad()
    expect(edge.observePosition({ top: 0 }).reason).toBe("in-flight")
    edge.endLoad({ result: "success", cursor: "c1" })
    // Cursor progress does not chain-load inside the same gesture.
    expect(edge.observePosition({ top: 0 }).reason).toBe("duplicate")
  })

  test("blocks a failed or stalled load for the current gesture", () => {
    const edge = createHistoryEdgeController()
    expect(edge.noteUserInput({ delta: -1, top: 0, gestureId: "g1" }).shouldRequest).toBe(true)
    edge.beginLoad()
    edge.endLoad({ result: "stalled", cursor: "same" })
    expect(edge.noteUserInput({ delta: -1, top: 0, gestureId: "g1" }).reason).toBe("blocked")
    expect(edge.noteUserInput({ delta: -1, top: 0, gestureId: "g2" }).shouldRequest).toBe(true)
  })

  test("does not request for inward movement or passive position events", () => {
    const edge = createHistoryEdgeController()
    expect(edge.observePosition({ top: 0 }).shouldRequest).toBe(false)
    expect(edge.noteUserInput({ delta: 5, top: 0, gestureId: "g" }).reason).toBe("top-not-outward")
    expect(edge.observePosition({ top: 0 }).reason).toBe("top-not-outward")
  })

  test("does not let an expired outward gesture request from a stale top event", () => {
    let time = 0
    const edge = createHistoryEdgeController({ now: () => time, gestureWindowMs: 100 })
    edge.noteUserInput({ delta: -1, top: 0, gestureId: "g" })
    time = 101
    expect(edge.observePosition({ top: 0 }).reason).toBe("top-not-outward")
  })

  test("does not chain after successful prepend and cursor compensation", () => {
    const edge = createHistoryEdgeController()
    edge.noteUserInput({ delta: -1, top: 0, gestureId: "g" })
    edge.beginLoad()
    edge.endLoad({ result: "success", cursor: "next" })
    expect(edge.observePosition({ top: 0, cursor: "next" }).reason).toBe("duplicate")
  })

  test("navigation landing is quiet, but fresh outward input works at the top", () => {
    const edge = createHistoryEdgeController()
    edge.reset({ navigation: true, cursor: "c0" })
    expect(edge.observePosition({ top: 0 }).reason).toBe("navigation-landing")
    expect(edge.noteUserInput({ delta: -2, top: 0, gestureId: "fresh" }).shouldRequest).toBe(true)
  })

  test("time groups wheel/touch events and starts a new gesture after the window", () => {
    let time = 0
    const edge = createHistoryEdgeController({ now: () => time, gestureWindowMs: 100 })
    expect(edge.noteUserInput({ delta: -1, top: 0, kind: "wheel" }).shouldRequest).toBe(true)
    edge.beginLoad()
    edge.endLoad({ result: "failed" })
    time = 200
    expect(edge.noteUserInput({ delta: -1, top: 0, kind: "wheel" }).shouldRequest).toBe(true)
  })
})
