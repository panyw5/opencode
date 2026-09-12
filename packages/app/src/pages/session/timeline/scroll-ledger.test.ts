import { describe, expect, test } from "bun:test"
import { createScrollLedger } from "./scroll-ledger"

describe("timeline scroll ledger", () => {
  test("uses the actual write delta supplied by the caller", () => {
    const ledger = createScrollLedger()
    ledger.recordWrite(0, 40, "layout")
    expect(ledger.observe(40).userDisplacement).toBe(0)
    expect(ledger.snapshot().layoutCompensation).toBe(40)
  })

  test("preserves a user reversal coalesced with a known system write", () => {
    const ledger = createScrollLedger({ initialTop: 0 })
    ledger.recordWrite(0, 500, "layout")
    // A -200 user move happened before the coalesced event; the net is +300.
    expect(ledger.observe(300, { user: true }).userDisplacement).toBe(-200)
  })

  test("coalesced native user and system movement reports only user displacement", () => {
    const ledger = createScrollLedger()
    ledger.observe(100)
    ledger.recordWrite(100, 150, "layout")
    expect(ledger.observe(175, { user: true }).userDisplacement).toBe(25)
  })

  test("navigation rebases a large jump before the next user movement", () => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    ledger.observe(10)
    ledger.recordWrite(10, 10_000, "navigation")
    time += 33.5
    const result = ledger.observe(10_033.5, { user: true })
    expect(result.userDisplacement).toBeCloseTo(33.5)
    expect(result.velocity).toBeCloseTo(0.3)
    expect(result.fast).toBe(false)
  })

  test("smooth wheel motion marked user contributes to velocity", () => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    ledger.observe(0)
    time = 20
    const result = ledger.observe(60, { user: true })
    expect(result.userDisplacement).toBe(60)
    expect(result.velocity).toBeCloseTo(0.9)
  })

  test("idle gaps clear speed", () => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    ledger.observe(0)
    time = 10
    ledger.observe(100, { user: true })
    expect(ledger.isFast()).toBe(true)
    time = 311
    expect(ledger.observe(100, { user: true }).fast).toBe(false)
    expect(ledger.velocity()).toBe(0)
  })

  test("duplicate asynchronous scroll events do not double count", () => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    ledger.observe(0)
    time = 10
    expect(ledger.observe(50, { user: true }).userDisplacement).toBe(50)
    time = 20
    expect(ledger.observe(50, { user: true }).userDisplacement).toBe(0)
  })

  test("zero-delta system writes do not clear velocity or rebase the ledger", () => {
    let time = 0
    const ledger = createScrollLedger({ now: () => time })
    ledger.observe(0)
    time = 10
    ledger.observe(100, { user: true })
    const before = ledger.snapshot()
    ledger.recordWrite(100, 100, "bottom")
    expect(ledger.snapshot()).toEqual(before)
  })
})
