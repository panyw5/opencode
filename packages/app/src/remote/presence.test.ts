import { describe, expect, test } from "bun:test"
import { createRemotePresenceReporter, remotePageForPath } from "./presence"
import type { RemotePage } from "./types"

describe("remote browser presence", () => {
  test("reports page metadata, never full directory paths, query strings or fragments", () => {
    const dir = Buffer.from("/private/home/user/sample").toString("base64url")
    expect(remotePageForPath(`/${dir}/session/ses_example?auth_token=secret#content`)).toEqual({
      kind: "session",
      project: "sample",
      sessionID: "ses_example",
    })
    expect(remotePageForPath("/")).toEqual({ kind: "home" })
    expect(remotePageForPath("/config")).toEqual({ kind: "config" })
    expect(remotePageForPath("/scheduled")).toEqual({ kind: "scheduled-tasks" })
    expect(remotePageForPath(`/${dir}/session`)).toEqual({ kind: "session", project: "sample" })
  })

  test("deduplicates page reports but sends heartbeats, navigation and visibility changes", async () => {
    let now = 0
    let page: RemotePage = { kind: "home" }
    let visible = true
    const sent: Array<{ sequence: number; clientID: string; closed?: boolean }> = []
    const reporter = createRemotePresenceReporter({
      now: () => now,
      readPage: () => page,
      visible: () => visible,
      fetcher: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)))
        return new Response("{}")
      },
    })
    await reporter.update()
    now = 5_000
    await reporter.update()
    expect(sent.length).toBe(1)
    now = 20_000
    await reporter.update()
    page = { kind: "session", sessionID: "ses_one" }
    await reporter.update()
    visible = false
    await reporter.update()
    await reporter.close()
    expect(sent.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(sent.at(-1)?.closed).toBe(true)
    expect(new Set(sent.map((p) => p.clientID)).size).toBe(1)
    reporter.dispose()
    await reporter.update()
    expect(sent.length).toBe(5)
  })

  test("retries failed heartbeats instead of treating an error as an active connection", async () => {
    let calls = 0
    const reporter = createRemotePresenceReporter({
      readPage: () => ({ kind: "home" }),
      visible: () => true,
      fetcher: async () => new Response("{}", { status: ++calls === 1 ? 503 : 200 }),
    })
    await reporter.update()
    await reporter.update()
    await reporter.update()
    expect(calls).toBe(2)
    reporter.dispose()
  })
})
