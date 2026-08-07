import path from "path"
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
  return path.join(PROJECT_TASKS_ROOT, String(taskID), DESCRIPTION_FILENAME)
}

/** Task workspace folder: `.opentasks/<taskID>/` (agents may add extra files here). */
export function taskWorkspaceRelativePath(taskID: ProjectTaskID | string): string {
  return path.join(PROJECT_TASKS_ROOT, String(taskID))
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
