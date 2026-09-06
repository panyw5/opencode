import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { formatPatch, parsePatch, structuredPatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | VcsFileDiff | LegacyDiff

export type ViewDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const cache = new Map<string, FileDiffMetadata>()

// Parsing a unified patch into before/after contents is expensive and the
// inputs are immutable, so memoize results by patch text. Bounded: entries are
// full file texts, so an unbounded map would pin megabytes for long app lives.
const CONTENTS_CACHE_MAX = 32
const contentsCache = new Map<string, { before: string; after: string }>()

type PatchSource = {
  file?: string
  patch?: string
  before?: string
  after?: string
}

function patch(diff: PatchSource) {
  if (typeof diff.patch === "string") {
    try {
      const [patch] = parsePatch(diff.patch)
      const beforeLines: Array<{ text: string; newline: boolean }> = []
      const afterLines: Array<{ text: string; newline: boolean }> = []
      let previous: "-" | "+" | " " | undefined

      const patchIsPartial = patch.hunks.every((h) => h.oldStart > 1)

      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("\\")) {
            if (previous === "-" || previous === " ") {
              const before = beforeLines.at(-1)
              if (before) before.newline = false
            }
            if (previous === "+" || previous === " ") {
              const after = afterLines.at(-1)
              if (after) after.newline = false
            }
            continue
          }

          if (line.startsWith("-")) {
            beforeLines.push({ text: line.slice(1), newline: true })
            previous = "-"
          } else if (line.startsWith("+")) {
            afterLines.push({ text: line.slice(1), newline: true })
            previous = "+"
          } else {
            // context line (starts with ' ')
            beforeLines.push({ text: line.slice(1), newline: true })
            afterLines.push({ text: line.slice(1), newline: true })
            previous = " "
          }
        }
      }

      return {
        before: beforeLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
        after: afterLines.map((line) => line.text + (line.newline ? "\n" : "")).join(""),
        patch: diff.patch,
        patchIsPartial,
      }
    } catch {
      return { before: "", after: "", patch: diff.patch, patchIsPartial: false }
    }
  }
  return {
    before: typeof diff.before === "string" ? diff.before : "",
    after: typeof diff.after === "string" ? diff.after : "",
    patch: formatPatch(
      structuredPatch(
        diff.file ?? "",
        diff.file ?? "",
        typeof diff.before === "string" ? diff.before : "",
        typeof diff.after === "string" ? diff.after : "",
        "",
        "",
        { context: Number.MAX_SAFE_INTEGER },
      ),
    ),
    patchIsPartial: false,
  }
}

function file(file: string, patch: string, before: string, after: string, partial = false) {
  const hit = cache.get(patch)
  if (hit) return hit

  let value: FileDiffMetadata | undefined
  if (partial) value = parsePatchFiles(patch)[0]?.files[0]
  if (value === undefined) value = parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })

  cache.set(patch, value)
  return value
}

export function normalize(diff: ReviewDiff): ViewDiff {
  const next = patch(diff)
  const fileDiff = file(diff.file, next.patch, next.before, next.after, next.patchIsPartial)
  return {
    file: diff.file,
    patch: next.patch,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff,
  }
}

/** Resolve rendered file contents for a diff, reconstructing them from the
 * unified patch when the payload does not carry before/after snapshots. */
export function diffContents(diff: PatchSource): { before: string; after: string } {
  if (typeof diff.before === "string" || typeof diff.after === "string") {
    return {
      before: typeof diff.before === "string" ? diff.before : "",
      after: typeof diff.after === "string" ? diff.after : "",
    }
  }
  if (typeof diff.patch !== "string") return { before: "", after: "" }

  const hit = contentsCache.get(diff.patch)
  if (hit) return hit

  const parsed = patch(diff)
  const value = { before: parsed.before, after: parsed.after }
  if (contentsCache.size >= CONTENTS_CACHE_MAX) {
    const oldest = contentsCache.keys().next().value
    if (oldest !== undefined) contentsCache.delete(oldest)
  }
  contentsCache.set(diff.patch, value)
  return value
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}
