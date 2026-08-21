import { test, expect } from "../fixtures"
import { closeDialog, openPalette } from "../actions"

test("search palette opens and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page, "Shift+P")

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("new session palette prioritizes recent sessions", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page, "Shift+P")
  const first = dialog.locator('[data-slot="list-item"]').first()

  await expect(first).toHaveAttribute("data-key", "command:session.recent")
  await expect(first).toHaveAttribute("data-active", "true")
  await expect(first).toContainText("Recent sessions")
  await expect(dialog.locator('[data-key="command:session.new"]')).toHaveCount(0)
})

test("search palette also opens with cmd+p", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page, "P")

  await closeDialog(page, dialog)
  await expect(dialog).toHaveCount(0)
})
