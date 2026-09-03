import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2/client"

export type SessionFileChanges = {
  added: string[]
  modified: string[]
  deleted: string[]
}

export type SessionFileChange = {
  file: string
  status: keyof SessionFileChanges
}

/** Converts editor-style paths to one project-relative display and dedupe key. */
export function normalizeSessionFilePath(file: string, directory?: string): string | undefined {
  let result = file.trim().replaceAll("\\", "/")
  if (!result) return

  const root = directory?.trim().replaceAll("\\", "/").replace(/\/+$/, "")
  if (root && (result === root || result.startsWith(`${root}/`))) {
    result = result.slice(root.length)
    // Tool metadata reports absolute worktree paths; the remainder is project-relative.
    result = result.replace(/^\/+/, "")
  }

  // Editor paths may carry a selection, e.g. `src/app.ts:12-18`.
  result = result.replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, "")
  if (result.startsWith("/.")) result = result.slice(1)
  else result = result.replace(/^\.\/+/, "")
  return result || undefined
}

/** Groups the latest snapshot state of each changed file for the session status panel. */
export function collectSessionFileChanges(
  diffs: readonly SnapshotFileDiff[],
  reported: readonly SessionFileChange[] = [],
  directory?: string,
): SessionFileChanges {
  const changes = new Map<string, keyof SessionFileChanges>()

  // Tool reports arrive in chronological order, so the latest action for a
  // file wins (e.g. an apply_patch delete after a write marks it deleted).
  for (const change of reported) {
    const file = normalizeSessionFilePath(change.file, directory)
    if (!file) continue
    changes.set(file, change.status)
  }
  // Snapshot diffs reflect the authoritative current state and override reports.
  for (const diff of diffs) {
    const file = diff.file && normalizeSessionFilePath(diff.file, directory)
    if (!file) continue
    changes.set(file, diff.status === "added" || diff.status === "deleted" ? diff.status : "modified")
  }

  const result: SessionFileChanges = { added: [], modified: [], deleted: [] }
  for (const [file, status] of changes) result[status].push(file)

  for (const files of Object.values(result)) files.sort((a, b) => a.localeCompare(b))
  return result
}

const successfulTool = (
  part: Part,
): part is ToolPart & { state: Extract<ToolPart["state"], { status: "completed" }> } =>
  part.type === "tool" && part.state.status === "completed"

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return
  const next = value.trim()
  return next || undefined
}

const fileFromInput = (input: Record<string, unknown>) =>
  text(input.filePath) ?? text(input.file_path) ?? text(input.path)

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Structured file changes reported by the apply_patch tool metadata
 * (`metadata.files`, see `packages/opencode/src/tool/apply_patch.ts`).
 */
const applyPatchMetadataFiles = (metadata: Record<string, unknown>): SessionFileChange[] => {
  const files = Array.isArray(metadata.files) ? metadata.files : []
  const result: SessionFileChange[] = []

  for (const item of files) {
    const entry = record(item)
    if (!entry) continue
    const target = text(entry.relativePath)
    if (!target) continue
    const type = text(entry.type)
    if (type === "add") result.push({ file: target, status: "added" })
    else if (type === "delete") result.push({ file: target, status: "deleted" })
    else if (type === "move") {
      const source = text(entry.filePath)
      if (source) result.push({ file: source, status: "deleted" })
      result.push({ file: target, status: "added" })
    } else result.push({ file: target, status: "modified" })
  }
  return result
}

/** Legacy fallback for old sessions whose apply_patch parts predate metadata.files. */
const patchFiles = (patch: string): SessionFileChange[] => {
  const result: SessionFileChange[] = []
  for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    const file = match[2]?.trim()
    if (!file) continue
    result.push({
      file,
      status: match[1] === "Add" ? "added" : match[1] === "Delete" ? "deleted" : "modified",
    })
  }
  return result
}

/** Structured file change from the edit tool metadata (`metadata.filediff`). */
const editMetadataFile = (metadata: Record<string, unknown>): SessionFileChange | undefined => {
  const filediff = record(metadata.filediff)
  const file = filediff && text(filediff.file)
  if (!file) return
  return { file, status: "modified" }
}

/** Structured file change from the write tool metadata (`metadata.filepath` + `metadata.exists`). */
const writeMetadataFile = (metadata: Record<string, unknown>): SessionFileChange | undefined => {
  const file = text(metadata.filepath)
  if (!file) return
  return { file, status: metadata.exists === false ? "added" : "modified" }
}

/** Legacy fallback for old sessions whose write-like parts predate metadata. */
const inputWriteFile = (input: Record<string, unknown>): SessionFileChange | undefined => {
  const file = fileFromInput(input)
  if (!file) return
  return { file, status: "modified" }
}

/**
 * Recovers file changes from completed file-modifying tools. Only structured
 * tool metadata is trusted: assistant text is never scanned, so mentions,
 * examples, and discussed paths cannot leak into the report.
 */
export function collectSessionReportedFileChanges(parts: readonly Part[]): SessionFileChange[] {
  const result: SessionFileChange[] = []

  for (const part of parts) {
    if (!successfulTool(part)) continue
    const tool = part.tool.trim().toLowerCase()

    if (tool === "apply_patch") {
      const files = applyPatchMetadataFiles(part.state.metadata)
      if (files.length) result.push(...files)
      else {
        const patch = text(part.state.input.patchText)
        if (patch) result.push(...patchFiles(patch))
      }
      continue
    }

    if (tool === "edit") {
      const change = editMetadataFile(part.state.metadata)
      if (change) result.push(change)
      continue
    }

    if (tool === "write" || tool === "write_file" || tool === "create_file") {
      const change = writeMetadataFile(part.state.metadata) ?? inputWriteFile(part.state.input)
      if (change) result.push(change)
    }
  }

  return result
}
