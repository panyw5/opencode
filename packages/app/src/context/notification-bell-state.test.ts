import { describe, expect, test } from "bun:test"
import {
  BELL_TOAST_TTL_MS,
  bellToastID,
  expireBellToasts,
  pushBellToast,
  removeBellToast,
  type BellToast,
} from "./notification-bell-state"

function toast(overrides: Partial<BellToast> = {}): BellToast {
  return {
    id: bellToastID("turn-complete", "ses_a"),
    type: "turn-complete",
    session: "ses_a",
    directory: "/x",
    title: "Session A",
    time: 1000,
    ...overrides,
  }
}

describe("notification bell toasts", () => {
  test("pushes newest toast to the head", () => {
    const a = toast({ id: "a" })
    const b = toast({ id: "b" })

    const next = pushBellToast([a], b)

    expect(next).toEqual([b, a])
  })

  test("replaces an older toast for the same session and type", () => {
    const older = toast({ id: "turn-complete:ses_a", time: 1000 })
    const other = toast({ id: "error:ses_b", type: "error", session: "ses_b" })
    const newer = toast({ id: "turn-complete:ses_a", time: 2000 })

    const next = pushBellToast([other, older], newer)

    expect(next).toEqual([newer, other])
  })

  test("caps the stack length", () => {
    let list: BellToast[] = []
    for (let i = 0; i < 6; i++) {
      list = pushBellToast(list, toast({ id: `t${i}`, session: `ses_${i}` }))
    }

    expect(list.map((toast) => toast.id)).toEqual(["t5", "t4", "t3", "t2"])
  })

  test("expires toasts older than the ttl", () => {
    const fresh = toast({ id: "fresh", time: BELL_TOAST_TTL_MS - 1 })
    const stale = toast({ id: "stale", time: 0 })

    expect(expireBellToasts([fresh, stale], BELL_TOAST_TTL_MS)).toEqual([fresh])
  })

  test("removes a toast by id", () => {
    const a = toast({ id: "a" })
    const b = toast({ id: "b" })

    expect(removeBellToast([b, a], "a")).toEqual([b])
    expect(removeBellToast([b, a], "missing")).toEqual([b, a])
  })
})
