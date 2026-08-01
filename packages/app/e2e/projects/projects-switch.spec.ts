import { test, expect } from "../fixtures"
import { defocus, createTestProject, cleanupSession, cleanupTestProject, slugFromUrl, waitSession } from "../actions"
import { promptSelector, projectSwitchSelector, sessionItemSelector } from "../selectors"
import { createSdk, dirSlug, modKey, sessionPath } from "../utils"

test("project rail selection leaves the active session route unchanged", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherSlug = dirSlug(other)
  const otherSdk = createSdk(other)
  const otherSession = await otherSdk.session
    .create({ title: `e2e sidebar project selection ${Date.now()}` })
    .then((r) => r.data)
  if (!otherSession?.id) throw new Error("Session create did not return an id")

  try {
    await withProject(
      async ({ directory, gotoSession, trackSession }) => {
        await defocus(page)

        const currentSdk = createSdk(directory)
        const currentSession = await currentSdk.session
          .create({ title: `e2e active project session ${Date.now()}` })
          .then((r) => r.data)
        if (!currentSession?.id) throw new Error("Session create did not return an id")
        trackSession(currentSession.id)
        await gotoSession(currentSession.id)

        const currentSlug = dirSlug(directory)
        const originalURL = page.url()
        const activeTabs = page.locator('[data-component="session-tab"][data-active="true"]')
        await expect(activeTabs).toHaveText(currentSession.title)
        const originalTabs = await activeTabs.evaluateAll((tabs) => tabs.map((tab) => tab.textContent))
        const otherButton = page.locator(projectSwitchSelector(otherSlug)).first()
        await expect(otherButton).toBeVisible()
        await otherButton.click()

        await expect(page).toHaveURL(originalURL)
        await expect(otherButton).toHaveAttribute("aria-current", "true")
        await expect(page.locator(sessionItemSelector(otherSession.id))).toBeVisible()
        await expect(activeTabs).toHaveCount(originalTabs.length)
        await expect(activeTabs).toHaveText(originalTabs)

        const otherSessionLink = page.locator(`${sessionItemSelector(otherSession.id)} a`).first()
        await expect(otherSessionLink).toBeVisible()
        await otherSessionLink.click()

        await expect(page).toHaveURL(new RegExp(`/${otherSlug}/session/${otherSession.id}(?:[?#]|$)`))
        await expect(page.locator(promptSelector)).toBeVisible()
        await expect(otherButton).toHaveAttribute("aria-current", "true")
        await expect(page.locator(projectSwitchSelector(currentSlug)).first()).not.toHaveAttribute(
          "aria-current",
          "true",
        )
      },
      { extra: [other] },
    )
  } finally {
    await cleanupSession({ sdk: otherSdk, sessionID: otherSession.id })
    await cleanupTestProject(other)
  }
})

test("project rail opens a new session when no session is active", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherSlug = dirSlug(other)
  try {
    await withProject(
      async ({ directory }) => {
        await page.goto(sessionPath(directory))
        await waitSession(page, { directory })
        await expect(page).toHaveURL(new RegExp(`/${dirSlug(directory)}/session(?:[?#]|$)`))

        const otherButton = page.locator(projectSwitchSelector(otherSlug)).first()
        await expect(otherButton).toBeVisible()
        await otherButton.click()

        await expect(page).toHaveURL(new RegExp(`/${otherSlug}/session(?:[?#]|$)`))
        await expect(page.locator(promptSelector)).toBeVisible()
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})

test("modifier drag reorders projects without navigating", async ({ page, withProject }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const other = await createTestProject()
  const otherSlug = dirSlug(other)

  try {
    await withProject(
      async ({ slug }) => {
        await defocus(page)

        const list = async () => {
          const items = await page
            .locator('[data-component="sidebar-rail"] [data-action="project-switch"]')
            .evaluateAll((els) =>
              els.map((el) => el.getAttribute("data-project") ?? "").filter((value) => value.length > 0),
            )
          return [...new Set(items)].filter((item) => item === slug || item === otherSlug)
        }

        const drag = async (from: string, to: string) => {
          const src = page.locator(projectSwitchSelector(from)).first()
          const dst = page.locator(projectSwitchSelector(to)).first()
          const a = await src.boundingBox()
          const b = await dst.boundingBox()
          if (!a || !b) throw new Error("Failed to resolve project drag bounds")

          await page.keyboard.down(modKey)
          await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
          await page.mouse.down()
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
          await page.mouse.up()
          await page.keyboard.up(modKey)
        }

        await expect.poll(async () => await list()).toEqual([otherSlug, slug])

        const before = slugFromUrl(page.url())
        await drag(slug, otherSlug)

        await expect.poll(async () => await list()).toEqual([slug, otherSlug])
        await expect.poll(() => slugFromUrl(page.url())).toBe(before)
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})
