import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  DESCRIPTION_FILENAME,
  PROJECT_TASKS_ROOT,
  descriptionRelativePath,
  ensureDescriptionFile,
  listTaskWorkspaceFiles,
  readDescriptionFile,
  writeDescriptionFile,
} from "@/project-task/description-file"
import { ProjectTaskID } from "@/project-task/schema"

describe("project-task description files", () => {
  let root = ""

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ""
  })

  test("default path is .opentasks/<taskID>/description.md", () => {
    const id = ProjectTaskID.make("ptask_path_test")
    expect(descriptionRelativePath(id)).toBe(`${PROJECT_TASKS_ROOT}/${id}/${DESCRIPTION_FILENAME}`)
  })

  test("write and read description file", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-desc-"))
    const id = ProjectTaskID.make("ptask_rw")
    const rel = descriptionRelativePath(id)
    await writeDescriptionFile(root, rel, "# Goals\n\n- ship it\n")
    expect(await readDescriptionFile(root, rel)).toBe("# Goals\n\n- ship it\n")
  })

  test("listTaskWorkspaceFiles returns description first with known summaries", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-list-"))
    const id = ProjectTaskID.make("ptask_list")
    await writeDescriptionFile(root, descriptionRelativePath(id), "# Main goals\n\nShip mount inherit.\n")
    await writeDescriptionFile(
      root,
      `${PROJECT_TASKS_ROOT}/${id}/prd.md`,
      "# Requirements\n\nDetailed PRD body.\n",
    )
    await writeDescriptionFile(root, `${PROJECT_TASKS_ROOT}/${id}/notes.md`, "Scratch pad line one\n")

    const files = await listTaskWorkspaceFiles(root, id)
    expect(files.map((f) => f.name)).toEqual(["description.md", "notes.md", "prd.md"])
    expect(files[0].isDescription).toBe(true)
    expect(files[0].relativePath).toBe(`.opentasks/${id}/description.md`)
    expect(files[0].summary).toContain("canonical task brief")
    expect(files.find((f) => f.name === "prd.md")?.summary).toContain("Product requirements")
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
})


