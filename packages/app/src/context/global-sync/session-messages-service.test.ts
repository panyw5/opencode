import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createSessionMessagesService } from "./session-messages-service"
import { createSessionControllerHarness, deferred } from "./session-service-test-utils"

const message = (id: string, completed = 1) =>
  ({ id, sessionID: "session", role: "assistant", time: { created: 1, completed } }) as Message

const part = (text: string) =>
  ({ id: "part", sessionID: "session", messageID: "message", type: "text", text }) as Part

const response = (messages: Message[], parts: Part[] = []) => ({
  data: messages.map((info) => ({ info, parts: info.id === "message" ? parts : [] })),
  response: { headers: { get: () => null } },
})

describe("session messages controller", () => {
  test("dedupes concurrent loads", async () => {
    const request = deferred<ReturnType<typeof response>>()
    let calls = 0
    const harness = createSessionControllerHarness({
      messages: async () => {
        calls += 1
        return request.promise
      },
    })
    const service = createSessionMessagesService(harness.deps)
    const first = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    const second = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    expect(first).toBe(second)
    expect(calls).toBe(1)
    request.resolve(response([message("message")], [part("done")]))
    expect((await first).committed).toBe(true)
    expect(await second).toMatchObject({ committed: true, count: 1 })
    expect(service.get("/project", "session")).toHaveLength(1)
    expect(service.inspect()).toEqual({
      revision: 0,
      discardRevision: 0,
      generation: 0,
      pageInflight: 0,
      inflight: 0,
      optimistic: 0,
      loading: 0,
    })
  })

  test("merges incremental SSE state over an older HTTP snapshot", async () => {
    const request = deferred<ReturnType<typeof response>>()
    const harness = createSessionControllerHarness({ messages: async () => request.promise })
    const service = createSessionMessagesService(harness.deps)
    const loading = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    const current = message("message", 2)
    harness.child[1]("message", "session", [current])
    harness.child[1]("part", "message", [part("hello world")])
    service.event("/project", "session", "merge")
    request.resolve(response([message("message", 1)], [part("hello")]))
    expect((await loading).committed).toBe(true)
    expect(service.get("/project", "session")).toEqual([current])
    expect(service.parts("/project", "message")?.[0]).toMatchObject({ text: "hello world" })
  })

  test("discards HTTP snapshot after an authoritative removal event", async () => {
    const request = deferred<ReturnType<typeof response>>()
    const harness = createSessionControllerHarness({ messages: async () => request.promise })
    const service = createSessionMessagesService(harness.deps)
    const loading = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    harness.child[1]("message", "session", [])
    service.event("/project", "session", "discard")
    request.resolve(response([message("removed")]))
    expect((await loading).committed).toBe(false)
    expect(service.get("/project", "session")).toEqual([])
  })

  test("clears a confirmed optimistic item before the next snapshot", async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
    let calls = 0
    const optimistic = message("optimistic")
    const harness = createSessionControllerHarness({
      messages: async () => (++calls === 1 ? first.promise : second.promise),
    })
    const service = createSessionMessagesService(harness.deps)
    service.optimistic.add("/project", { sessionID: "session", message: optimistic, parts: [] })
    const confirm = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    first.resolve(response([optimistic]))
    await confirm
    expect(service.get("/project", "session")).toEqual([optimistic])

    const refresh = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    second.resolve(response([]))
    await refresh
    expect(service.get("/project", "session")).toEqual([])
  })

  test("does not commit after directory reset", async () => {
    const request = deferred<ReturnType<typeof response>>()
    const harness = createSessionControllerHarness({ messages: async () => request.promise })
    const service = createSessionMessagesService(harness.deps)
    const loading = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    harness.reset()
    service.clearDirectory("/project")
    request.resolve(response([message("stale")]))
    await expect(loading).rejects.toMatchObject({ name: "AbortError" })
    expect(service.get("/project", "session")).toBeUndefined()
  })

  test("stale load cleanup does not delete the replacement inflight", async () => {
    const first = deferred<ReturnType<typeof response>>()
    const second = deferred<ReturnType<typeof response>>()
    let calls = 0
    const harness = createSessionControllerHarness({
      messages: async () => (++calls === 1 ? first.promise : second.promise),
    })
    const service = createSessionMessagesService(harness.deps)
    const stale = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    harness.reset()
    service.clearDirectory("/project")
    const fresh = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    first.resolve(response([message("stale")]))
    await expect(stale).rejects.toMatchObject({ name: "AbortError" })
    const joined = service.load({ directory: "/project", sessionID: "session", limit: 80 })
    expect(calls).toBe(2)
    expect(joined).toBe(fresh)
    second.resolve(response([message("fresh")]))
    await Promise.all([fresh, joined])
    expect(service.get("/project", "session")?.map((item) => item.id)).toEqual(["fresh"])
    expect(service.inspect().inflight).toBe(0)
    expect(service.inspect().loading).toBe(0)
  })

  test("session clear removes settled revision and loading keys", () => {
    const harness = createSessionControllerHarness()
    const service = createSessionMessagesService(harness.deps)
    service.event("/project", "session", "discard")
    service.optimistic.add("/project", { sessionID: "session", message: message("optimistic"), parts: [] })
    service.clear("/project", ["session"])
    expect(service.inspect()).toEqual({
      revision: 0,
      discardRevision: 0,
      generation: 0,
      pageInflight: 0,
      inflight: 0,
      optimistic: 0,
      loading: 0,
    })
  })
})
