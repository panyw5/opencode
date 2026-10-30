import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "@/storage/db"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { CodeModeCatalog } from "@/session/code-mode-catalog"
import { CodeModeState } from "@/session/code-mode-state"
import { CodeModeInstructionTable } from "@/session/code-mode-state.sql"
import { SessionCodeMode } from "@/session/code-mode"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionRevert.defaultLayer))
const catalog = (...names: string[]) =>
  CodeModeCatalog.summarize({
    tools: names.map((name) => ({
      type: "tool",
      name: `demo.${name}`,
      description: `Tool ${name}`,
      signature: `tools.demo.${name}({}): Promise<string>`,
    })),
  })
const rows = (sessionID: SessionID) =>
  Database.use((db) =>
    db.select().from(CodeModeInstructionTable).where(eq(CodeModeInstructionTable.session_id, sessionID)).all(),
  )
const fixture = Effect.fn("CodeModeStateTest.fixture")(function* (initialTime = Date.now()) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  let clock = initialTime
  const user = (sessionID = session.id) =>
    sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: ++clock },
    })
  const firstUser = yield* user()
  const assistant = (sessionID = session.id, parentID = firstUser.id, extra: Partial<MessageV2.Assistant> = {}) =>
    sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      parentID,
      role: "assistant",
      agent: "build",
      mode: "build",
      time: { created: ++clock, completed: clock },
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      ...extra,
    } as MessageV2.Assistant)
  const prepare = Effect.fn("CodeModeStateTest.prepare")(function* (
    next?: CodeModeCatalog.Summary,
    message?: MessageV2.Info,
  ) {
    const anchor = message ?? (yield* assistant())
    const messages = (yield* sessions.messages({ sessionID: session.id })).filter(
      (message) => message.info.id !== anchor.id,
    )
    return yield* CodeModeState.prepare({
      sessionID: session.id,
      messageID: anchor.id,
      user: firstUser,
      messages,
      catalog: next,
    })
  })
  return { sessions, session, firstUser, user, assistant, prepare }
})

it.instance("Code Mode description stays invariant while the separate catalog changes", () =>
  Effect.gen(function* () {
    const a = SessionCodeMode.make([
      { key: "a", server: "one", name: "a", description: "A", schema: { type: "object" } },
    ])
    const b = SessionCodeMode.make([
      { key: "b", server: "two", name: "b", description: "B", schema: { type: "object" } },
    ])
    expect(a.description).toBe(b.description)
    expect(a.description).not.toContain("tools.one.a")
    expect(a.summary.namespaces[0].name).toBe("one")
    expect(b.summary.namespaces[0].name).toBe("two")
  }),
)

it.instance("initial snapshot is durable, unchanged catalogs do not append updates, retries are idempotent", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const first = yield* f.prepare(catalog("echo"))
    expect(first.system).toContain("tools.demo.echo")
    expect(rows(f.session.id)).toHaveLength(1)
    const anchor = yield* f.assistant()
    const again = yield* f.prepare(catalog("echo"), anchor)
    expect(again.system).toBe(first.system)
    expect(again.messages.some((message) => message.parts.some((part) => part.type === "text" && part.synthetic))).toBe(
      false,
    )
    expect(rows(f.session.id)).toHaveLength(1)
    const change = yield* f.assistant()
    const updated = yield* f.prepare(catalog("echo", "lookup"), change)
    const retry = yield* f.prepare(catalog("echo", "lookup"), change)
    expect(retry).toEqual(updated)
    expect(rows(f.session.id)).toHaveLength(2)
    expect(rows(f.session.id)[1].kind).toBe("update")
  }),
)

it.instance("catalog deltas replay before their assistant anchor without changing the baseline or persisted chat", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const first = yield* f.prepare(catalog("echo"))
    const anchor = yield* f.assistant()
    const changed = yield* f.prepare(catalog("echo", "lookup"), anchor)
    expect(changed.system).toBe(first.system)
    expect(JSON.stringify(changed.messages)).toContain("New tools are available")
    const replay = yield* f.prepare(catalog("echo", "lookup"))
    const index = replay.messages.findIndex((message) => message.info.id === anchor.id)
    expect(replay.messages[index - 1].info.role).toBe("user")
    expect(JSON.stringify(replay.messages[index - 1])).toContain("tools.demo.lookup")
    expect((yield* f.sessions.messages({ sessionID: f.session.id })).flatMap((message) => message.parts)).toHaveLength(
      0,
    )
  }),
)

it.instance("removal and reenabling produce updates while never-enabled sessions stay untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    expect((yield* f.prepare()).system).toBeUndefined()
    expect(rows(f.session.id)).toHaveLength(0)
    const first = yield* f.prepare(catalog("echo"))
    const removed = yield* f.prepare()
    expect(removed.system).toBe(first.system)
    expect(JSON.stringify(removed.messages)).toContain("No Code Mode tools are currently available")
    const restored = yield* f.prepare(catalog("echo"))
    expect(restored.system).toBe(first.system)
    expect(rows(f.session.id)).toHaveLength(3)
  }),
)

