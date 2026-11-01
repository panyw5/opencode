import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { loadRootSessions, RootSessionLoadTimeoutError } from "./global-sync/session-load"

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessions", () => {
  test("uses a full roots query", async () => {
    const calls: Array<{ directory: string; roots: true }> = []

    const result = await loadRootSessions({
      directory: "dir",
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(calls).toEqual([{ directory: "dir", roots: true }])
  })

  test("times out when the roots query never settles", async () => {
    const result = loadRootSessions({
      directory: "dir",
      timeoutMs: 1,
      list: () => new Promise(() => {}),
    })

    await expect(result).rejects.toBeInstanceOf(RootSessionLoadTimeoutError)
  })

  test("uses the host directory for both the query and sidebar visibility metadata", async () => {
    const steps: string[] = []
    const result = await loadRootSessions({
      directory: "~/apps/opencode",
      resolveDirectory: async (directory) => {
        steps.push(`resolve:${directory}`)
        return "/Users/test/apps/opencode"
      },
      list: async (query) => {
        steps.push(`list:${query.directory}`)
        expect(query.roots).toBe(true)
        return { data: [] }
      },
    })
    expect(steps).toEqual(["resolve:~/apps/opencode", "list:/Users/test/apps/opencode"])
    expect(result.directory).toBe("/Users/test/apps/opencode")
  })

  test("does not list an unresolved directory when host resolution fails", async () => {
    let listed = false
    await expect(
      loadRootSessions({
        directory: "~/missing",
        resolveDirectory: async () => {
          throw new Error("Directory unavailable")
        },
        list: async () => {
          listed = true
          return { data: [] }
        },
      }),
    ).rejects.toThrow("Directory unavailable")
    expect(listed).toBe(false)
  })

  test("includes directory resolution in the session load timeout", async () => {
    await expect(
      loadRootSessions({
        directory: "~/apps/opencode",
        timeoutMs: 1,
        resolveDirectory: () => new Promise(() => {}),
        list: async () => ({ data: [] }),
      }),
    ).rejects.toBeInstanceOf(RootSessionLoadTimeoutError)
  })

  test("aborts a timed-out query instead of leaving the network request running", async () => {
    let signal: AbortSignal | undefined
    await expect(
      loadRootSessions({
        directory: "/repo",
        timeoutMs: 1,
        list: (_query, next) => {
          signal = next
          return new Promise(() => {})
        },
      }),
    ).rejects.toBeInstanceOf(RootSessionLoadTimeoutError)
    expect(signal?.aborted).toBe(true)
  })

  test("does not dispatch a session query after timed-out directory resolution completes late", async () => {
    let release!: (directory: string) => void
    let listed = false
    let signal: AbortSignal | undefined
    const pending = loadRootSessions({
      directory: "~/apps/opencode",
      timeoutMs: 1,
      resolveDirectory: (_directory, next) => {
        signal = next
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
      list: async () => {
        listed = true
        return { data: [] }
      },
    })
    await expect(pending).rejects.toBeInstanceOf(RootSessionLoadTimeoutError)
    release("/host/apps/opencode")
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(listed).toBe(false)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
