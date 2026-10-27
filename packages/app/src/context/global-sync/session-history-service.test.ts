import { describe, expect, test } from "bun:test"
import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { createSessionService } from "./session-service"
import { createSessionControllerHarness, deferred, sessionInfo } from "./session-service-test-utils"

const notFound = { name: "NotFoundError", data: { message: "missing" } }
const user = (id: string) => ({ id, sessionID: "session", role: "user", time: { created: 1 } }) as Message

function setup() {
  let server = sessionInfo()
  const calls: string[] = []
  const harness = createSessionControllerHarness({
    abort: async () => {
      calls.push("abort")
      return { data: true }
    },
    revert: async ({ messageID }) => {
      calls.push(`revert:${messageID}`)
      server = { ...server, time: { ...server.time, updated: server.time.updated + 1 }, revert: { messageID } }
      return { data: server }
    },
    unrevert: async () => {
      calls.push("unrevert")
      server = { ...server, time: { ...server.time, updated: server.time.updated + 1 }, revert: undefined }
      return { data: server }
    },
    get: async () => {
      calls.push("get")
      return { data: server }
    },
  })
  harness.child[1]("session", [server])
  const controller = createSessionService(harness.deps)
  const service = controller.api
  return {
    ...harness,
    service,
    controller,
    calls,
    setServer: (session: Session) => {
      server = session
    },
  }
}

