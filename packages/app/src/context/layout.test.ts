import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  addSessionBarDraft,
  createSessionKeyReader,
  cycleSessionBarIndex,
  ensureSessionKey,
  pruneSessionKeys,
  removeSessionBarDraft,
  visibleSessionBarDrafts,
} from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("session bar drafts", () => {
  test("deduplicates drafts by workspace", () => {
    expect(addSessionBarDraft(["/work/project"], "/work/project/")).toEqual(["/work/project"])
    expect(addSessionBarDraft(["/work/project"], "/work/other")).toEqual(["/work/project", "/work/other"])
  })

  test("removes every path alias for a workspace", () => {
    expect(removeSessionBarDraft(["/work/project", "/work/other"], "/work/project/")).toEqual(["/work/other"])
  })

  test("keeps stored drafts after leaving the new-session route", () => {
    expect(visibleSessionBarDrafts(["/work/project"], "")).toEqual(["/work/project"])
  })

  test("includes the current draft before it is stored", () => {
    expect(visibleSessionBarDrafts([], "/work/project")).toEqual(["/work/project"])
  })

  test("hides a draft that is being closed on the current route", () => {
    expect(visibleSessionBarDrafts([], "/work/project", "/work/project/")).toEqual([])
  })

  test("cycles past the last session tab onto a draft", () => {
    expect(cycleSessionBarIndex(3, 1, 1)).toBe(2)
    expect(cycleSessionBarIndex(3, -1, 1)).toBe(0)
    expect(cycleSessionBarIndex(3, -1, -1)).toBe(2)
  })
})
