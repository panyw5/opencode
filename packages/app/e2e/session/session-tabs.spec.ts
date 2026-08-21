import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { projectSwitchSelector, promptSelector, sessionItemSelector, sessionNewButtonSelector } from "../selectors"

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

test("session tab can reveal its project sessions in the sidebar", async ({ page, sdk, gotoSession, slug }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e reveal session tab ${Date.now()}`, async (session) => {
    await gotoSession(session.id)

    const project = page.locator(projectSwitchSelector(slug)).first()
    if ((await project.getAttribute("data-sidebar-expanded")) === "true") await project.click()
    await expect(project).toHaveAttribute("data-sidebar-expanded", "false")

    const tab = page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`)
    await expect(tab).toBeVisible()
    await tab.click({ button: "right" })

    const action = page.locator('[data-action="session-tab-show-in-sidebar"]')
    await expect(action).toBeVisible()
    await action.click()

    await expect(project).toHaveAttribute("data-sidebar-expanded", "true")
    await expect(page.locator(sessionItemSelector(session.id))).toBeVisible()
  })
})
