import { test, expect } from "../fixtures"
import { cleanupSession, sessionIDFromUrl, withSession } from "../actions"
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

test("new session draft tab closes after the first message creates a session", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await gotoSession()

  const draft = page.locator('[data-component="session-tab"][data-draft="true"]')
  await expect(draft).toBeVisible()

  await page.locator(promptSelector).fill(`e2e promote draft ${Date.now()}`)
  await page.keyboard.press("Enter")

  await expect.poll(() => sessionIDFromUrl(page.url()) ?? "", { timeout: 30_000 }).not.toBe("")
  const sessionID = sessionIDFromUrl(page.url())
  if (!sessionID) throw new Error(`Failed to resolve session id from ${page.url()}`)

  try {
    await expect(page.locator(`[data-component="session-tab"][data-session-id="${sessionID}"]`)).toHaveAttribute(
      "data-active",
      "true",
    )
    await expect(draft).toHaveCount(0)
  } finally {
    await cleanupSession({ sdk, sessionID })
  }
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

test("session tab can generate a title from its context menu", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e generate title source ${Date.now()}`, async (session) => {
    const current = await sdk.session.get({ sessionID: session.id }).then((result) => result.data)
    if (!current) throw new Error(`Failed to load session ${session.id}`)

    let requests = 0
    await page.route(`**/session/${session.id}/generate_title**`, async (route) => {
      requests += 1
      expect(route.request().method()).toBe("POST")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...current, title: "Generated context title" }),
      })
    })

    await gotoSession(session.id)
    const tab = page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`)
    await tab.click({ button: "right" })

    const action = page.locator('[data-action="session-tab-generate-title"]')
    await expect(action).toBeVisible()
    await action.click()

    await expect.poll(() => requests).toBe(1)
    await expect(tab).toContainText("Generated context title")
  })
})
