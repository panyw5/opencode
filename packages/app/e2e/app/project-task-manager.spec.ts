import { test, expect } from "../fixtures"
import { createSdk } from "../utils"

test("home manager lists all tasks and supports editing, archiving and restoring", async ({ page, withProject }) => {
  await withProject(async ({ directory }) => {
    const sdk = createSdk(directory)
    await sdk.project.open({ directory })
    const tasks = []
    for (let index = 0; index < 8; index++) {
      tasks.push(
        (
          await sdk.projectTask.create({
            projectTaskCreateInput: {
              title: `manager-e2e-${index}`,
              description: `Manager description ${index}`,
            },
          })
        ).data!,
      )
    }
    try {
      await page.goto("/")
      await page.getByRole("region", { name: "Recent project tasks" }).getByRole("button", { name: "Manage" }).click()
      const manager = page.locator('[data-component="project-task-manager"]')
      const search = manager.getByRole("textbox", { name: "Search task, project or ID" })
      await search.fill("manager-e2e")
      const list = manager.locator('[data-component="project-task-manager-list"]')
      await expect(list.locator("[data-task-id]")).toHaveCount(8)
      const first = tasks[0]
      await list.locator(`[data-task-id="${first.id}"]`).click()
      const editor = manager.locator('[data-component="project-task-embedded"]')
      await expect(editor.getByText("Manager description 0", { exact: true })).toBeVisible()
      const titleRow = editor.locator('[data-slot="project-task-title-row"]')
      const titleWidth = await titleRow.evaluate((element) => element.getBoundingClientRect().width)
      const editorWidth = await editor.evaluate((element) => element.getBoundingClientRect().width)
      expect(titleWidth).toBeGreaterThan(editorWidth * 0.75)
      await editor.getByRole("textbox", { name: "Title", exact: true }).fill("manager-e2e-renamed")
      await editor.getByRole("button", { name: "Save", exact: true }).click()
      await expect(list.locator(`[data-task-id="${first.id}"]`)).toContainText("manager-e2e-renamed")

      await editor.locator(".config-editor-mode-toggle").hover()
      await editor.getByRole("button", { name: "Edit source", exact: true }).click()
      await editor.locator("textarea").fill("Description autosaved when selecting another task")
      await list.locator(`[data-task-id="${tasks[1].id}"]`).click()
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(tasks[1].title)
      expect((await sdk.projectTask.detail({ taskID: first.id })).data?.description).toBe(
        "Description autosaved when selecting another task",
      )

      await list.locator(`[data-task-id="${first.id}"]`).click()
      page.once("dialog", (dialog) => dialog.accept())
      await editor.getByRole("button", { name: "Archive project task", exact: true }).click()
      await expect(list.locator(`[data-task-id="${first.id}"]`)).toHaveCount(0)
      await manager.getByRole("button", { name: /^Status/ }).click()
      await page.getByRole("option", { name: "Archived", exact: true }).click()
      await expect(list.locator(`[data-task-id="${first.id}"]`)).toBeVisible()
      await editor.locator('[data-project-task-status="open"]').click()
      await expect(list.locator(`[data-task-id="${first.id}"]`)).toHaveCount(0)
      expect((await sdk.projectTask.get({ taskID: first.id })).data?.status).toBe("open")
    } finally {
      for (const task of tasks) await sdk.projectTask.archive({ taskID: task.id })
    }
  })
})

test("manager keeps unsaved edits and selection when saving fails", async ({ page, withProject }) => {
  await withProject(async ({ directory }) => {
    const sdk = createSdk(directory)
    await sdk.project.open({ directory })
    const first = (await sdk.projectTask.create({ projectTaskCreateInput: { title: "manager-save-failure" } })).data!
    const second = (await sdk.projectTask.create({ projectTaskCreateInput: { title: "manager-next-task" } })).data!
    try {
      await page.goto(`/project-tasks?task=${first.id}`)
      const manager = page.locator('[data-component="project-task-manager"]')
      const editor = manager.locator('[data-component="project-task-embedded"]')
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled()
      await editor.locator(".config-editor-mode-toggle").hover()
      await editor.getByRole("button", { name: "Edit source", exact: true }).click()
      await editor.locator("textarea").fill("Draft retained after a failed save")
      await page.route(`**/project-task/${first.id}*`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 500, body: "intentional-save-failure" })
          : route.continue(),
      )
      await manager.locator(`[data-task-id="${second.id}"]`).click()
      await expect(editor.getByText("intentional-save-failure", { exact: true })).toBeVisible()
      await expect(editor.locator("textarea")).toHaveValue("Draft retained after a failed save")
      await expect(manager.locator(`[data-task-id="${first.id}"]`)).toHaveAttribute("aria-pressed", "true")
      await page.unrouteAll({ behavior: "wait" })
      await manager.locator(`[data-task-id="${second.id}"]`).click()
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(second.title)
      expect((await sdk.projectTask.detail({ taskID: first.id })).data?.description).toBe(
        "Draft retained after a failed save",
      )
    } finally {
      await page.unrouteAll({ behavior: "wait" })
      await sdk.projectTask.archive({ taskID: first.id })
      await sdk.projectTask.archive({ taskID: second.id })
    }
  })
})
