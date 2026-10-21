import { describe, expect, test } from "bun:test"
import type { GptProCommand, GptProJob } from "./gpt-pro"
import {
  gptProArchivedResult,
  gptProCapabilities,
  gptProExecutionSnapshot,
  type GptProStateAPI,
  type GptProStateEvent,
  type GptProStateResponse,
} from "./gpt-pro-state"
import { createGptProStateStore } from "./gpt-pro-store"

function job(extra: Partial<GptProJob> = {}): GptProJob {
  return {
    id: "one",
    owner: "/repo\nowner",
    requestID: "one",
    phase: "paused",
    prompt: "prompt",
    url: "https://chatgpt.com/c/one",
    createdAt: 1,
    updatedAt: 1,
    stateVersion: 1,
    submitted: false,
    revision: 0,
    ...extra,
  }
}
function fixture() {
  let jobs = [job()]
  let sourceID = "source-one"
  let sequence = 1
  let listener: ((event: GptProStateEvent) => void) | undefined
  let override: ((id: string) => Promise<GptProStateResponse>) | undefined
  let lists = 0
  let subscriptions = 0
  const calls: GptProCommand[] = []
  const snapshot = () => ({
    type: "snapshot" as const,
    sourceID,
    sequence,
    jobs: jobs.map(gptProExecutionSnapshot),
    removed: [],
  })
  const response = (id = "one"): GptProStateResponse => ({
    sourceID,
    sequence,
    requestedID: id,
    state: { kind: "execution", job: gptProExecutionSnapshot(jobs.at(-1)!) },
  })
  const state: GptProStateAPI = {
    list: async () => {
      lists++
      return snapshot()
    },
    read: async (id) => (override ? override(id) : response(id)),
    subscribe: (callback) => {
      subscriptions++
      listener = callback
      callback(snapshot())
      return () => {
        subscriptions--
        listener = undefined
      }
    },
  }
  const client = {
    state,
    command: async (input: GptProCommand) => {
      calls.push(input)
      return jobs.at(-1)!
    },
  }
  const logs: string[] = []
  const store = createGptProStateStore(client, (line) => logs.push(line))
  return {
    store,
    client,
    calls,
    logs,
    response,
    snapshot,
    get lists() {
      return lists
    },
    get subscriptions() {
      return subscriptions
    },
    read(run: (id: string) => Promise<GptProStateResponse>) {
      override = run
    },
    replace(next: GptProJob[], seq = sequence + 1, source = sourceID) {
      jobs = next
      sequence = seq
      sourceID = source
    },
    emit(type: "snapshot" | "change" = "change", removed: string[] = []) {
      listener?.({ ...snapshot(), type, removed })
    },
    disconnect() {
      listener?.({ type: "disconnected", message: "offline" })
    },
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("GPT-Pro complete state contracts", () => {
  test("normalizes cleared execution fields without retaining private paths or answer bodies", () => {
    const state = gptProExecutionSnapshot(
      job({
        text: "private answer",
        html: "html",
        stagedAttachments: [{ id: "a", path: "/secret", sha256: "digest", uploadName: "a" }],
      }),
    )
    expect(state).toMatchObject({
      error: null,
      recovery: null,
      stopPending: false,
      background: false,
      attachments: [],
      userID: null,
    })
    expect(JSON.stringify(state)).not.toContain("/secret")
    expect(JSON.stringify(state)).not.toContain("private answer")
  })
  test("archives do not manufacture runtime fields or mutation authority", () => {
    const result = gptProArchivedResult(
      job({ phase: "completed", recovery: { stage: "ready", reason: "old", needsHuman: true } }),
    )
    expect(result).not.toHaveProperty("recovery")
    expect(result).not.toHaveProperty("attachments")
    expect(gptProCapabilities({ kind: "archive", result }, true)).toMatchObject({
      resume: false,
      stop: false,
      pause: false,
    })
    expect(() => gptProArchivedResult(job())).toThrow()
  })
  test("uncertain sends never gain resume authority", () => {
    expect(
      gptProCapabilities(
        { kind: "execution", job: gptProExecutionSnapshot(job({ phase: "send_uncertain", sendAttempted: true })) },
        true,
      ).resume,
    ).toBe(false)
    expect(gptProCapabilities({ kind: "execution", job: gptProExecutionSnapshot(job()) }, false).resume).toBe(false)
  })
})

describe("GPT-Pro shared state store", () => {
  test("deduplicates concurrent reads and uses one subscription for multiple cards", async () => {
    const f = fixture()
    const offA = f.store.watch("one", () => {})
    const offB = f.store.watch("one", () => {})
    expect(f.subscriptions).toBe(1)
    await tick()
    let reads = 0
    let finish!: (value: GptProStateResponse) => void
    f.read(() => {
      reads++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const a = f.store.refresh("one")
    const b = f.store.refresh("one")
    finish(f.response())
    await Promise.all([a, b])
    expect(reads).toBe(1)
    offA()
    expect(f.subscriptions).toBe(1)
    offB()
    expect(f.subscriptions).toBe(0)
    f.store.dispose()
  })
  test("cleared fields replace earlier errors, recovery, stopping, and attachments", async () => {
    const f = fixture()
    f.replace(
      [job({ error: "old", recovery: { stage: "ready", reason: "old", needsHuman: true }, stopPending: true })],
      1,
    )
    const off = f.store.watch("one", () => {})
    await tick()
    f.replace([job({ phase: "completed", stateVersion: 2 })])
    f.emit()
    expect(f.store.get("one")).toMatchObject({
      freshness: "current",
      state: {
        kind: "execution",
        job: { phase: "completed", error: null, recovery: null, stopPending: false, attachments: [] },
      },
    })
    off()
    f.store.dispose()
  })
  test("late reads cannot overwrite newer events", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    let finish!: (value: GptProStateResponse) => void
    const old = f.response()
    f.read(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const read = f.store.refresh("one")
    f.replace([job({ stateVersion: 2, phase: "completed" })])
    f.emit()
    finish(old)
    await read
    expect(f.store.get("one").state).toMatchObject({ job: { stateVersion: 2, phase: "completed" } })
    off()
    f.store.dispose()
  })
  test("source restarts fence in-flight replies from the previous controller", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    let finish!: (value: GptProStateResponse) => void
    const old = f.response()
    f.read(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const read = f.store.refresh("one")
    f.replace([job({ phase: "completed" })], 1, "new-controller")
    f.emit("snapshot")
    finish(old)
    await read
    expect(f.store.get("one").state).toMatchObject({ job: { phase: "completed" } })
    f.replace([job({ phase: "paused" })], 1, "source-one")
    f.emit("snapshot")
    expect(f.store.get("one").state).toMatchObject({ job: { phase: "completed" } })
    off()
    f.store.dispose()
  })
  test("stream gaps trigger a full resynchronization", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    const before = f.lists
    f.replace([job({ stateVersion: 4, phase: "completed" })], 4)
    f.emit()
    await tick()
    expect(f.lists).toBeGreaterThan(before)
    expect(f.logs.some((line) => line.includes("event gap"))).toBe(true)
    expect(f.store.get("one")).toMatchObject({ freshness: "current", state: { job: { stateVersion: 4 } } })
    off()
    f.store.dispose()
  })
  test("disconnects preserve the last verified snapshot but revoke action authority", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    f.disconnect()
    const entry = f.store.get("one")
    expect(entry).toMatchObject({ freshness: "stale", state: { job: { phase: "paused" } } })
    expect(gptProCapabilities(entry.state, entry.freshness === "current").resume).toBe(false)
    f.emit("snapshot")
    expect(f.store.get("one").freshness).toBe("current")
    off()
    f.store.dispose()
  })
  test("lookup failure never turns historical errors into current state", async () => {
    const f = fixture()
    f.read(async () => {
      throw new Error("missing")
    })
    await f.store.refresh("missing")
    expect(f.store.get("missing")).toMatchObject({ freshness: "unavailable", state: undefined })
    f.store.dispose()
  })
  test("completed cards follow new successors without remounting", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    f.replace([
      job({ stateVersion: 2, phase: "completed", successorID: "two" }),
      job({ id: "two", parentID: "one", phase: "generating" }),
    ])
    f.emit()
    expect(f.store.get("one").state).toMatchObject({ job: { id: "two", phase: "generating" } })
    off()
    f.store.dispose()
  })
  test("cross-owner or cyclic successor chains cannot authorize actions", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    f.replace([job({ stateVersion: 2, successorID: "two" }), job({ id: "two", owner: "foreign" })])
    f.emit()
    expect(f.store.get("one").freshness).toBe("unavailable")
    off()
    f.store.dispose()
  })
  test("archived lookup permits reads but never dispatches mutations", async () => {
    const f = fixture()
    f.read(async (id) => ({
      ...f.response(id),
      state: { kind: "archive", result: gptProArchivedResult(job({ id, phase: "completed" })) },
    }))
    await expect(f.store.command({ action: "resume", id: "archived" })).rejects.toThrow("no operation dispatched")
    expect(f.calls).toEqual([])
    f.store.dispose()
  })
  test("different bridge clients never share execution state", async () => {
    const first = fixture()
    const second = fixture()
    await first.store.refresh("one")
    expect(second.store.get("one")).toMatchObject({ freshness: "loading", state: undefined })
    first.store.dispose()
    second.store.dispose()
  })
  test("a failed old read cannot mark a newer event stale", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    let fail!: (error: Error) => void
    f.read(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    const request = f.store.refresh("one")
    f.replace([job({ phase: "completed", stateVersion: 2 })])
    f.emit()
    fail(new Error("old connection failed"))
    await request
    expect(f.store.get("one")).toMatchObject({ freshness: "current", state: { job: { phase: "completed" } } })
    off()
    f.store.dispose()
  })
  test("pruned execution records become archive results without retained runtime fields", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    f.read(async (id) => ({
      sourceID: "source-one",
      sequence: 2,
      requestedID: id,
      state: { kind: "archive", result: gptProArchivedResult(job({ phase: "completed" })) },
    }))
    f.replace([], 2)
    f.emit("change", ["one"])
    await tick()
    expect(f.store.get("one")).toMatchObject({
      freshness: "current",
      state: { kind: "archive", result: { phase: "completed" } },
    })
    expect(f.store.get("one").state).not.toHaveProperty("job")
    off()
    f.store.dispose()
  })
  test("duplicate operations on separate cards dispatch only once", async () => {
    const f = fixture()
    await f.store.refresh("one")
    let finish!: (value: GptProJob) => void
    let dispatched = 0
    f.client.command = async () => {
      dispatched++
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    const first = f.store.command({ action: "resume", id: "one" })
    await tick()
    expect(f.store.get("one").pending).toBe("resume")
    await expect(f.store.command({ action: "resume", id: "one" })).rejects.toThrow("already in progress")
    finish(job())
    await first
    expect(dispatched).toBe(1)
    expect(f.store.get("one").pending).toBeUndefined()
    f.store.dispose()
  })
  test("legacy bridges use one complete live list, not archived status fields", async () => {
    const client = { list: async () => [job({ phase: "completed" })], command: async () => job() }
    const store = createGptProStateStore(client)
    expect(await store.refresh("one")).toMatchObject({
      freshness: "current",
      state: { kind: "execution", job: { phase: "completed", recovery: null } },
    })
    store.dispose()
  })
  test("unmounted subscriptions invalidate cached status until it is verified again", async () => {
    const f = fixture()
    const off = f.store.watch("one", () => {})
    await tick()
    off()
    expect(f.store.get("one").freshness).toBe("stale")
    const next = f.store.watch("one", () => {})
    await tick()
    expect(f.store.get("one").freshness).toBe("current")
    next()
    f.store.dispose()
  })
  test("disposed stores ignore outstanding responses", async () => {
    const f = fixture()
    let finish!: (value: GptProStateResponse) => void
    f.read(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const request = f.store.refresh("one")
    f.store.dispose()
    finish(f.response())
    await request
    expect(f.store.get("one").state).toBeUndefined()
  })
})
