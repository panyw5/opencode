import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
  DESCRIPTION_FILENAME,
  PROJECT_TASKS_ROOT,
  descriptionRelativePath,
  ensureDescriptionFile,
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

  test("default path is .tasks/<taskID>/description.md", () => {
    const id = ProjectTaskID.make("ptask_path_test")
    expect(descriptionRelativePath(id)).toBe(path.join(PROJECT_TASKS_ROOT, id, DESCRIPTION_FILENAME))
  })

  test("write and read description file", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ptask-desc-"))
    const id = ProjectTaskID.make("ptask_rw")
    const rel = descriptionRelativePath(id)
    await writeDescriptionFile(root, rel, "# Goals\n\n- ship it\n")
    expect(await readDescriptionFile(root, rel)).toBe("# Goals\n\n- ship it\n")
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