describe("session history controller", () => {
  test("a 404 from abort is not mistaken for proof that the target message is missing", async () => {
    const h = setup()
    h.service.messages.optimistic.add("/project", { sessionID: "session", message: user("target"), parts: [] })
    h.session.abort = async () => {
      throw notFound
    }
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "target" })).rejects.toBe(
      notFound,
    )
    expect(h.service.messages.optimistic.has("/project", "session", "target")).toBe(true)
    expect(h.calls).not.toContain("revert:target")
  })

  test("a concurrent event invalidating the first snapshot is retried before confirming success", async () => {
    const h = setup()
    let calls = 0
    h.session.messages = async () => {
      if (++calls === 1) h.controller.event("/project", { sessionID: "session", kind: "messages", strategy: "discard" })
      return { data: [], response: { headers: { get: () => null } } }
    }
    expect(
      (await h.service.history.change("/project", { sessionID: "session", messageID: "target" })).revert?.messageID,
    ).toBe("target")
    expect(calls).toBe(2)
    expect(h.service.history.operation("/project", "session")).toBeUndefined()
  })

  test("deduplicates all entry points and never writes an optimistic boundary", async () => {
    const h = setup()
    const stop = deferred<{ data: boolean }>()
    h.session.abort = () => stop.promise
    const first = h.service.history.change("/project", { sessionID: "session", messageID: "target" })
    expect(h.service.history.change("/project", { sessionID: "session", messageID: "target" })).toBe(first)
    expect(h.service.history.pending("/project", "session")).toBe(true)
    expect(h.service.info.get("/project", "session")?.revert).toBeUndefined()
    await expect(h.service.history.change("/project", { sessionID: "session" })).rejects.toThrow("in progress")
    await expect(h.service.history.send("/project", "session", async () => true)).rejects.toThrow("before sending")
    stop.resolve({ data: true })
    expect((await first).revert?.messageID).toBe("target")
    expect(h.service.info.get("/project", "session")?.revert?.messageID).toBe("target")
    expect(h.service.history.pending("/project", "session")).toBe(false)
    expect(h.pins).toBe(0)
  })

  test("stops an in-flight command, waits for dispatch, then fences late preparation again", async () => {
    const h = setup()
    const started = deferred<void>()
    const command = deferred<boolean>()
    h.session.abort = async () => {
      h.calls.push("abort")
      command.resolve(true)
      return { data: true }
    }
    const sending = h.service.history.send("/project", "session", () => {
      started.resolve()
      return command.promise
    })
    await started.promise
    await h.service.history.change("/project", { sessionID: "session", messageID: "target" })
    await sending
    expect(h.calls.slice(0, 3)).toEqual(["abort", "abort", "revert:target"])
  })

  test("removes only a boundary explicitly confirmed missing, preserving other pending sends", async () => {
    const h = setup()
    h.session.revert = async () => {
      throw notFound
    }
    for (const id of ["ghost", "pending"])
      h.service.messages.optimistic.add("/project", { sessionID: "session", message: user(id), parts: [] })
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "ghost" })).rejects.toBe(
      notFound,
    )
    expect(h.service.messages.get("/project", "session")?.map((message) => message.id)).toEqual(["pending"])
    expect(h.service.messages.optimistic.has("/project", "session", "ghost")).toBe(false)
    expect(h.service.history.operation("/project", "session")).toBeUndefined()
  })

  test("an invalid success response does not imply the target message is missing", async () => {
    const h = setup()
    h.service.messages.optimistic.add("/project", { sessionID: "session", message: user("target"), parts: [] })
    h.session.revert = async () => ({ data: sessionInfo() })
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "target" })).rejects.toThrow(
      "did not confirm",
    )
    expect(h.service.messages.optimistic.has("/project", "session", "target")).toBe(true)
  })

  test("legacy false success is verified with a message lookup before removing a ghost", async () => {
    const h = setup()
    h.service.messages.optimistic.add("/project", { sessionID: "session", message: user("ghost"), parts: [] })
    h.session.revert = async () => ({ data: sessionInfo() })
    const wrapped = new Error("Message not found", { cause: { status: 404, body: notFound } })
    h.session.message = async () => {
      throw wrapped
    }
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "ghost" })).rejects.toBe(
      wrapped,
    )
    expect(h.service.messages.get("/project", "session")).toEqual([])
  })

  test("a lost response reconciles the committed backend state instead of rolling back locally", async () => {
    const h = setup()
    h.session.revert = async () => {
      h.setServer({ ...sessionInfo("session", 2), revert: { messageID: "target" } })
      throw new Error("response lost")
    }
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "target" })).rejects.toThrow(
      "response lost",
    )
    expect(h.service.info.get("/project", "session")?.revert?.messageID).toBe("target")
    expect(h.service.history.operation("/project", "session")).toBeUndefined()
  })

  test("failed reconciliation fences future sends until an authoritative refresh succeeds", async () => {
    const h = setup()
    h.session.revert = async () => {
      throw new Error("offline")
    }
    h.session.get = async () => {
      throw new Error("offline")
    }
    await expect(h.service.history.change("/project", { sessionID: "session", messageID: "target" })).rejects.toThrow(
      "offline",
    )
    expect(h.service.history.operation("/project", "session")?.phase).toBe("uncertain")
    let sent = false
    await expect(
      h.service.history.send("/project", "session", async () => {
        sent = true
      }),
    ).rejects.toThrow("offline")
    expect(sent).toBe(false)
    h.session.get = async () => ({ data: sessionInfo() })
    await h.service.history.send("/project", "session", async () => {
      sent = true
    })
    expect(sent).toBe(true)
  })

  test("restoration uses the same confirmed state flow", async () => {
    const h = setup()
    await h.service.history.change("/project", { sessionID: "session", messageID: "target" })
    expect((await h.service.history.change("/project", { sessionID: "session" })).revert).toBeUndefined()
    expect(h.service.info.get("/project", "session")?.revert).toBeUndefined()
  })

  test("backend reset discards a late response without mutating the new store", async () => {
    const h = setup()
    const result = deferred<{ data: Session }>()
    const requested = deferred<void>()
    h.session.revert = () => {
      requested.resolve()
      return result.promise
    }
    const pending = h.service.history.change("/project", { sessionID: "session", messageID: "target" })
    await requested.promise
    h.service.clear("/project", ["session"])
    h.reset()
    result.resolve({ data: { ...sessionInfo(), revert: { messageID: "target" } } })
    await expect(pending).rejects.toThrow("previous backend")
    expect(h.service.info.get("/project", "session")).toBeUndefined()
    expect(h.pins).toBe(0)
  })
})
