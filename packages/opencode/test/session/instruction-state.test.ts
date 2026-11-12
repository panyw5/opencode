import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database, eq } from "@/storage/db"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { InstructionSource } from "@/session/instruction-source"
import { InstructionGuidance } from "@/session/instruction-guidance"
import { SessionInstructionState } from "@/session/instruction-state"
import { InstructionSnapshotTable } from "@/session/instruction-state.sql"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionRevert.defaultLayer))

it.effect("instruction edits choose compact diffs and preserve semantic source ordering", () =>
  Effect.sync(() => {
    const before = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")
    const after = before.replace("line 50\n", "updated line 50\n")
    expect(
      InstructionGuidance.updateFiles(
        [{ path: "AGENTS.md", content: before }],
        [{ path: "AGENTS.md", content: after }],
      ),
    ).toContain("```diff")
    const files = [
      { path: "a", content: "first" },
      { path: "b", content: "second" },
    ]
    expect(InstructionGuidance.updateFiles(files, [...files].reverse())).toContain("ordered list replaces")
  }),
)
const rows = (id: SessionID) =>
  Database.use((db) =>
    db.select().from(InstructionSnapshotTable).where(eq(InstructionSnapshotTable.session_id, id)).all(),
  )
const fixture = Effect.fn("InstructionStateTest.fixture")(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  let clock = Date.now()
  const user = (sessionID = session.id) =>
    sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: ++clock },
    })
  const first = yield* user()
  const assistant = (sessionID = session.id, parentID = first.id, extra: Partial<MessageV2.Assistant> = {}) =>
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
  const prepare = Effect.fn("InstructionStateTest.prepare")(function* (
    sources: InstructionSource.Source[],
    anchor?: MessageV2.Info,
  ) {
    const current = anchor ?? (yield* assistant())
    const messages = (yield* sessions.messages({ sessionID: session.id })).filter(
      (message) => message.info.id !== current.id,
    )
    return yield* SessionInstructionState.prepare({
      sessionID: session.id,
      messageID: current.id,
      user: first,
      messages,
      sources,
    })
  })
  return { sessions, session, user, first, assistant, prepare }
})
function fileSource(read: () => readonly InstructionGuidance.File[] | InstructionSource.Unavailable) {
  return InstructionSource.make({
    key: "core/instructions",
    schema: InstructionGuidance.Files,
    read: () => Effect.sync(read),
    initial: InstructionGuidance.renderFiles,
    changed: InstructionGuidance.updateFiles,
  })
}
function skillSource(read: () => readonly InstructionGuidance.SkillEntry[] | InstructionSource.Unavailable) {
  return InstructionSource.make({
    key: "core/skill-guidance",
    schema: InstructionGuidance.Skills,
    read: () => Effect.sync(read),
    initial: InstructionGuidance.renderSkills,
    changed: InstructionGuidance.updateSkills,
  })
}

it.instance("file and skill sources have stable baselines and independent durable deltas", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    let files: InstructionGuidance.File[] = [{ path: "/project/AGENTS.md", content: "old policy" }]
    let skills: InstructionGuidance.SkillEntry[] = [{ name: "qa", description: "QA skill", location: "<built-in>" }]
    const sources = [fileSource(() => files), skillSource(() => skills)]
    const first = yield* f.prepare(sources)
    yield* f.prepare(sources)
    expect(rows(f.session.id)).toHaveLength(2)
    files = [{ ...files[0], content: "new policy" }]
    const changed = yield* f.prepare(sources)
    expect(changed.system).toEqual(first.system)
    expect(JSON.stringify(changed.messages)).toContain("new policy")
    skills = []
    const removed = yield* f.prepare(sources)
    expect(removed.system).toEqual(first.system)
    expect(JSON.stringify(removed.messages)).toContain("no longer available and must not be used: qa")
    expect(rows(f.session.id)).toHaveLength(4)
    expect((yield* f.sessions.messages({ sessionID: f.session.id })).flatMap((message) => message.parts)).toHaveLength(
      0,
    )
  }),
)

it.instance("unavailable reads preserve prior state, while confirmed removal revokes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    let value: InstructionGuidance.File[] | InstructionSource.Unavailable = [
      { path: "/project/AGENTS.md", content: "mandatory" },
    ]
    const source = fileSource(() => value)
    const first = yield* f.prepare([source])
    value = InstructionSource.unavailable
    expect((yield* f.prepare([source])).system).toEqual(first.system)
    expect(rows(f.session.id)).toHaveLength(1)
    value = []
    const removed = yield* f.prepare([source])
    expect(JSON.stringify(removed.messages)).toContain("no longer apply")
    expect(rows(f.session.id)).toHaveLength(2)
  }),
)

