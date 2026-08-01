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
  if (root && (result === root || result.startsWith(`${root}/`))) result = result.slice(root.length)

  // Assistant reports often cite a file selection, e.g. `src/app.ts:12-18`.
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

  for (const diff of diffs) {
    const file = diff.file && normalizeSessionFilePath(diff.file, directory)
    if (!file) continue
    changes.set(file, diff.status === "added" || diff.status === "deleted" ? diff.status : "modified")
  }
  for (const change of reported) {
    const file = normalizeSessionFilePath(change.file, directory)
    if (!file) continue
    if (!changes.has(file)) changes.set(file, change.status)
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

const savedFileReport =
  /(?:\b(?:wrote|written|saved|created|generated)\b|已(?:写入|保存|创建|生成)|checkpoint.{0,80}(?:完成|写入|saved|written))/i

const reportFilePath = (value: string): string | undefined => {
  const file = value.trim()
  // Text reports are a fallback for missing snapshots, so be deliberately
  // conservative: command fragments and source expressions are not files.
  if (!file || /[\s*?\[\]{}()'"`|;&<>]/.test(file)) return
  if (!file.includes("/") && !/^\.?[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(file)) return
  return file
}

/**
 * Restores file paths from completed write tools and explicit assistant reports.
 * This covers historical sessions where a generated artifact was intentionally
 * excluded from the content snapshot because it exceeded the snapshot limit.
 */
export function collectSessionReportedFileChanges(parts: readonly Part[]): SessionFileChange[] {
  const result: SessionFileChange[] = []

  for (const part of parts) {
    if (successfulTool(part)) {
      const tool = part.tool.trim().toLowerCase()
      if (tool === "apply_patch") {
        const patch = text(part.state.input.patchText)
        if (patch) result.push(...patchFiles(patch))
        continue
      }
      if (tool === "write" || tool === "write_file" || tool === "create_file") {
        const file = fileFromInput(part.state.input)
        if (file) result.push({ file, status: "modified" })
      }
      continue
    }

    if (part.type !== "text" || !savedFileReport.test(part.text)) continue
    for (const match of part.text.matchAll(/`([^`\n]+)`/g)) {
      const file = match[1] && reportFilePath(match[1])
      if (!file) continue
      result.push({ file, status: "added" })
    }
  }

  return result
}
