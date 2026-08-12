import path from "path"
import { readdir } from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import type { ProjectTaskID } from "./schema"

/**
 * Project-root folder for all project-task workspaces (user-visible, not under .opencode).
 * Prefixed to reduce collisions with generic task folders from other tools.
 */
export const PROJECT_TASKS_ROOT = ".opentasks"

/** Canonical description filename inside each task folder. */
export const DESCRIPTION_FILENAME = "description.md"

/** Relative path: `.opentasks/<taskID>/description.md` */
export function descriptionRelativePath(taskID: ProjectTaskID | string): string {
  return path.posix.join(PROJECT_TASKS_ROOT, String(taskID), DESCRIPTION_FILENAME)
}

/** Task workspace folder: `.opentasks/<taskID>/` (agents may add extra files here). */
export function taskWorkspaceRelativePath(taskID: ProjectTaskID | string): string {
  return path.posix.join(PROJECT_TASKS_ROOT, String(taskID))
}

/** Known filenames under a task workspace → short purpose for inject briefs. */
const KNOWN_TASK_FILE_SUMMARY: Record<string, string> = {
  [DESCRIPTION_FILENAME]: "Goals, constraints, and acceptance criteria (canonical task brief).",
  "prd.md": "Product requirements / detailed PRD for this task.",
  "notes.md": "Working notes captured while executing this task.",
  "research.md": "Research findings related to this task.",
  "plan.md": "Execution plan or checklist for this task.",
  "checklist.md": "Verification / acceptance checklist.",
  "report.md": "Status or completion report for this task.",
}

export type TaskWorkspaceFile = {
  /** Project-relative path using `/` separators (e.g. `.opentasks/<id>/description.md`). */
  relativePath: string
  name: string
  /** True when this is the canonical description.md. */
  isDescription: boolean
  /** One-line purpose for the model (known file or first markdown heading/line). */
  summary: string
  bytes: number
}

const MAX_TASK_WORKSPACE_FILES = 24
const MAX_SUMMARY_CHARS = 160

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("<!--")) continue
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    const body = (heading?.[1] ?? line).trim()
    if (!body) continue
    return body.length > MAX_SUMMARY_CHARS ? `${body.slice(0, MAX_SUMMARY_CHARS - 1)}…` : body
  }
  return ""
}

function summarizeTaskFile(name: string, contentPreview: string | undefined): string {
  const known = KNOWN_TASK_FILE_SUMMARY[name.toLowerCase()] ?? KNOWN_TASK_FILE_SUMMARY[name]
  if (known) return known
  if (contentPreview) {
    const line = firstMeaningfulLine(contentPreview)
    if (line) return line
  }
  if (name.endsWith(".md")) return "Markdown notes in the task workspace."
  return "File in the task workspace."
}

/**
 * List top-level files in `.opentasks/<taskID>/` for context injection.
 * Directories and hidden files are skipped. description.md is always preferred first.
 */
export async function listTaskWorkspaceFiles(
  projectDirectory: string,
  taskID: ProjectTaskID | string,
  options?: { maxFiles?: number },
): Promise<TaskWorkspaceFile[]> {
  const maxFiles = options?.maxFiles ?? MAX_TASK_WORKSPACE_FILES
  const relDir = taskWorkspaceRelativePath(taskID)
  const absDir = absoluteFromProject(projectDirectory, relDir)
  if (!(await Filesystem.isDir(absDir))) return []

  let names: string[] = []
  try {
    names = await readdir(absDir)
  } catch {
    return []
  }

  const files: TaskWorkspaceFile[] = []
  const sorted = names
    .filter((name) => name && !name.startsWith("."))
    .sort((a, b) => {
      if (a === DESCRIPTION_FILENAME) return -1
      if (b === DESCRIPTION_FILENAME) return 1
      return a.localeCompare(b)
    })

  for (const name of sorted) {
    if (files.length >= maxFiles) break
    const abs = path.join(absDir, name)
    const st = await Filesystem.statAsync(abs)
    if (!st || !st.isFile()) continue

    const bytes = typeof st.size === "bigint" ? Number(st.size) : st.size
    const relativePath = path.posix.join(relDir, name)
    const isDescription = name === DESCRIPTION_FILENAME
    let preview: string | undefined
    // Only peek small text-like files for a summary line.
    if (bytes > 0 && bytes <= 64 * 1024 && /\.(md|txt|markdown)$/i.test(name)) {
      try {
        const full = await Filesystem.readText(abs)
        preview = full.slice(0, 2_000)
      } catch {
        preview = undefined
      }
    }

    files.push({
      relativePath,
      name,
      isDescription,
      summary: summarizeTaskFile(name, preview),
      bytes,
    })
  }

  return files
}

export function absoluteFromProject(projectDirectory: string, relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : path.join(projectDirectory, relativePath)
}

export async function readDescriptionFile(
  projectDirectory: string,
  relativePath: string,
): Promise<string | undefined> {
  const abs = absoluteFromProject(projectDirectory, relativePath)
  if (!(await Filesystem.exists(abs))) return undefined
  return Filesystem.readText(abs)
}

export async function writeDescriptionFile(
  projectDirectory: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const abs = absoluteFromProject(projectDirectory, relativePath)
  await Filesystem.write(abs, content)
}

/**
 * Ensure a task has a description file and return `{ relativePath, content }`.
 * Migrates legacy DB-inline description into `.opentasks/<id>/description.md` when needed.
 */
export async function ensureDescriptionFile(input: {
  projectDirectory: string
  taskID: ProjectTaskID | string
  /** Existing relative path from DB, if any */
  descriptionPath?: string | null
  /** Legacy inline description from DB */
  legacyDescription?: string | null
  /** Persist path/clear legacy callback after migrate or first ensure */
  persist?: (next: { descriptionPath: string; clearLegacy: boolean }) => void | Promise<void>
}): Promise<{ descriptionPath: string; content: string }> {
  const relativePath =
    typeof input.descriptionPath === "string" && input.descriptionPath.trim()
      ? input.descriptionPath.trim()
      : descriptionRelativePath(input.taskID)

  const existing = await readDescriptionFile(input.projectDirectory, relativePath)
  if (existing !== undefined) {
    if (!input.descriptionPath?.trim()) {
      await input.persist?.({ descriptionPath: relativePath, clearLegacy: true })
    }
    return { descriptionPath: relativePath, content: existing }
  }

  const legacy = input.legacyDescription?.trim() ?? ""
  await writeDescriptionFile(input.projectDirectory, relativePath, legacy)
  await input.persist?.({
    descriptionPath: relativePath,
    clearLegacy: legacy.length > 0 || !input.descriptionPath?.trim(),
  })
  return { descriptionPath: relativePath, content: legacy }
}
