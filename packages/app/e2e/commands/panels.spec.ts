import { test, expect } from "../fixtures"
import { modKey } from "../utils"

test("right sidebar menu opens on click or keyboard activation, not hover", async ({ page, gotoSession }) => {
  await gotoSession()
  const trigger = page.getByRole("button", { name: "Review and files", exact: true }).first()
  const menu = page.locator('[data-slot="session-panel-menu"]')
  await trigger.hover()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.click()
  await expect(menu.getByRole("button")).toHaveText([/Toggle file tree/, /Toggle file preview/, /Toggle review/])
  const treeToggle = menu.getByRole("button", { name: "Toggle file tree" })
  const background = () => treeToggle.evaluate((item) => getComputedStyle(item).backgroundColor)
  const resting = await background()
  await treeToggle.hover()
  await expect.poll(background).not.toBe(resting)
  await page.mouse.move(0, 0)
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await trigger.press("ArrowDown")
  await expect(treeToggle).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(trigger).toBeFocused()
})

test("review panel can be toggled via keybind", async ({ page, gotoSession }) => {
  await gotoSession()

  const reviewPanel = page.locator("#session-side-panel")

  const trigger = page.getByRole("button", { name: "Review and files", exact: true }).first()
  const menu = page.locator('[data-slot="session-panel-menu"]')
  const treeToggle = menu.getByRole("button", { name: "Toggle file tree" })
  const reviewToggle = menu.getByRole("button", { name: "Toggle review" })
  await trigger.click()
  await expect(treeToggle).toBeVisible()
  if ((await treeToggle.getAttribute("aria-pressed")) === "true") {
    await treeToggle.click()
    await trigger.click()
  }
  await expect(reviewToggle).toBeVisible()
  if ((await reviewToggle.getAttribute("aria-pressed")) === "true") await reviewToggle.click()
  else await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "true")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "true")
})
