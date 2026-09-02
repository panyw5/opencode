import { test, expect } from "../fixtures"
import { dirPath } from "../utils"

test("project route stays neutral until the user creates a session", async ({ page, directory, slug }) => {
  await page.goto(dirPath(directory))

  await expect(page).toHaveURL(new RegExp(`/${slug}(?:[?#]|$)`))
  await expect(page.locator('[data-component="session-tab"][data-draft="true"]')).toHaveCount(0)
})
