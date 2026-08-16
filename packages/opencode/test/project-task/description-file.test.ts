import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import {
  DESCRIPTION_FILENAME,
  PROJECT_TASKS_ROOT,
  descriptionRelativePath,
  ensureDescriptionFile,
  legacyDescriptionRelativePath,
  listTaskWorkspaceFiles,
  readDescriptionFile,
  taskFilesAnchor,
  writeDescriptionFile,
} from "@/project-task/description-file"
import { ProjectTaskID } from "@/project-task/schema"

describe("project-task description files", () => {
  let root = ""

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ""
  })

  test("taskFilesAnchor prefers the git worktree root over subdirectory instances", () => {
    expect(taskFilesAnchor({ directory: "/repo/packages/app", worktree: "/repo" })).toBe("/repo")
    expect(taskFilesAnchor({ directory: "/repo", worktree: "/repo" })).toBe("/repo")
  })

  test("taskFilesAnchor falls back to the instance directory for non-git projects", () => {
    // Non-git projects report worktree "/"; dir: projects key it to the directory itself.
    expect(taskFilesAnchor({ directory: "/plain/dir", worktree: "/" })).toBe("/plain/dir")
    expect(taskFilesAnchor({ directory: "/plain/dir", worktree: undefined })).toBe("/plain/dir")
    expect(taskFilesAnchor({ directory: "/plain/dir", worktree: "  " })).toBe("/plain/dir")
  })

  test("default path is .project-tasks/<taskID>/prd.md", () => {
    const id = ProjectTaskID.make("ptask_path_test")
    expect(descriptionRelativePath(id)).toBe(`${PROJECT_TASKS_ROOT}/${id}/${DESCRIPTION_FILENAME}`)
    expect(descriptionRelativePath(id)).toBe(`.project-tasks/${id}/prd.md`)
  })

  test("write and read description file", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-desc-"))
    const id = ProjectTaskID.make("ptask_rw")
    const rel = descriptionRelativePath(id)
    await writeDescriptionFile(root, rel, "# Goals\n\n- ship it\n")
    expect(await readDescriptionFile(root, rel)).toBe("# Goals\n\n- ship it\n")
  })

  test("listTaskWorkspaceFiles returns prd.md first with known summaries", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-list-"))
    const id = ProjectTaskID.make("ptask_list")
    await writeDescriptionFile(root, descriptionRelativePath(id), "# Main goals\n\nShip mount inherit.\n")
    await writeDescriptionFile(root, `${PROJECT_TASKS_ROOT}/${id}/notes.md`, "Scratch pad line one\n")
    await writeDescriptionFile(root, `${PROJECT_TASKS_ROOT}/${id}/research.md`, "Findings line one\n")

    const files = await listTaskWorkspaceFiles(root, id)
    expect(files.map((f) => f.name)).toEqual(["prd.md", "notes.md", "research.md"])
    expect(files[0].isDescription).toBe(true)
    expect(files.find((f) => f.name === "notes.md")?.isDescription).toBe(false)
    expect(files.find((f) => f.name === "prd.md")?.relativePath).toBe(`.project-tasks/${id}/prd.md`)
    expect(files.find((f) => f.name === "prd.md")?.summary).toContain("canonical task brief")
    expect(files.find((f) => f.name === "notes.md")?.summary).toContain("Working notes")
  })

  test("ensure migrates legacy inline description into file and persists path", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-migrate-"))
    const id = ProjectTaskID.make("ptask_migrate")
    const persisted: Array<{ descriptionPath: string; clearLegacy: boolean }> = []

    const first = await ensureDescriptionFile({
      projectDirectory: root,
      taskID: id,
      descriptionPath: null,
      legacyDescription: "legacy body",
      persist: (next) => {
        persisted.push(next)
      },
    })

    expect(first.content).toBe("legacy body")
    expect(first.descriptionPath).toBe(descriptionRelativePath(id))
    expect(persisted).toEqual([{ descriptionPath: descriptionRelativePath(id), clearLegacy: true }])
    expect(await readDescriptionFile(root, first.descriptionPath)).toBe("legacy body")

    // Second ensure reads file; no re-migrate when path already set.
    const second = await ensureDescriptionFile({
      projectDirectory: root,
      taskID: id,
      descriptionPath: first.descriptionPath,
      legacyDescription: "should not overwrite file",
    })
    expect(second.content).toBe("legacy body")
  })

  test("ensure migrates legacy .opentasks workspace to .project-tasks and removes description.md", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-legacy-"))
    const id = ProjectTaskID.make("ptask_legacy")
    await writeDescriptionFile(root, legacyDescriptionRelativePath(id), "# Legacy brief\n\nOld body.\n")
    await writeDescriptionFile(root, `.opentasks/${id}/notes.md`, "Agent notes\n")
    const persisted: Array<{ descriptionPath: string; clearLegacy: boolean }> = []

    const result = await ensureDescriptionFile({
      projectDirectory: root,
      taskID: id,
      descriptionPath: legacyDescriptionRelativePath(id),
      legacyDescription: "stale inline body",
      persist: (next) => {
        persisted.push(next)
      },
    })

    expect(result.descriptionPath).toBe(descriptionRelativePath(id))
    expect(result.content).toBe("# Legacy brief\n\nOld body.\n")
    expect(persisted).toEqual([{ descriptionPath: descriptionRelativePath(id), clearLegacy: true }])
    // description.md moved (not copied): only prd.md + notes.md remain, under .project-tasks.
    expect(await readDescriptionFile(root, descriptionRelativePath(id))).toBe("# Legacy brief\n\nOld body.\n")
    expect(await readDescriptionFile(root, `.project-tasks/${id}/notes.md`)).toBe("Agent notes\n")
    const files = await listTaskWorkspaceFiles(root, id)
    expect(files.map((f) => f.name).sort()).toEqual(["notes.md", "prd.md"])
    expect(await Filesystem.exists(path.join(root, ".opentasks", id, "description.md"))).toBe(false)
    // Empty legacy task folder is cleaned up.
    expect(await Filesystem.exists(path.join(root, ".opentasks"))).toBe(false)
  })

  test("ensure prefers existing prd.md over legacy description.md", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-legacy-both-"))
    const id = ProjectTaskID.make("ptask_legacy_both")
    await writeDescriptionFile(root, legacyDescriptionRelativePath(id), "old body\n")
    await writeDescriptionFile(root, descriptionRelativePath(id), "new body\n")

    const result = await ensureDescriptionFile({
      projectDirectory: root,
      taskID: id,
      descriptionPath: legacyDescriptionRelativePath(id),
      legacyDescription: null,
      persist: () => {},
    })

    expect(result.descriptionPath).toBe(descriptionRelativePath(id))
    expect(result.content).toBe("new body\n")
    // Canonical wins; the stale legacy file is left in place (never destroyed).
    expect(await readDescriptionFile(root, legacyDescriptionRelativePath(id))).toBe("old body\n")
  })

  test("ensure never recreates the legacy path when DB points at a missing description.md", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-legacy-missing-"))
    const id = ProjectTaskID.make("ptask_legacy_missing")

    const result = await ensureDescriptionFile({
      projectDirectory: root,
      taskID: id,
      descriptionPath: legacyDescriptionRelativePath(id),
      legacyDescription: "inline fallback",
      persist: () => {},
    })

    expect(result.descriptionPath).toBe(descriptionRelativePath(id))
    expect(result.content).toBe("inline fallback")
    expect(await readDescriptionFile(root, descriptionRelativePath(id))).toBe("inline fallback")
  })
})
