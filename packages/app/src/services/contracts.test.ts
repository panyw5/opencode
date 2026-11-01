import { describe, expect, test } from "bun:test"
import type { LogicalPath } from "@opencode-ai/core/util/path"
import {
  authorityKey,
  draftKey,
  effectiveCapabilities,
  sessionKey,
  workspaceKey,
  type RuntimeScope,
  type WorkspaceID,
  type WorkspaceRef,
} from "./contracts"
import { deferredPort, legacyRuntimeFixture } from "./test-utils/runtime-fixtures"

const scope = (url: string): RuntimeScope => ({
  authority: authorityKey({ kind: "http", url }),
  domain: "main",
  generation: 0,
})
const workspace = (scope: RuntimeScope, directory: string): WorkspaceRef => ({
  authority: scope.authority,
  id: directory as WorkspaceID,
  kind: "filesystem",
  directory: directory as LogicalPath,
  filesystem: "posix",
})

describe("runtime contracts", () => {
  test("isolates identical directories, sessions and drafts on unmanaged loopback endpoints", () => {
    const fixture = legacyRuntimeFixture()
    const [a, b] = fixture.backends.map((backend) => scope(backend.url))
    const first = workspace(a, fixture.canonical)
    const second = workspace(b, fixture.canonical)
    expect(a.authority).not.toBe(b.authority)
    expect(sessionKey(a, fixture.sessionID)).not.toBe(sessionKey(b, fixture.sessionID))
    expect(workspaceKey(a, first)).not.toBe(workspaceKey(b, second))
    expect(draftKey(a, first, fixture.draftID)).not.toBe(draftKey(b, second, fixture.draftID))
  })

  test("session identity survives directory metadata repair and connection generations", () => {
    const fixture = legacyRuntimeFixture()
    const a = scope(fixture.backends[0].url)
    const repaired = { ...a, generation: 3 }
    expect(sessionKey(a, fixture.sessionID)).toBe(sessionKey(repaired, fixture.sessionID))
    expect(workspaceKey(a, workspace(a, fixture.canonical))).toBe(
      workspaceKey(repaired, workspace(repaired, fixture.canonical)),
    )
    expect(sessionKey(a, fixture.sessionID)).not.toContain(fixture.canonical)
    expect(sessionKey(a, fixture.sessionID)).not.toContain(fixture.legacy)
    expect(sessionKey(a, fixture.sessionID)).not.toBe(sessionKey({ ...a, domain: "extra-agent" }, fixture.sessionID))
  })

  test("scopes managed authorities to profile and saved connection, not endpoint ports", () => {
    const a = authorityKey({ kind: "sidecar", profile: "dev", connection: "main" })
    expect(a).toBe(authorityKey({ kind: "sidecar", profile: "dev", connection: "main" }))
    expect(a).not.toBe(authorityKey({ kind: "sidecar", profile: "installed", connection: "main" }))
    expect(a).not.toBe(authorityKey({ kind: "http", url: "http://localhost:4096" }))
    expect(authorityKey({ kind: "ssh", profile: "dev", connection: "alice@host" })).not.toBe(
      authorityKey({ kind: "ssh", profile: "dev", connection: "bob@host" }),
    )
    expect(authorityKey({ kind: "wsl", profile: "dev", distro: "Ubuntu" })).not.toBe(
      authorityKey({ kind: "wsl", profile: "dev", distro: "Debian" }),
    )
  })

  test("HTTP authorities omit credentials and request parameters but retain endpoint paths", () => {
    const a = authorityKey({ kind: "http", url: "https://alice:secret@HOST:443/api/?token=secret#secret" })
    expect(a).toBe(authorityKey({ kind: "http", url: "https://host/api" }))
    expect(a).not.toContain("secret")
    expect(a).not.toContain("alice")
    expect(a).not.toBe(authorityKey({ kind: "http", url: "https://host/other" }))
    expect(() => authorityKey({ kind: "http", url: "file:///tmp" })).toThrow("HTTP(S)")
    expect(() => authorityKey({ kind: "http", url: "invalid-secret" })).toThrow("valid endpoint")
    expect(() => authorityKey({ kind: "sidecar", profile: "", connection: "main" })).toThrow("profile")
  })

  test("composite keys cannot collide through delimiters and reject another authority's workspace", () => {
    const a = scope("https://host")
    expect(sessionKey({ ...a, domain: "a:b" }, "c")).not.toBe(sessionKey({ ...a, domain: "a" }, "b:c"))
    expect(() => workspaceKey(scope("https://other"), workspace(a, "/repo"))).toThrow("another authority")
    expect(workspaceKey(a, workspace(a, "/repo"))).not.toBe(workspaceKey(a, workspace(a, "/repo/child")))
  })

  test("capabilities require every dimension and retain the explicit denial reason", () => {
    expect(effectiveCapabilities()["host.admin"]).toEqual({ supported: false, reason: "unsupported" })
    expect(effectiveCapabilities({ "session.send": { supported: true } }, {})["session.send"]).toEqual({
      supported: false,
      reason: "unsupported",
    })
    const result = effectiveCapabilities(
      { "session.send": { supported: true }, "host.admin": { supported: true } },
      { "session.send": { supported: true }, "host.admin": { supported: false, reason: "forbidden" } },
    )
    expect(result["session.send"]).toEqual({ supported: true })
    expect(result["host.admin"]).toEqual({ supported: false, reason: "forbidden" })
    expect(result["host.restart"]).toEqual({ supported: false, reason: "unsupported" })
  })
})

describe("P0 synthetic regression ports", () => {
  test("preserves conflicting alias preferences, draft content/context and distinct parent projects", () => {
    const fixture = legacyRuntimeFixture()
    expect(fixture.server.projects.local.map((item) => item.worktree)).toEqual([
      fixture.legacy,
      fixture.canonical,
      fixture.parent,
    ])
    expect(fixture.preferences[fixture.legacy]).not.toEqual(fixture.preferences[fixture.canonical])
    expect(fixture.layout.sessionBar.drafts[0].id).toBe(fixture.prompt.id)
    expect(fixture.prompt.prompt[0].content).toBe("Unsent synthetic draft")
    expect(fixture.prompt.context.items).toHaveLength(1)
    fixture.server.projects.local.splice(0)
    expect(legacyRuntimeFixture().server.projects.local).toHaveLength(3)
  })

  test("can deterministically release bootstrap, resolution and session-list work out of order", async () => {
    const port = deferredPort<string, string>()
    const committed: string[] = []
    const restore = port.run("restore-A").then((value) => committed.push(value))
    const select = port.run("select-B").then((value) => committed.push(value))
    const failing = port.run("unavailable-host")
    port.calls[1].resolve("B")
    await select
    expect(committed).toEqual(["B"])
    port.calls[0].resolve("A")
    await restore
    expect(committed).toEqual(["B", "A"])
    port.calls[2].reject(new Error("unavailable"))
    await expect(failing).rejects.toThrow("unavailable")
  })
})
