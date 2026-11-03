import { describe, expect } from "bun:test"
import path from "node:path"
import { symlink } from "node:fs/promises"
import { Effect } from "effect"
import { sessionContextRules } from "@opencode-ai/core/session-context-access"
import { Session } from "@/session/session"
import { containsRealPath, readRules } from "@/session/context-access"
import { Permission } from "@/permission"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const reader = yield* sessions.create({ title: "Assistant" })
  const directory = yield* tmpdirScoped()
  const source = yield* provideInstance(directory)(sessions.create({ title: "Source" }))
  const filepath = path.join(directory, "file.txt")
  yield* Effect.promise(() => Bun.write(filepath, "project content"))
  const request = {
    permission: "external_directory",
    patterns: [path.join(directory, "*")],
    always: [path.join(directory, "*")],
    metadata: { filepath },
  }
  const check = (tool = "read", req = request, rules: Permission.Ruleset = []) =>
    Effect.gen(function* () {
      const current = yield* sessions.get(reader.id)
      return yield* readRules({ tool, request: req, rules, session: current, getSession: sessions.get })
    })
  const grant = (readFiles: boolean) =>
    sessions.setPermission({
      sessionID: reader.id,
      permission: sessionContextRules([], [{ sessionID: source.id, readFiles }]),
    })
  return { sessions, reader, source, directory, filepath, request, check, grant }
})

describe("linked project read authorization", () => {
  it.instance("requires opt-in and authorizes only built-in read tools", () =>
    Effect.gen(function* () {
      const { check, grant } = yield* setup
      expect(yield* check()).toEqual([])
      yield* grant(false)
      expect(yield* check()).toEqual([])
      yield* grant(true)
      for (const tool of ["read", "glob", "grep"]) expect(yield* check(tool)).toHaveLength(1)
      for (const tool of ["edit", "write", "apply_patch", "bash", "task", "custom_read"]) {
        expect(yield* check(tool)).toEqual([])
      }
    }),
  )

  it.instance("does not bypass explicit directory denies or file/tool policy", () =>
    Effect.gen(function* () {
      const { check, grant, request } = yield* setup
      yield* grant(true)
      expect(
        yield* check("read", request, [{ permission: "external_directory", pattern: "*", action: "deny" }]),
      ).toEqual([])
      expect(yield* check("read", { ...request, permission: "read" })).toEqual([])
      expect(yield* check("grep", { ...request, permission: "grep" })).toEqual([])
    }),
  )

  it.instance("rejects sibling paths and symlinks escaping the associated project", () =>
    Effect.gen(function* () {
      const { directory, filepath, request, check, grant } = yield* setup
      yield* grant(true)
      const outside = yield* tmpdirScoped()
      const secret = path.join(outside, "secret.txt")
      yield* Effect.promise(() => Bun.write(secret, "not authorized"))
      const link = path.join(directory, "escape.txt")
      yield* Effect.promise(() => symlink(secret, link))
      expect(containsRealPath(directory, filepath)).toBe(true)
      expect(containsRealPath(directory, `${directory}-sibling/file.txt`)).toBe(false)
      for (const target of [secret, link, path.join(directory, "missing")]) {
        expect(yield* check("read", { ...request, metadata: { filepath: target } })).toEqual([])
      }
    }),
  )

  it.instance("isolates assistants, forks and children, and immediately observes revocation", () =>
    Effect.gen(function* () {
      const { sessions, reader, request, check, grant } = yield* setup
      yield* grant(true)
      expect(yield* check()).toHaveLength(1)
      for (const other of [
        yield* sessions.create({ title: "Other assistant" }),
        yield* sessions.create({ parentID: reader.id, title: "Child" }),
        yield* sessions.fork({ sessionID: reader.id }),
      ]) {
        expect(
          yield* readRules({ tool: "read", request, rules: [], session: other, getSession: sessions.get }),
        ).toEqual([])
      }
      yield* grant(false)
      expect(yield* check()).toEqual([])
    }),
  )

  it.instance("fails closed when the linked session has been deleted", () =>
    Effect.gen(function* () {
      const { sessions, source, grant, check } = yield* setup
      yield* grant(true)
      yield* sessions.remove(source.id)
      expect(yield* check()).toEqual([])
    }),
  )
})