it.instance("initial unavailable sources block the request atomically", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const exit = yield* f
      .prepare([fileSource(() => InstructionSource.unavailable), skillSource(() => [])])
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(rows(f.session.id)).toHaveLength(0)
  }),
)

it.instance("unavailable skills are narrowed by current permissions before retaining them", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    let available = true
    let allowed = true
    const value = [{ name: "private", description: "private skill", location: "<built-in>" }]
    const source = InstructionSource.make({
      key: "core/skill-guidance",
      schema: InstructionGuidance.Skills,
      read: () => Effect.succeed(available ? value : InstructionSource.unavailable),
      keep: () => (allowed ? value : []),
      initial: InstructionGuidance.renderSkills,
      changed: InstructionGuidance.updateSkills,
    })
    yield* f.prepare([source])
    available = false
    allowed = false
    const prepared = yield* f.prepare([source])
    expect(rows(f.session.id).at(-1)?.snapshot).toEqual([])
    expect(JSON.stringify(prepared.messages)).toContain("no longer available and must not be used: private")
  }),
)

it.instance("request snapshots are immutable and replay updates as user notifications", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    let value = [{ path: "a", content: "one" }]
    const source = fileSource(() => value)
    yield* f.prepare([source])
    value = [{ path: "a", content: "two" }]
    const anchor = yield* f.assistant()
    const first = yield* f.prepare([source], anchor)
    expect(yield* f.prepare([source], anchor)).toEqual(first)
    const next = yield* f.prepare([source])
    const index = next.messages.findIndex((message) => message.info.id === anchor.id)
    expect(next.messages[index - 1].info.role).toBe("user")
    value = [{ path: "a", content: "three" }]
    expect((yield* f.prepare([source], anchor).pipe(Effect.exit))._tag).toBe("Failure")
  }),
)

it.instance(
  "fork and revert retain exactly the copied instruction history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      let files = [{ path: "a", content: "baseline" }]
      const source = fileSource(() => files)
      const first = yield* f.prepare([source])
      const boundary = yield* f.user()
      files = [{ path: "a", content: "future" }]
      yield* f.prepare([source])
      const fork = yield* f.sessions.fork({ sessionID: f.session.id, messageID: boundary.id })
      expect(rows(fork.id)).toHaveLength(1)
      const parent = (yield* f.sessions.messages({ sessionID: fork.id })).find(
        (message) => message.info.role === "user",
      )!.info as MessageV2.User
      const anchor = yield* f.assistant(fork.id, parent.id)
      files = [{ path: "a", content: "baseline" }]
      const copy = yield* SessionInstructionState.prepare({
        sessionID: fork.id,
        messageID: anchor.id,
        user: parent,
        messages: (yield* f.sessions.messages({ sessionID: fork.id })).filter(
          (message) => message.info.id !== anchor.id,
        ),
        sources: [source],
      })
      expect(copy.system).toEqual(first.system)
      const revert = yield* SessionRevert.Service
      yield* revert.revert({ sessionID: f.session.id, messageID: boundary.id })
      yield* revert.cleanup(yield* f.sessions.get(f.session.id))
      expect(rows(f.session.id)).toHaveLength(1)
      expect((yield* f.prepare([source])).system).toEqual(first.system)
    }),
  { git: true, config: { lsp: false, formatter: false } },
)

it.instance("compaction carries the last known source across an unavailable observation", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    let available = true
    const source = fileSource(() =>
      available
        ? [{ path: "nested/AGENTS.md", content: "keep after compaction", loaded: true }]
        : InstructionSource.unavailable,
    )
    const first = yield* f.prepare([source])
    const compact = yield* f.user()
    yield* f.sessions.updatePart({
      type: "compaction",
      id: PartID.ascending(),
      sessionID: f.session.id,
      messageID: compact.id,
      auto: true,
      tail_start_id: f.first.id,
    })
    yield* f.assistant(f.session.id, compact.id, { summary: true })
    const anchor = yield* f.assistant()
    available = false
    const prepared = yield* SessionInstructionState.prepare({
      sessionID: f.session.id,
      messageID: anchor.id,
      user: f.first,
      messages: (yield* MessageV2.filterCompactedEffect(f.session.id)).filter(
        (message) => message.info.id !== anchor.id,
      ),
      sources: [source],
    })
    expect(prepared.system).toEqual(first.system)
    expect(rows(f.session.id).filter((row) => row.kind === "initial")).toHaveLength(2)
    expect(JSON.stringify(prepared.messages)).not.toContain("no longer apply")
    yield* f.sessions.remove(f.session.id)
    expect(rows(f.session.id)).toHaveLength(0)
  }),
)