it.instance("canonical catalog order avoids churn and immutable anchors reject a changed retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const anchor = yield* f.assistant()
    yield* f.prepare(catalog("a", "z"), anchor)
    yield* f.prepare(catalog("z", "a"))
    expect(rows(f.session.id)).toHaveLength(1)
    expect((yield* f.prepare(catalog("different"), anchor).pipe(Effect.exit))._tag).toBe("Failure")
    expect(rows(f.session.id)).toHaveLength(1)
  }),
)

it.instance("fork copies only snapshots within its copied message boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const first = yield* f.prepare(catalog("echo"))
    const boundary = yield* f.user()
    yield* f.prepare(catalog("echo", "later"))
    const fork = yield* f.sessions.fork({ sessionID: f.session.id, messageID: boundary.id })
    expect(rows(fork.id)).toHaveLength(1)
    expect(rows(fork.id)[0].message_id).not.toBe(rows(f.session.id)[0].message_id)
    const user = (yield* f.sessions.messages({ sessionID: fork.id })).find((message) => message.info.role === "user")!
      .info as MessageV2.User
    const anchor = yield* f.assistant(fork.id, user.id)
    const prepared = yield* CodeModeState.prepare({
      sessionID: fork.id,
      messageID: anchor.id,
      user,
      messages: (yield* f.sessions.messages({ sessionID: fork.id })).filter((message) => message.info.id !== anchor.id),
      catalog: catalog("echo"),
    })
    expect(prepared.system).toBe(first.system)
    expect(JSON.stringify(prepared.messages)).not.toContain("later")
  }),
)

it.instance(
  "committed revert cleanup cascades removed snapshots and does not replay the removed future",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = yield* f.prepare(catalog("echo"))
      const boundary = yield* f.user()
      yield* f.prepare(catalog("echo", "future"))
      const revert = yield* SessionRevert.Service
      yield* revert.revert({ sessionID: f.session.id, messageID: boundary.id })
      yield* revert.cleanup(yield* f.sessions.get(f.session.id))
      expect(rows(f.session.id)).toHaveLength(1)
      const next = yield* f.prepare(catalog("echo"))
      expect(next.system).toBe(first.system)
      expect(JSON.stringify(next.messages)).not.toContain("future")
    }),
  { git: true, config: { lsp: false, formatter: false } },
)

it.instance("successful compaction rebases the catalog and ignores retained pre-summary tail snapshots", () =>
  Effect.gen(function* () {
    const f = yield* fixture(0)
    const old = yield* f.assistant(f.session.id, f.firstUser.id, {
      id: MessageID.make("msg_z_old"),
      time: { created: 2, completed: 2 },
    })
    yield* f.prepare(catalog("old"), old)
    const compact = yield* f.user()
    yield* f.sessions.updatePart({
      type: "compaction",
      id: PartID.ascending(),
      sessionID: f.session.id,
      messageID: compact.id,
      auto: true,
      tail_start_id: f.firstUser.id,
    })
    const summary = yield* f.assistant(f.session.id, compact.id, { id: MessageID.make("msg_m_summary"), summary: true })
    const current = yield* f.assistant(f.session.id, f.firstUser.id, {
      id: MessageID.make("msg_a_current"),
      time: { created: summary.time.created + 1, completed: summary.time.created + 1 },
    })
    const messages = (yield* MessageV2.filterCompactedEffect(f.session.id)).filter(
      (message) => message.info.id !== current.id,
    )
    expect(messages.findIndex((message) => message.info.id === old.id)).toBeGreaterThan(
      messages.findIndex((message) => message.info.id === summary.id),
    )
    const prepared = yield* CodeModeState.prepare({
      sessionID: f.session.id,
      messageID: current.id,
      user: f.firstUser,
      messages,
      catalog: catalog("new"),
    })
    expect(prepared.system).toContain("tools.demo.new")
    expect(prepared.system).not.toContain("tools.demo.old")
    expect(JSON.stringify(prepared.messages)).not.toContain("catalog has changed")
    expect(rows(f.session.id).find((row) => row.message_id === current.id)?.kind).toBe("initial")
  }),
)

it.instance("an unfinished summary does not reset the catalog, and session deletion cascades snapshots", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const first = yield* f.prepare(catalog("echo"))
    yield* f.assistant(f.session.id, f.firstUser.id, { summary: true, finish: undefined })
    expect((yield* f.prepare(catalog("echo"))).system).toBe(first.system)
    expect(rows(f.session.id)).toHaveLength(1)
    yield* f.sessions.remove(f.session.id)
    expect(rows(f.session.id)).toHaveLength(0)
  }),
)
