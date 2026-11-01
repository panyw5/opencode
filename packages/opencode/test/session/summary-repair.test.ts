import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { FileChange } from "@/session/file-change"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_summary_repair")
const messageID = MessageID.make("msg_summary_repair")
const root = "/work/project"
let store = new Map<string, unknown>()
let messages: MessageV2.WithParts[] = []
let updates = 0
let total: unknown
const it = testEffect(
  SessionSummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Session.Service, {
          messages: () => Effect.sync(() => messages),
          updateMessage: (info) =>
            Effect.sync(() => {
              updates++
              messages = messages.map((message) => (message.info.id === info.id ? { ...message, info } : message))
              return info
            }),
          setSummary: (value) =>
            Effect.sync(() => {
              total = value.summary
            }),
        }),
        Layer.mock(Storage.Service, {
          read: <T>(key: string[]) =>
            store.has(key.join("/"))
              ? Effect.succeed(store.get(key.join("/")) as T)
              : Effect.fail(new Storage.NotFoundError({ message: "missing fixture key" })),
          write: (key, value) =>
            Effect.sync(() => {
              store.set(key.join("/"), structuredClone(value))
            }),
        }),
        Layer.mock(Bus.Service, { publish: () => Effect.void }),
        // Rebuilding history must never consult a live workspace snapshot.
        Layer.mock(Snapshot.Service, {}),
      ),
    ),
  ),
)

it.instance("repairs all historical turns once, preserves backups, and removes shell-owned files", () =>
  Effect.gen(function* () {
    const old = ["owned.txt", "foreign.txt"].map((file) => ({ file, additions: 1, deletions: 0 }))
    store = new Map([[`session_diff/${sessionID}`, old]])
    updates = 0
    messages = [
      { info: { id: messageID, sessionID, role: "user", summary: { diffs: old } }, parts: [] },
      {
        info: { id: "msg_assistant", sessionID, role: "assistant", parentID: messageID, path: { root, cwd: root } },
        parts: [
          {
            id: "prt_edit",
            type: "tool",
            tool: "edit",
            callID: "call_edit",
            metadata: {
              fileChanges: [
                FileChange.make(
                  { tool: "edit", file: `${root}/owned.txt`, before: null, after: "mine\n" },
                  "call_edit",
                ),
              ],
            },
            state: { status: "completed", metadata: {} },
          },
          {
            id: "prt_bash",
            type: "tool",
            tool: "bash",
            state: { status: "completed", metadata: { files: [`${root}/foreign.txt`] } },
          },
        ],
      },
    ] as unknown as MessageV2.WithParts[]
    const summary = yield* SessionSummary.Service
    yield* summary.repair(sessionID)
    expect(updates).toBe(1)
    expect(total).toEqual({ files: 1, additions: 1, deletions: 0 })
    expect(store.get(`session_diff_backup/${sessionID}/${messageID}`)).toEqual({ diffs: old })
    expect(store.get(`session_diff_backup/${sessionID}/session`)).toEqual(old)
    expect((yield* summary.diff({ sessionID, messageID })).map((diff) => diff.file)).toEqual(["owned.txt"])
    yield* summary.repair(sessionID)
    expect(updates).toBe(1)
    store.delete(`session_diff_version/${sessionID}`)
    yield* summary.repair(sessionID)
    expect(store.get(`session_diff_backup/${sessionID}/${messageID}`)).toEqual({ diffs: old })
    expect(store.get(`session_diff_backup/${sessionID}/session`)).toEqual(old)
  }),
)
