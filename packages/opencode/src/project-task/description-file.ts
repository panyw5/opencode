import path from "path"
import { mkdir, readdir, rename, rmdir } from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import type { ProjectTaskID } from "./schema"

/**
 * Project-root folder for all project-task workspaces (user-visible, not under .opencode).
 * Dotted to keep it clearly tool-owned at the project root.
 */
export const PROJECT_TASKS_ROOT = ".project-tasks"

/** Canonical brief filename inside each task folder. */
export const DESCRIPTION_FILENAME = "prd.md"

/** Pre-rename workspace root / brief filename; migrated into PROJECT_TASKS_ROOT on hydrate. */
export const LEGACY_PROJECT_TASKS_ROOT = ".opentasks"
export const LEGACY_DESCRIPTION_FILENAME = "description.md"

/** Relative path: `.project-tasks/<taskID>/prd.md` */
export function descriptionRelativePath(taskID: ProjectTaskID | string): string {
  return path.posix.join(PROJECT_TASKS_ROOT, String(taskID), DESCRIPTION_FILENAME)
}

/** Legacy relative path: `.opentasks/<taskID>/description.md` (migrated on hydrate). */
export function legacyDescriptionRelativePath(taskID: ProjectTaskID | string): string {
  return path.posix.join(LEGACY_PROJECT_TASKS_ROOT, String(taskID), LEGACY_DESCRIPTION_FILENAME)
}

/** Task workspace folder: `.project-tasks/<taskID>/` (agents may add extra files here). */
export function taskWorkspaceRelativePath(taskID: ProjectTaskID | string): string {
  return path.posix.join(PROJECT_TASKS_ROOT, String(taskID))
}

/**
 * Anchor directory for task workspace files. projectID is derived from the git
 * worktree, so every subdirectory instance of the same project shares task rows
 * — files must resolve identically too, hence the worktree root. Non-git
 * projects report worktree "/" (matches any path), so fall back to the
 * instance directory there.
 */
export function taskFilesAnchor(ctx: { directory: string; worktree?: string | null }): string {
  const worktree = ctx.worktree?.trim()
  return worktree && worktree !== "/" ? worktree : ctx.directory
}

/** Known filenames under a task workspace → short purpose for inject briefs. */
const KNOWN_TASK_FILE_SUMMARY: Record<string, string> = {
  [DESCRIPTION_FILENAME]: "Goals, constraints, and acceptance criteria (canonical task brief).",
  [LEGACY_DESCRIPTION_FILENAME]: "Legacy task brief from before the prd.md rename (superseded).",
  "notes.md": "Working notes captured while executing this task.",
  "research.md": "Research findings related to this task.",
  "plan.md": "Execution plan or checklist for this task.",
  "checklist.md": "Verification / acceptance checklist.",
  "report.md": "Status or completion report for this task.",
}

export type TaskWorkspaceFile = {
  /** Project-relative path using `/` separators (e.g. `.project-tasks/<id>/prd.md`). */
  relativePath: string
  name: string
  /** True when this is the canonical prd.md. */
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
 * List top-level files in `.project-tasks/<taskID>/` for context injection.
 * Directories and hidden files are skipped. prd.md is always preferred first.
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
 * Move files from the legacy `.opentasks/<taskID>/` workspace into `.project-tasks/<taskID>/`.
 * `description.md` is renamed to `prd.md`; other files keep their names. Files that already
 * exist at the destination are never overwritten (canonical wins). Best-effort: errors are
 * logged and skipped so hydrate never fails because of migration.
 *
 * Returns the canonical `prd.md` content when migration produced/kept one, else undefined.
 */
export async function migrateLegacyTaskWorkspace(
  projectDirectory: string,
  taskID: ProjectTaskID | string,
): Promise<string | undefined> {
  const legacyDir = absoluteFromProject(projectDirectory, path.posix.join(LEGACY_PROJECT_TASKS_ROOT, String(taskID)))
  const canonicalDir = absoluteFromProject(projectDirectory, taskWorkspaceRelativePath(taskID))
  if (!(await Filesystem.isDir(legacyDir))) return undefined

  let names: string[] = []
  try {
    names = (await readdir(legacyDir)).filter((name) => name && !name.startsWith("."))
  } catch (error) {
    console.debug(`[project-task] legacy migrate readdir failed taskID=${taskID} dir=${legacyDir} error=${error}`)
    return undefined
  }

  const moved: string[] = []
  for (const name of names) {
    const from = path.join(legacyDir, name)
    const to = path.join(canonicalDir, name === LEGACY_DESCRIPTION_FILENAME ? DESCRIPTION_FILENAME : name)
    if (await Filesystem.exists(to)) continue
    try {
      await mkdir(canonicalDir, { recursive: true })
      await rename(from, to)
      moved.push(name)
    } catch (error) {
      console.debug(`[project-task] legacy migrate move failed taskID=${taskID} file=${name} error=${error}`)
    }
  }

  // Remove now-empty legacy dirs (task folder first, then the root); ignore failures.
  try {
    await rmdir(legacyDir)
    await rmdir(absoluteFromProject(projectDirectory, LEGACY_PROJECT_TASKS_ROOT))
  } catch {
    /* left-overs stay visible under .opentasks/ */
  }

  const canonical = await readDescriptionFile(projectDirectory, descriptionRelativePath(taskID))
  if (moved.length > 0 || canonical !== undefined) {
    console.debug(
      `[project-task] legacy migrate done taskID=${taskID} moved=${moved.join(",") || "none"} canonical=${canonical !== undefined}`,
    )
  }
  return canonical
}

/**
 * Ensure a task has a description file and return `{ relativePath, content }`.
 * Migrates legacy DB-inline description into `.project-tasks/<id>/prd.md` when needed, and
 * relocates pre-rename `.opentasks/<id>/` workspaces (description.md → prd.md).
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
  const canonical = descriptionRelativePath(input.taskID)
  const legacyPath = legacyDescriptionRelativePath(input.taskID)
  const stored = input.descriptionPath?.trim() ?? ""

  // Rows created before the rename point at (or only have) the legacy workspace.
  if (stored === legacyPath || (!stored && (await Filesystem.exists(absoluteFromProject(input.projectDirectory, legacyPath))))) {
    const migrated = await migrateLegacyTaskWorkspace(input.projectDirectory, input.taskID)
    if (migrated !== undefined) {
      await input.persist?.({ descriptionPath: canonical, clearLegacy: true })
      return { descriptionPath: canonical, content: migrated }
    }
  }

  // Custom stored paths are respected; otherwise default to the canonical prd.md path
  // (never recreate the legacy description.md location).
  const relativePath = stored && stored !== legacyPath ? stored : canonical

  const existing = await readDescriptionFile(input.projectDirectory, relativePath)
  if (existing !== undefined) {
    if (!stored) {
      await input.persist?.({ descriptionPath: relativePath, clearLegacy: true })
    }
    return { descriptionPath: relativePath, content: existing }
  }

  const legacy = input.legacyDescription?.trim() ?? ""
  await writeDescriptionFile(input.projectDirectory, relativePath, legacy)
  await input.persist?.({
    descriptionPath: relativePath,
    clearLegacy: legacy.length > 0 || !stored,
  })
  return { descriptionPath: relativePath, content: legacy }
}
