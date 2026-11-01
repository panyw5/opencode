import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { createTwoFilesPatch, diffLines } from "diff"
import { Schema } from "effect"
import type { MessageV2 } from "./message-v2"
import type { Snapshot } from "@/snapshot"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session.file-change" })
export const version = 1
const contentLimit = 512 * 1024
let lastTime = 0

export type Input = {
  tool: "edit" | "write" | "apply_patch"
  file: string
  before: string | null
  after: string | null
  source?: "formatter"
}

export const Record = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  callID: Schema.String,
  tool: Schema.Literals(["edit", "write", "apply_patch"]),
  source: Schema.optional(Schema.Literal("formatter")),
  file: Schema.String,
  time: Schema.Number,
  beforeHash: Schema.String,
  afterHash: Schema.String,
  before: Schema.optional(Schema.NullOr(Schema.String)),
  after: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.Number,
  deletions: Schema.Number,
  size: Schema.Number,
  status: Schema.Literals(["added", "deleted", "modified"]),
})
export type Record = typeof Record.Type

const decode = Schema.decodeUnknownOption(Schema.Array(Record))
type Change = Record & { legacy?: boolean; legacyPatch?: string }
const hash = (content: string | null) =>
  content === null ? "absent" : createHash("sha256").update(content).digest("hex")

export function counts(before: string | null, after: string | null) {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(before ?? "", after ?? "")) {
    if (change.added) additions += change.count ?? 0
    if (change.removed) deletions += change.count ?? 0
  }
  return { additions, deletions }
}

export function make(input: Input, callID: string): Record {
  const size = Buffer.byteLength(input.after ?? input.before ?? "")
  const retain = Buffer.byteLength(input.before ?? "") + Buffer.byteLength(input.after ?? "") <= contentLimit
  const record: Record = {
    version,
    id: randomUUID(),
    callID,
    tool: input.tool,
    ...(input.source ? { source: input.source } : {}),
    file: path.resolve(input.file),
    time: (lastTime = Math.max(Date.now(), lastTime + 0.001)),
    beforeHash: hash(input.before),
    afterHash: hash(input.after),
    ...(retain ? { before: input.before, after: input.after } : {}),
    ...counts(input.before, input.after),
    size,
    status: input.before === null ? "added" : input.after === null ? "deleted" : "modified",
  }
  log.info("file mutation captured", {
    callID,
    file: record.file,
    id: record.id,
    status: record.status,
    retained: retain,
    additions: record.additions,
    deletions: record.deletions,
  })
  return record
}

export function records(part: MessageV2.ToolPart): readonly Record[] {
  const value = decode(part.metadata?.fileChanges)
  return value._tag === "Some" ? value.value : []
}

function relative(file: string, root: string) {
  const value = path.relative(root, file).replaceAll("\\", "/")
  return value.startsWith("../") || path.isAbsolute(value) ? file : value
}

function toDiff(record: Change, root: string): Snapshot.FileDiff {
  const file = relative(record.file, root)
  const complete = record.before !== undefined && record.after !== undefined
  return {
    file,
    additions: record.additions,
    deletions: record.deletions,
    status: record.status,
    ...(record.legacy ? {} : { size: record.size }),
    attribution: record.legacy ? "legacy" : "verified",
    incomplete: !complete,
    ...(record.legacyPatch !== undefined
      ? { patch: record.legacyPatch }
      : complete
        ? { patch: createTwoFilesPatch(file, file, record.before ?? "", record.after ?? "") }
        : {}),
  }
}

/** Only join adjacent operations whose exact content identities agree. */
export function summarize(messages: MessageV2.WithParts[], legacy = false): Snapshot.FileDiff[] {
  const files = new Map<string, { root: string; segments: Change[] }>()
  const seen = new Set<string>()
  const observed = new Set<string>()
  const changes: { record: Change; root: string }[] = []
  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const root = message.info.path.root
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      for (const record of legacy && part.metadata?.fileChanges === undefined
        ? legacyRecords(part, message.info.path.cwd)
        : records(part)) {
        changes.push({ record, root })
      }
    }
  }
  changes.sort((a, b) => a.record.time - b.record.time)
  for (const { record, root } of changes) {
    // A formatter is an arbitrary subprocess, not a direct content write.
    if (record.source === "formatter") {
      if (record.beforeHash !== record.afterHash) observed.add(record.file)
      continue
    }
    if (seen.has(record.id)) continue
    seen.add(record.id)
    const item = files.get(record.file) ?? { root, segments: [] }
    const previous = item.segments.at(-1)
    if (
      previous &&
      previous.afterHash === record.beforeHash &&
      previous.before !== undefined &&
      record.after !== undefined
    ) {
      item.segments[item.segments.length - 1] = {
        ...previous,
        after: record.after,
        afterHash: record.afterHash,
        size: record.size,
        status: previous.before === null ? "added" : record.after === null ? "deleted" : "modified",
        ...counts(previous.before, record.after),
      }
    } else {
      if (previous) log.info("file mutation chain interrupted", { file: record.file, id: record.id })
      item.segments.push(record)
    }
    files.set(record.file, item)
  }
  return [...files.values()].flatMap(({ root, segments }) => {
    const active = segments.filter((record) => record.beforeHash !== record.afterHash)
    if (!active.length) return []
    const diffs = active.map((record) => ({
      ...toDiff(record, root),
      incomplete:
        observed.has(record.file) ||
        record.legacy === true ||
        record.before === undefined ||
        record.after === undefined,
    }))
    if (diffs.length === 1) return diffs
    return [
      {
        file: diffs[0]!.file,
        additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
        deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
        size: diffs.at(-1)!.size,
        status: "modified" as const,
        attribution: diffs.some((diff) => diff.attribution === "legacy") ? ("legacy" as const) : ("verified" as const),
        incomplete: diffs.some((diff) => diff.incomplete),
        operations: diffs.map(({ patch, additions, deletions }) => ({ patch, additions, deletions })),
      },
    ]
  })
}

/** Legacy tool-local patches are usable; legacy workspace snapshot patches are not. */
function legacyRecords(part: MessageV2.ToolPart, cwd: string): Change[] {
  if (part.state.status !== "completed") return []
  if (part.tool !== "edit" && part.tool !== "write" && part.tool !== "apply_patch") return []
  const metadata = part.state.metadata
  const entries =
    part.tool === "apply_patch" && Array.isArray(metadata.files)
      ? metadata.files
      : [
          {
            ...metadata.filediff,
            filePath: metadata.filepath ?? part.state.input.filePath,
            patch: metadata.filediff?.patch ?? metadata.diff,
          },
        ]
  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return []
    const name = entry.movePath ?? entry.filePath ?? entry.file
    if (typeof name !== "string" || !name) return []
    const file = path.resolve(cwd, name)
    const patch = typeof entry.patch === "string" ? entry.patch : undefined
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
    return [
      {
        version,
        id: `legacy:${part.id}:${index}`,
        callID: part.callID,
        tool: part.tool as Input["tool"],
        file,
        legacyPatch: patch,
        legacy: true,
        time: part.state.status === "completed" ? (part.state.time?.end ?? 0) : 0,
        beforeHash: `unknown-before:${part.id}:${index}`,
        afterHash: `unknown-after:${part.id}:${index}`,
        additions: count(entry.additions),
        deletions: count(entry.deletions),
        size: 0,
        status: "modified" as const,
      },
    ]
  })
}

export function diffs(messages: MessageV2.WithParts[]): Snapshot.FileDiff[] {
  return summarize(messages, true)
}

export * as FileChange from "./file-change"
