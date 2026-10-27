import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("smoke @mention inserts file pill token", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  const sep = process.platform === "win32" ? "\\" : "/"
  const file = ["packages", "app", "package.json"].join(sep)
  const filePattern = /packages[\\/]+app[\\/]+\s*package\.json/

  await page.keyboard.type(`@${file}`)

  const suggestion = page.getByRole("button", { name: filePattern }).first()
  await expect(suggestion).toBeVisible()
  await suggestion.hover()

  await page.keyboard.press("Enter")

  const pill = page.locator(`${promptSelector} [data-type="file"]`).first()
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute("data-path", filePattern)

  await page.keyboard.type(" ok")
  await expect(page.locator(promptSelector)).toContainText("ok")
})

test("@mention Tab switches categories without selecting or blurring", async ({ page, gotoSession }) => {
  await gotoSession()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("@")

  const tabs = page
    .getByRole("tablist")
    .filter({ has: page.getByRole("tab", { name: "External agents", exact: true }) })
  const categories = tabs.getByRole("tab")
  await expect(categories).toHaveCount(5)
  await expect(categories.nth(0)).toHaveAttribute("aria-selected", "true")
  for (const index of [1, 2, 3, 4, 0]) {
    await page.keyboard.press("Tab")
    await expect(categories.nth(index)).toHaveAttribute("aria-selected", "true")
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveText("@")
  }
  await page.keyboard.press("Shift+Tab")
  await expect(categories.nth(4)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Escape")
  await expect(tabs).not.toBeVisible()
})

test("@mention category tabs stay fixed while results scroll and Enter selects the active result", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    id: `ptask_test_${index}`,
    title: `Reference task ${index}`,
  }))
  await page.route("**/project-task*", (route) => route.fulfill({ json: tasks }))

  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("@")
  const tabs = page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Project tasks", exact: true }) })
  await tabs.getByRole("tab", { name: "Project tasks", exact: true }).click()
  const list = page.locator("[data-prompt-popover-list]")
  await expect(list.getByRole("button")).toHaveCount(tasks.length)

  const top = await tabs.evaluate((element) => element.getBoundingClientRect().top)
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => tabs.evaluate((element) => element.getBoundingClientRect().top)).toBe(top)

  await page.keyboard.press("ArrowDown")
  const active = list.locator("[data-prompt-popover-active]")
  const selected = await active.innerText()
  const id = selected.match(/ptask_test_\d+/)![0]
  await expect.poll(() => tabs.evaluate((element) => element.getBoundingClientRect().top)).toBe(top)
  await page.keyboard.press("Enter")
  await expect(list).not.toBeVisible()
  await expect(prompt).toContainText(`(ID: ${id})`)
  await expect(prompt).toContainText("@projectTask")
})
