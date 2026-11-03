import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "../src/permission"
import {
  linkedSessionIDs,
  projectReadAllowed,
  sessionContextRules,
  PROJECT_READ_PERMISSION,
} from "../src/session-context-access"

describe("session context access", () => {
  test("evaluates renderer-side grants without Node globals", () => {
    const original = globalThis.process
    try {
      Reflect.set(globalThis, "process", undefined)
      const rules = sessionContextRules([], [{ sessionID: "ses_source", readFiles: true }])
      expect(linkedSessionIDs(rules)).toEqual(["ses_source"])
      expect(projectReadAllowed(rules, "ses_source")).toBe(true)
    } finally {
      Reflect.set(globalThis, "process", original)
    }
  })

  test("links only exact session IDs and does not grant file access by default", () => {
    const rules = sessionContextRules([], [{ sessionID: "ses_source", readFiles: false }])
    expect(linkedSessionIDs(rules)).toEqual(["ses_source"])
    expect(projectReadAllowed(rules, "ses_source")).toBe(false)
    expect(PermissionV2.evaluate("session_transcript", "ses_source", rules).action).toBe("allow")
    expect(PermissionV2.evaluate("session_transcript", "ses_other", rules).action).toBe("ask")
    expect(PermissionV2.evaluate("external_directory", "/project/*", rules).action).toBe("ask")
    expect(PermissionV2.evaluate("edit", "file", rules).action).toBe("ask")
    expect(PermissionV2.evaluate("bash", "cat file", rules).action).toBe("ask")
  })

  test("preserves previous links and supports revoking project access", () => {
    const first = sessionContextRules([], [{ sessionID: "ses_first", readFiles: true }])
    const second = [...first, ...sessionContextRules(first, [{ sessionID: "ses_second", readFiles: false }])]
    expect(linkedSessionIDs(second)).toEqual(["ses_first", "ses_second"])
    expect(projectReadAllowed(second, "ses_first")).toBe(true)
    const revoked = [...second, ...sessionContextRules(second, [{ sessionID: "ses_first", readFiles: false }])]
    expect(projectReadAllowed(revoked, "ses_first")).toBe(false)
    expect(linkedSessionIDs(revoked)).toEqual(["ses_first", "ses_second"])
    expect(sessionContextRules(revoked, [{ sessionID: "ses_first", readFiles: false }])).toEqual([])
  })

  test("wildcards, paths, ordinary text and unlinked file markers cannot authorize a project", () => {
    const rules: PermissionV2.Ruleset = [
      { permission: "session_transcript", pattern: "*", action: "allow" },
      { permission: "session_transcript", pattern: "/some/path", action: "allow" },
      { permission: PROJECT_READ_PERMISSION, pattern: "*", action: "allow" },
      { permission: PROJECT_READ_PERMISSION, pattern: "ses_source", action: "allow" },
    ]
    expect(linkedSessionIDs(rules)).toEqual([])
    expect(projectReadAllowed(rules, "ses_source")).toBe(false)
    const linked = sessionContextRules([], [{ sessionID: "ses_source", readFiles: true }])
    expect(
      projectReadAllowed([...linked, { permission: "session_transcript", pattern: "*", action: "deny" }], "ses_source"),
    ).toBe(false)
  })
})
