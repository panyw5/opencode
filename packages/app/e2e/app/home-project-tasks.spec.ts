import { test, expect } from "../fixtures"
import { createSdk } from "../utils"

test("home lists new tasks, refreshes linked activity and opens task detail", async ({ page, withProject }) => {
  await withProject(async ({ directory, trackSession }) => {
    const sdk = createSdk(directory)
    const older = (
      await sdk.projectTask.create({
        projectTaskCreateInput: { title: "Home activity task", description: "Full home task description" },
      })
    ).data!
    const newer = (await sdk.projectTask.create({ projectTaskCreateInput: { title: "Home newly added task" } })).data!
    try {
      await page.goto("/")
      const section = page.getByRole("region", { name: "Recent project tasks" })
      const rows = section.locator(`[data-task-id="${older.id}"], [data-task-id="${newer.id}"]`)
      await expect(rows).toHaveCount(2)
      await expect(rows.first()).toHaveAttribute("data-task-id", newer.id)

      const session = (await sdk.session.create({ title: "Home linked activity" })).data!
      trackSession(session.id)
      await sdk.projectTask.mount({ sessionID: session.id, projectTaskMountInput: { taskID: older.id } })
      await expect(rows.first()).toHaveAttribute("data-task-id", older.id)
      await expect(rows.first().getByText("1 sessions")).toBeVisible()
      await rows.first().click()
      await expect(page.getByRole("dialog").getByText("Full home task description", { exact: true })).toBeVisible()
      await page.keyboard.press("Escape")

      await sdk.projectTask.archive({ taskID: older.id })
      await expect(section.locator(`[data-task-id="${older.id}"]`)).toHaveCount(0)
      await expect(section.locator(`[data-task-id="${newer.id}"]`)).toBeVisible()
    } finally {
      await sdk.projectTask.archive({ taskID: older.id })
      await sdk.projectTask.archive({ taskID: newer.id })
    }
  })
})

test("home recent project tasks can retry a failed request", async ({ page, withProject }) => {
  await withProject(async ({ directory }) => {
    const sdk = createSdk(directory)
    const task = (await sdk.projectTask.create({ projectTaskCreateInput: { title: "Home retry task" } })).data!
    let requests = 0
    await page.route("**/experimental/project-task/recent?*", (route) => {
      requests++
      return requests === 1 ? route.fulfill({ status: 500, body: "unavailable" }) : route.continue()
    })
    try {
      await page.goto("/")
      const section = page.getByRole("region", { name: "Recent project tasks" })
      await section.getByRole("button", { name: "Could not load this section. Select to try again." }).click()
      await expect(section.locator(`[data-task-id="${task.id}"]`)).toBeVisible()
      expect(requests).toBe(2)
    } finally {
      await page.unrouteAll({ behavior: "wait" })
      await sdk.projectTask.archive({ taskID: task.id })
    }
  })
})
