import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import path from "path"
import { Bus } from "@/bus"
import type { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import { FileChange } from "./file-change"

const log = Log.create({ service: "session.summary" })

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly repair: (sessionID: SessionID) => Effect.Effect<void>
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly invalidate: (sessionID: SessionID) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: {
    messages: MessageV2.WithParts[]
    files?: ReadonlySet<string>
  }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

type SummaryState = {
  closed: boolean
  generation: number
  invalidation: number
  generations: Map<SessionID, number>
  epochs: Map<SessionID, number>
  pendingMessages: Map<SessionID, Map<MessageID, number>>
  running: Set<SessionID>
  dirty: Set<SessionID>
  commitLock: Semaphore.Semaphore
}

function canonicalPath(file: string, root?: string) {
  const value = unquoteGitPath(file).replaceAll("\\", "/")
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(root ?? ".", value))
}

function addOwnedFile(files: Set<string>, value: unknown, root: string) {
  if (typeof value !== "string" || !value.trim()) return
  files.add(canonicalPath(value, root))
}

export function filterSessionDiffs(diffs: Snapshot.FileDiff[], files: ReadonlySet<string>, root?: string) {
  return diffs.filter((item) => item.file && files.has(canonicalPath(item.file, root)))
}

/** Returns files explicitly reported as written by tools in these messages. */
export function collectSessionEditedFiles(messages: MessageV2.WithParts[]) {
  const files = new Set<string>()

  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const root = message.info.path.root

    for (const part of message.parts) {
      if (part.type !== "tool") continue
      for (const change of FileChange.records(part)) addOwnedFile(files, change.file, root)
      if (part.state.status !== "completed" || !["edit", "write", "apply_patch"].includes(part.tool)) continue

      const metadata = part.state.metadata
      const input = part.state.input
      const reported = metadata.files
      if (part.tool === "apply_patch" && Array.isArray(reported)) {
        for (const item of reported) {
          if (typeof item === "string") {
            addOwnedFile(files, item, root)
            continue
          }
          if (!item || typeof item !== "object") continue
          const entry = item as Record<string, unknown>
          addOwnedFile(files, entry.filePath, root)
          addOwnedFile(files, entry.movePath, root)
          addOwnedFile(files, entry.relativePath, root)
        }
      }
      if (part.tool === "write" || part.tool === "edit") {
        addOwnedFile(files, metadata.filepath ?? input.filePath, root)
        continue
      }

      if (part.tool !== "apply_patch") continue
      if (typeof metadata.filepath === "string") {
        for (const value of metadata.filepath.split(",")) addOwnedFile(files, value, root)
      }
    }
  }

  return files
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<SummaryState>(() =>
      Effect.gen(function* () {
        const value: SummaryState = {
          closed: false,
          generation: 0,
          invalidation: 0,
          generations: new Map(),
          epochs: new Map(),
          pendingMessages: new Map(),
          running: new Set(),
          dirty: new Set(),
          commitLock: Semaphore.makeUnsafe(1),
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            value.closed = true
            value.dirty.clear()
            value.pendingMessages.clear()
            value.generations.clear()
          }).pipe(Effect.andThen(value.commitLock.withPermits(1)(Effect.void))),
        )
        return value
      }),
    )

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
      messages: MessageV2.WithParts[]
      files?: ReadonlySet<string>
    }) {
      const diffs = FileChange.diffs(input.messages)
      log.info("computed operation-owned diff", {
        sessionID: input.messages[0]?.info.sessionID ?? "",
        files: diffs.length,
        incomplete: diffs.filter((diff) => diff.incomplete).length,
      })
      return diffs
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const current = yield* InstanceState.get(state)
      const generation = ++current.generation
      current.generations.set(input.sessionID, generation)
      let targets = current.pendingMessages.get(input.sessionID) ?? new Map<MessageID, number>()
      targets.set(input.messageID, generation)
      current.pendingMessages.set(input.sessionID, targets)
      current.dirty.add(input.sessionID)
      log.info("session summary job started", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        generation,
      })
      if (current.running.has(input.sessionID)) {
        log.info("session summary request coalesced", {
          sessionID: input.sessionID,
          messageID: input.messageID,
          generation,
          pendingMessages: targets.size,
        })
        return
      }

      current.running.add(input.sessionID)
      yield* Effect.gen(function* () {
        while (!current.closed && current.dirty.has(input.sessionID)) {
          current.dirty.delete(input.sessionID)
          targets = current.pendingMessages.get(input.sessionID) ?? new Map<MessageID, number>()
          const latestGeneration = current.generations.get(input.sessionID)!
          const epoch = current.epochs.get(input.sessionID) ?? 0
          const messageTargets = [...targets]
          const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          if (!all.length) {
            targets.clear()
            break
          }

          const sessionFiles = collectSessionEditedFiles(all)
          const diffs = yield* computeDiff({ messages: all, files: sessionFiles })
          log.info("session summary ownership", {
            sessionID: input.sessionID,
            messageID: input.messageID,
            generation: latestGeneration,
            ownedFiles: sessionFiles.size,
            diffFiles: diffs.length,
          })
          const committed = yield* current.commitLock.withPermits(1)(
            Effect.gen(function* () {
              if (current.closed || (current.epochs.get(input.sessionID) ?? 0) !== epoch) return false
              yield* sessions.setSummary({
                sessionID: input.sessionID,
                summary: {
                  additions: diffs.reduce((sum, x) => sum + x.additions, 0),
                  deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
                  files: diffs.length,
                },
              })
              yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
              yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
              return true
            }),
          )
          if (!committed) continue

          for (const [messageID, requestedGeneration] of messageTargets) {
            if (current.closed || (current.epochs.get(input.sessionID) ?? 0) !== epoch) break
            const messages = all.filter(
              (m) => m.info.id === messageID || (m.info.role === "assistant" && m.info.parentID === messageID),
            )
            const target = messages.find((m) => m.info.id === messageID)
            if (!target || target.info.role !== "user") {
              if (targets.get(messageID) === requestedGeneration) targets.delete(messageID)
              continue
            }
            const msgFiles = collectSessionEditedFiles(messages)
            const msgDiffs = yield* computeDiff({ messages, files: msgFiles })
            if (current.closed || (current.epochs.get(input.sessionID) ?? 0) !== epoch) break
            const targetInfo = target.info
            const messageCommitted = yield* current.commitLock.withPermits(1)(
              Effect.gen(function* () {
                if (current.closed || (current.epochs.get(input.sessionID) ?? 0) !== epoch) return false
                targetInfo.summary = { ...targetInfo.summary, diffs: msgDiffs }
                yield* sessions.updateMessage(targetInfo)
                return true
              }),
            )
            if (!messageCommitted) break
            if (targets.get(messageID) === requestedGeneration) targets.delete(messageID)
          }
          if (current.dirty.has(input.sessionID)) continue
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            current.running.delete(input.sessionID)
            if (targets.size === 0 && !current.dirty.has(input.sessionID)) {
              current.pendingMessages.delete(input.sessionID)
              current.generations.delete(input.sessionID)
            }
          }),
        ),
      )
    })

    const invalidate = Effect.fn("SessionSummary.invalidate")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      if (current.closed) return
      yield* current.commitLock.withPermits(1)(
        Effect.sync(() => {
          const generation = ++current.invalidation
          current.epochs.set(sessionID, generation)
          current.generations.delete(sessionID)
          current.pendingMessages.delete(sessionID)
          current.dirty.delete(sessionID)
          log.info("session summary invalidated", { sessionID, generation })
        }),
      )
    })

    const repair = Effect.fn("SessionSummary.repair")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      yield* current.commitLock.withPermits(1)(
        Effect.gen(function* () {
          const marker = yield* storage
            .read<number>(["session_diff_version", sessionID])
            .pipe(Effect.orElseSucceed(() => 0))
          if (marker === FileChange.version || current.closed) return
          const all = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
          log.info("rebuilding legacy diff summaries", { sessionID, messages: all.length })
          const backup = <T>(id: string, value: T) =>
            Effect.gen(function* () {
              const key = ["session_diff_backup", sessionID, id]
              const exists = yield* storage.read(key).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
              if (!exists) yield* storage.write(key, value).pipe(Effect.orDie)
            })
          for (const target of all) {
            if (target.info.role !== "user") continue
            const messages = all.filter(
              (message) => message.info.role === "assistant" && message.info.parentID === target.info.id,
            )
            const diffs = FileChange.diffs(messages)
            if (JSON.stringify(target.info.summary?.diffs ?? []) === JSON.stringify(diffs)) continue
            log.info("repairing legacy turn diff", {
              sessionID,
              messageID: target.info.id,
              before: target.info.summary?.diffs.length ?? 0,
              after: diffs.length,
            })
            yield* backup(target.info.id, target.info.summary ?? null)
            yield* sessions.updateMessage({ ...target.info, summary: { ...target.info.summary, diffs } })
          }
          const diffs = FileChange.diffs(all)
          yield* backup(
            "session",
            yield* storage.read(["session_diff", sessionID]).pipe(Effect.orElseSucceed(() => null)),
          )
          yield* sessions.setSummary({
            sessionID,
            summary: {
              files: diffs.length,
              additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
              deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
            },
          })
          yield* storage.write(["session_diff", sessionID], diffs).pipe(Effect.orDie)
          yield* bus.publish(Session.Event.Diff, { sessionID, diff: diffs })
          yield* storage.write(["session_diff_version", sessionID], FileChange.version).pipe(Effect.orDie)
          log.info("legacy diff summaries rebuilt", { sessionID, files: diffs.length })
        }),
      )
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      yield* repair(input.sessionID)
      if (input.messageID) {
        const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
        return FileChange.diffs(
          all.filter(
            (message) =>
              message.info.id === input.messageID ||
              (message.info.role === "assistant" && message.info.parentID === input.messageID),
          ),
        )
      }
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, invalidate, diff, computeDiff, repair })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
