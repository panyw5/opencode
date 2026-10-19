import { describe, expect, test } from "bun:test"
import { RemotePresence, PRESENCE_TTL_MS } from "./presence"

const visit = (input: Record<string, unknown> = {}) => ({
  clientID: "browser-tab-000001",
  sequence: 1,
  visible: true,
  page: { kind: "session", project: "sample", sessionID: "ses_example" },
  ...input,
})

describe("remote page presence leases", () => {
  test("distinguishes unknown, foreground, background and expired pages without changing auth", () => {
    let now = 1_000
    const presence = new RemotePresence(() => now)
    expect(presence.connection("device").state).toBe("unknown")
    expect(presence.update("device", visit())).toBe(true)
    expect(presence.connection("device").state).toBe("active")
    now += 1_000
    expect(presence.update("device", visit({ sequence: 2, visible: false }))).toBe(true)
    expect(presence.connection("device").state).toBe("background")
    now += PRESENCE_TTL_MS
    expect(presence.connection("device")).toEqual({ state: "offline", lastActivityAt: 2_000, pages: [] })
  })

  test("keeps tabs separate, updates SPA pages, and closes only the selected tab", () => {
    const presence = new RemotePresence(() => 1_000)
    presence.update("one", visit())
    presence.update("one", visit({ clientID: "browser-tab-000002", visible: false, page: { kind: "home" } }))
    presence.update("two", visit())
    presence.update("one", visit({ sequence: 2, page: { kind: "project-tasks", project: "sample" } }))
    expect(presence.connection("one").pages.map((p) => p.kind)).toEqual(["project-tasks", "home"])
    presence.update("one", visit({ sequence: 3, closed: true }))
    expect(presence.connection("one").state).toBe("background")
    expect(presence.connection("two").state).toBe("active")
    presence.retain(["two"])
    expect(presence.connection("one").state).toBe("unknown")
    presence.remove("one")
    expect(presence.connection("one").state).toBe("unknown")
    presence.clear()
    expect(presence.connection("two").state).toBe("unknown")
  })

  test("late or duplicate requests cannot revive a closed tab", () => {
    const presence = new RemotePresence()
    presence.update("device", visit({ sequence: 2, closed: true }))
    presence.update("device", visit({ sequence: 1 }))
    expect(presence.connection("device").state).toBe("offline")
    presence.update("device", visit({ sequence: 3 }))
    presence.update("device", visit({ sequence: 2, closed: true }))
    expect(presence.connection("device").state).toBe("active")
  })

  test("bounds tabs, validates metadata and drops unrecognized fields", () => {
    const presence = new RemotePresence()
    expect(presence.update("device", visit({ sequence: -1 }))).toBe(false)
    expect(presence.update("device", visit({ page: { kind: "invalid" } }))).toBe(false)
    expect(presence.update("device", visit({ page: { kind: "session", sessionID: "../../secret" } }))).toBe(false)
    expect(presence.update("device", visit({ page: { kind: "session", project: "bad\nname" } }))).toBe(false)
    for (let i = 0; i < 8; i++)
      expect(presence.update("device", visit({ clientID: `browser-tab-${String(i).padStart(6, "0")}` }))).toBe(true)
    expect(presence.update("device", visit({ clientID: "browser-tab-extra" }))).toBe(false)
    const clean = new RemotePresence()
    clean.update("device", visit({ page: { kind: "home", token: "secret", title: "message contents" } }))
    expect(JSON.stringify(clean.connection("device"))).not.toMatch(/secret|contents|sequence|closed/)
  })
})
