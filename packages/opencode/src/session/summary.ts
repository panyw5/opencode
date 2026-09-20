import { Effect, Layer, Context, Schema } from "effect"
import path from "path"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"

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
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: {
    messages: MessageV2.WithParts[]
    files?: ReadonlySet<string>
  }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

function canonicalPath(file: string, root?: string) {
  const value = unquoteGitPath(file).replaceAll("\\", "/")
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(root ?? ".", value))
}

function addOwnedFile(files: Set<string>, value: unknown, root: string) {
  if (typeof value !== "string" || !value.trim()) return
  files.add(canonicalPath(value, root))
}

export function filterSessionDiffs(diffs: Snapshot.FileDiff[], files: ReadonlySet<string>) {
  return diffs.filter((item) => item.file && files.has(canonicalPath(item.file)))
}

/** Returns files explicitly reported as written by tools in these messages. */
export function collectSessionEditedFiles(messages: MessageV2.WithParts[]) {
  const files = new Set<string>()

  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const root = message.info.path.root

    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue

      const metadata = part.state.metadata
      const input = part.state.input
      const reported = metadata.files
      if (Array.isArray(reported)) {
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
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
      messages: MessageV2.WithParts[]
      files?: ReadonlySet<string>
    }) {
      if (input.files && input.files.size === 0) return []

      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) {
        const diffs = yield* snapshot.diffFull(from, to)
        if (!input.files) return diffs

        const filtered = filterSessionDiffs(diffs, input.files)
        log.info("filtered session snapshot diff", {
          sessionID: input.messages[0]?.info.sessionID ?? "",
          snapshotFiles: diffs.length,
          ownedFiles: input.files.size,
          keptFiles: filtered.length,
        })
        return filtered
      }
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const sessionFiles = collectSessionEditedFiles(all)
      const diffs = yield* computeDiff({ messages: all, files: sessionFiles })
      log.info("session summary ownership", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        ownedFiles: sessionFiles.size,
        diffFiles: diffs.length,
      })
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

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      const msgFiles = collectSessionEditedFiles(messages)
      const msgDiffs = yield* computeDiff({ messages, files: msgFiles })
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
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

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
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
