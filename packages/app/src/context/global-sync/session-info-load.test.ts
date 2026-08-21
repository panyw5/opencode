import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { clearSessionInfoLoads, loadSessionInfo, resolveSessionInfoCommit } from "./session-info-load"

const session = (id: string): Session =>
  ({
    id,
    projectID: "project",
    directory: "/project",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  }) as Session

describe("loadSessionInfo", () => {
  test("shares one inflight request for the same directory and session", async () => {
    let resolve!: (value: Session) => void
    let calls = 0
    const load = () => {
      calls += 1
      return new Promise<Session>((done) => {
        resolve = done
      })
    }

    const first = loadSessionInfo({ directory: "/project", sessionID: "child", load })
    const second = loadSessionInfo({ directory: "/project", sessionID: "child", load })
    expect(first).toBe(second)
    expect(calls).toBe(1)

    resolve(session("child"))
    expect(await first).toMatchObject({ id: "child" })
    expect(await second).toMatchObject({ id: "child" })
  })

  test("starts a new request after the previous request settles", async () => {
    let calls = 0
    const load = async () => {
      calls += 1
      return session("child")
    }

    await loadSessionInfo({ directory: "/project", sessionID: "child-after-settle", load })
    await loadSessionInfo({ directory: "/project", sessionID: "child-after-settle", load })
    expect(calls).toBe(2)
  })

  test("discards an old response after its domain is reset", async () => {
    let resolve!: (value: Session) => void
    const stale = loadSessionInfo({
      directory: "/project",
      sessionID: "child-before-reset",
      load: () => new Promise<Session>((done) => (resolve = done)),
    })

    clearSessionInfoLoads("opencode")
    resolve(session("child-before-reset"))
    expect(await stale).toBeUndefined()

    const fresh = await loadSessionInfo({
      directory: "/project",
      sessionID: "child-before-reset",
      load: async () => session("child-before-reset"),
    })
    expect(fresh).toMatchObject({ id: "child-before-reset" })
  })

  test("keeps newer store info when an older response arrives", () => {
    const current = { ...session("child"), title: "new", time: { created: 1, updated: 3 } }
    const incoming = { ...session("child"), title: "old", time: { created: 1, updated: 2 } }
    expect(resolveSessionInfoCommit(current, incoming)).toBe(current)
  })

  test("accepts a newer response", () => {
    const current = { ...session("child"), title: "old", time: { created: 1, updated: 2 } }
    const incoming = { ...session("child"), title: "new", time: { created: 1, updated: 3 } }
    expect(resolveSessionInfoCommit(current, incoming)).toBe(incoming)
  })

  test("accepts an equal-timestamp refresh", () => {
    const current = { ...session("child"), title: "old", time: { created: 1, updated: 2 } }
    const incoming = { ...session("child"), title: "new", time: { created: 1, updated: 2 } }
    expect(resolveSessionInfoCommit(current, incoming)).toBe(incoming)
  })
})
