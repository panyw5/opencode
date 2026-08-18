import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { promptSelector, sessionNewButtonSelector } from "../selectors"

test("new session draft tab stays visible when switching sessions", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e draft source ${Date.now()}`, async (source) => {
    await withSession(sdk, `e2e draft target ${Date.now()}`, async (target) => {
      await gotoSession(source.id)

      await page.locator(sessionNewButtonSelector).click()
      await expect(page).toHaveURL(/\/session(?:[?#]|$)/)
      await page.locator(promptSelector).fill("draft should remain visible")

      const draft = page.locator('[data-component="session-tab"][data-draft="true"]')
      await expect(draft).toBeVisible()
      await expect(draft).toHaveAttribute("data-active", "true")

      await gotoSession(target.id)
      await expect(page).toHaveURL(new RegExp(`/session/${target.id}(?:[?#]|$)`))
      await expect(draft).toBeVisible()
      await expect(draft).not.toHaveAttribute("data-active", "true")

      await draft.click()
      await expect(page).toHaveURL(/\/session(?:[?#]|$)/)
      await expect(page.locator(promptSelector)).toContainText("draft should remain visible")
    })
  })
})
