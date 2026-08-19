import { test, expect } from "../fixtures"
import { closeDialog, openPalette } from "../actions"
import { serverNamePattern } from "../utils"

test("home renders and shows core entrypoints", async ({ page }) => {
  await page.goto("/")
  const nav = page.locator('[data-component="sidebar-nav-desktop"]')

  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()
  await expect(nav.getByText("No projects open")).toBeVisible()
  await expect(nav.getByText("Open a project to get started")).toBeVisible()
  await expect(page.getByRole("button", { name: serverNamePattern })).toBeVisible()
})

test("server picker dialog opens from home", async ({ page }) => {
  await page.goto("/")

  const trigger = page.getByRole("button", { name: serverNamePattern })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
})

test("command palette opens from home", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()

  const dialog = await openPalette(page, "Shift+P")
  await expect(dialog.getByText("Recent sessions", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Open project", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Open settings", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Reload frontend", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Previous session", { exact: true })).toHaveCount(0)
  await expect(dialog.getByText("Next session", { exact: true })).toHaveCount(0)

  await dialog.getByRole("textbox").fill("Connect provider")
  await expect(dialog.getByText("Connect provider", { exact: true })).toBeVisible()

  await closeDialog(page, dialog)
  await expect(dialog).toHaveCount(0)
})

test("command palette can open recent sessions from home", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()

  const palette = await openPalette(page, "Shift+P")
  await palette.getByText("Recent sessions", { exact: true }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
  await expect(dialog.getByPlaceholder("Search recent sessions...")).toBeVisible()
})
