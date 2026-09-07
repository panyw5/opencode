import { describe, expect, test } from "bun:test"
import {
  clearSessionPrefetch,
  clearSessionPrefetchDirectory,
  getSessionPrefetch,
  getSessionPrefetchStats,
  isSessionCold,
  markSessionCold,
  markSessionHot,
  neighboringMessagePrefetch,
  runSessionPrefetch,
  SESSION_PREFETCH_MAX,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "./session-prefetch"

describe("session prefetch", () => {
  test("prefetches message bodies for only the immediate neighbors", () => {
    const items = ["a", "b", "c", "d"]
    expect(neighboringMessagePrefetch(items, 2)).toEqual(["b", "d"])
    expect(neighboringMessagePrefetch(items, 0)).toEqual(["b"])
    expect(neighboringMessagePrefetch(items, -1)).toEqual([])
  })

  test("keeps cooled sessions out of prefetch until explicitly reopened", () => {
    markSessionCold("/tmp/cold", ["ses_1"])
    expect(isSessionCold("/tmp/cold", "ses_1")).toBe(true)
    markSessionHot("/tmp/cold", "ses_1")
    expect(isSessionCold("/tmp/cold", "ses_1")).toBe(false)
  })

  test("stores and clears message metadata by directory", () => {
    clearSessionPrefetch("/tmp/a", ["ses_1"])
    clearSessionPrefetch("/tmp/b", ["ses_1"])

    setSessionPrefetch({
      directory: "/tmp/a",
      sessionID: "ses_1",
      count: 200,
      cursor: "abc",
      complete: false,
      at: 123,
    })

    expect(getSessionPrefetch("/tmp/a", "ses_1")).toEqual({ count: 200, cursor: "abc", complete: false, at: 123 })
    expect(getSessionPrefetch("/tmp/b", "ses_1")).toBeUndefined()

    clearSessionPrefetch("/tmp/a", ["ses_1"])

    expect(getSessionPrefetch("/tmp/a", "ses_1")).toBeUndefined()
  })

  test("dedupes inflight work", async () => {
    clearSessionPrefetch("/tmp/c", ["ses_2"])

    let calls = 0
    const run = () =>
      runSessionPrefetch({
        directory: "/tmp/c",
        sessionID: "ses_2",
        task: async () => {
          calls += 1
          return { count: 100, cursor: "next", complete: true, at: 456 }
        },
      })

    const [a, b] = await Promise.all([run(), run()])

    expect(calls).toBe(1)
    expect(a).toEqual({ count: 100, cursor: "next", complete: true, at: 456 })
    expect(b).toEqual({ count: 100, cursor: "next", complete: true, at: 456 })
  })

  test("dedupes Windows path aliases using one workspace identity", async () => {
    const aliases = ["D:/identity-test", "d:/identity-test", "D:\\identity-test\\"]
    for (const directory of aliases) clearSessionPrefetch(directory, ["ses_windows"])

    setSessionPrefetch({
      directory: aliases[0],
      sessionID: "ses_windows",
      count: 3,
      cursor: "next",
      complete: false,
      at: 123,
    })

    for (const directory of aliases) {
      expect(getSessionPrefetch(directory, "ses_windows")).toEqual({
        count: 3,
        cursor: "next",
        complete: false,
        at: 123,
      })
    }

    let calls = 0
    const task = (directory: string) =>
      runSessionPrefetch({
        directory,
        sessionID: "ses_windows",
        task: async () => {
          calls += 1
          await Promise.resolve()
          return { count: 4, cursor: "after", complete: true, at: 456 }
        },
      })

    clearSessionPrefetch(aliases[0], ["ses_windows"])
    const [first, second] = await Promise.all([task(aliases[0]), task(aliases[2])])
    expect(calls).toBe(1)
    expect(first).toEqual(second)
    clearSessionPrefetchDirectory(aliases[1])
  })

  test("keeps POSIX path casing as separate identities", () => {
    clearSessionPrefetch("/Users/A/identity-test", ["ses_posix"])
    clearSessionPrefetch("/Users/a/identity-test", ["ses_posix"])

    setSessionPrefetch({
      directory: "/Users/A/identity-test",
      sessionID: "ses_posix",
      count: 1,
      complete: true,
      at: 1,
    })

    expect(getSessionPrefetch("/Users/a/identity-test", "ses_posix")).toBeUndefined()
    expect(getSessionPrefetch("/Users/A/identity-test", "ses_posix")).toEqual({
      count: 1,
      complete: true,
      at: 1,
    })

    clearSessionPrefetchDirectory("/Users/A/identity-test")
  })

  test("clears a whole directory", () => {
    setSessionPrefetch({ directory: "/tmp/d", sessionID: "ses_1", count: 10, cursor: "a", complete: true, at: 1 })
    setSessionPrefetch({ directory: "/tmp/d", sessionID: "ses_2", count: 20, cursor: "b", complete: false, at: 2 })
    setSessionPrefetch({ directory: "/tmp/e", sessionID: "ses_1", count: 30, cursor: "c", complete: true, at: 3 })

    clearSessionPrefetchDirectory("/tmp/d")

    expect(getSessionPrefetch("/tmp/d", "ses_1")).toBeUndefined()
    expect(getSessionPrefetch("/tmp/d", "ses_2")).toBeUndefined()
    expect(getSessionPrefetch("/tmp/e", "ses_1")).toEqual({ count: 30, cursor: "c", complete: true, at: 3 })
  })

  test("refreshes stale first-page prefetched history", () => {
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { count: 200, cursor: "x", complete: false, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(false)
  })

  test("cools down failed prefetches without a message cache", () => {
    const info = { count: 0, complete: false, at: 1 }

    expect(shouldSkipSessionPrefetch({ message: false, info, chunk: 200, now: 1 + 14_999 })).toBe(true)
    expect(shouldSkipSessionPrefetch({ message: false, info, chunk: 200, now: 1 + 15_001 })).toBe(false)
  })

  test("keeps deeper or complete history cached", () => {
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { count: 400, cursor: "x", complete: false, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(true)

    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: { count: 120, complete: true, at: 1 },
        chunk: 200,
        now: 1 + 15_001,
      }),
    ).toBe(true)
  })

  test("bounds metadata and does not retain cleared revision keys", () => {
    const revision = getSessionPrefetchStats().revision
    clearSessionPrefetch("/tmp/no-pending", ["session"])
    expect(getSessionPrefetchStats().revision).toBe(revision)

    for (let index = 0; index < SESSION_PREFETCH_MAX + 20; index += 1) {
      setSessionPrefetch({
        directory: "/tmp/bounded",
        sessionID: `session-${index}`,
        count: 1,
        complete: false,
        at: index,
      })
    }
    expect(getSessionPrefetchStats().cache).toBeLessThanOrEqual(SESSION_PREFETCH_MAX)
    clearSessionPrefetchDirectory("/tmp/bounded")
  })
})
