import { test, expect, settingsKey } from "../fixtures"
import { closeDialog, openSettings } from "../actions"
import {
  settingsColorSchemeSelector,
  settingsFontSelector,
  settingsLanguageSelectSelector,
  settingsNotificationsAgentSelector,
  settingsNotificationsErrorsSelector,
  settingsNotificationsPermissionsSelector,
  settingsReleaseNotesSelector,
  settingsSearchIndexSelector,
  settingsSearchIndexStatusSelector,
  settingsSoundsAgentSelector,
  settingsSoundsErrorsSelector,
  settingsSoundsPermissionsSelector,
  settingsThemeSelector,
  settingsUpdatesStartupSelector,
} from "../selectors"

test("smoke settings dialog opens, switches tabs, closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)

  await dialog.getByRole("tab", { name: "Shortcuts" }).click()
  await expect(dialog.getByRole("button", { name: "Reset to defaults" })).toBeVisible()
  await expect(dialog.getByPlaceholder("Search shortcuts")).toBeVisible()

  await closeDialog(page, dialog)
})

test("changing language updates settings labels", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
  })

  await gotoSession()

  const dialog = await openSettings(page)

  const heading = dialog.getByRole("heading", { level: 2 })
  await expect(heading).toHaveText("General")

  const select = dialog.locator(settingsLanguageSelectSelector)
  await expect(select).toBeVisible()
  await select.locator('[data-slot="select-select-trigger"]').click()

  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "Deutsch" }).click()

  await expect(heading).toHaveText("Allgemein")

  await select.locator('[data-slot="select-select-trigger"]').click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "English" }).click()
  await expect(heading).toHaveText("General")
})

test("global search shows localized index progress and can be disabled", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "zh" }))
  })

  let state: "running" | "rebuilt" | "disabled" | "complete" = "running"
  await page.route("**/experimental/session/search/status**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action: string }
      state = body.action === "enable" ? "complete" : body.action === "rebuild" ? "rebuilt" : "disabled"
    }
    await route.fulfill({
      json:
        state === "running"
          ? { enabled: true, state: "running", indexed: 25, total: 100, complete: false, known: true }
          : state === "rebuilt"
            ? { enabled: true, state: "running", indexed: 0, total: 100, complete: false, known: true }
            : state === "complete"
              ? { enabled: true, state: "complete", indexed: 100, total: 100, complete: true, known: true }
              : { enabled: false, state: "disabled", indexed: 0, total: 0, complete: false, known: false },
    })
  })

  await gotoSession()
  await page.getByRole("button", { name: "设置" }).first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "全局搜索功能" })).toBeVisible()
  await expect(dialog.getByText("全局索引", { exact: true })).toBeVisible()

  const status = dialog.locator(settingsSearchIndexStatusSelector)
  await expect(status).toContainText("会话内容索引建立中（25/100）")
  await expect(status.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25")

  const control = dialog.locator(settingsSearchIndexSelector)
  await expect(control.getByRole("button")).toHaveText(["重建", "禁用"])
  await page.setViewportSize({ width: 600, height: 800 })
  const statusBox = await status.boundingBox()
  const controlBox = await control.boundingBox()
  expect(statusBox).not.toBeNull()
  expect(controlBox).not.toBeNull()
  expect(
    statusBox!.x < controlBox!.x + controlBox!.width &&
      statusBox!.x + statusBox!.width > controlBox!.x &&
      statusBox!.y < controlBox!.y + controlBox!.height &&
      statusBox!.y + statusBox!.height > controlBox!.y,
  ).toBe(false)
  expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  await control.getByRole("button", { name: "重建" }).click()
  await expect(status).toContainText("会话内容索引建立中（0/100）")
  await expect(control.getByRole("button")).toHaveText(["重建", "禁用"])

  await control.getByRole("button", { name: "禁用" }).click()
  await expect(status).toContainText("会话内容索引未启用")
  await expect(control.getByRole("button", { name: "启用" })).toBeVisible()

  await control.getByRole("button", { name: "启用" }).click()
  await expect(status.locator('[data-status="complete"]')).toContainText("会话内容索引已完成")
  await expect(status.getByRole("progressbar")).toHaveCount(0)
})

test("message font size and content width live in appearance and keep their adjustments", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()
  const dialog = await openSettings(page)
  const selectors = ["[data-action=settings-font-size]", "[data-action=settings-content-width]"]
  for (const selector of selectors) await expect(dialog.locator(selector)).toHaveCount(0)
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click()
  expect(
    await dialog
      .locator("[data-settings-appearance] [data-action]")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-action"))),
  ).toEqual([
    "settings-font",
    "settings-icon-pack",
    "settings-font-size",
    "settings-content-width",
    "settings-color-scheme",
    "settings-theme",
  ])
  for (const selector of selectors) {
    const control = dialog.locator(selector)
    await expect(control).toBeVisible()
    const initial = await control.locator("span").textContent()
    const increase = control.getByRole("button").last()
    const decrease = control.getByRole("button").first()
    const canIncrease = await increase.isEnabled()
    await (canIncrease ? increase : decrease).click()
    await expect(control.locator("span")).not.toHaveText(initial!)
    await (canIncrease ? decrease : increase).click()
    await expect(control.locator("span")).toHaveText(initial!)
  }
})

test("changing color scheme persists in localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click()
  const select = dialog.locator(settingsColorSchemeSelector)
  await expect(select).toBeVisible()

  await select.locator('[data-slot="select-select-trigger"]').click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "Dark" }).click()

  const colorScheme = await page.evaluate(() => {
    return document.documentElement.getAttribute("data-color-scheme")
  })
  expect(colorScheme).toBe("dark")

  await select.locator('[data-slot="select-select-trigger"]').click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "Light" }).click()

  const lightColorScheme = await page.evaluate(() => {
    return document.documentElement.getAttribute("data-color-scheme")
  })
  expect(lightColorScheme).toBe("light")
})

test("appearance cards select and persist a theme with four surface previews", async ({ page, gotoSession }) => {
  await gotoSession()
  const dialog = await openSettings(page)
  await expect(dialog.locator(settingsThemeSelector)).toHaveCount(0)
  await expect(dialog.locator(settingsColorSchemeSelector)).toHaveCount(0)
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click()
  const cards = dialog.locator(settingsThemeSelector).getByRole("button")
  await expect(cards.first()).toBeEnabled()
  expect(await cards.count()).toBeGreaterThan(1)
  await expect(cards.first().locator(".theme-card-preview")).toHaveText("")
  expect(
    await dialog
      .locator(settingsThemeSelector)
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length),
  ).toBe(3)
  const currentTheme = await page.locator("html").getAttribute("data-theme")
  const next = dialog.locator("[data-component=settings-theme-card][aria-pressed=false]").first()
  const id = await next.getAttribute("data-theme-id")
  expect(id).not.toBe(currentTheme)
  await expect(next.locator("[data-preview-surface]")).toHaveCount(4)
  const colors = await next
    .locator("[data-preview-surface]")
    .evaluateAll((elements) => elements.map((el) => getComputedStyle(el).backgroundColor))
  await next.click()
  await expect(next).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.locator("[data-component=settings-theme-card][aria-pressed=true]")).toHaveCount(1)
  await expect(page.locator("html")).toHaveAttribute("data-theme", id!)
  expect(
    await next
      .locator("[data-preview-surface]")
      .evaluateAll((elements) => elements.map((el) => getComputedStyle(el).backgroundColor)),
  ).toEqual(colors)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opencode-theme-id"))).toBe(id)
  await page.setViewportSize({ width: 600, height: 800 })
  await expect
    .poll(() => dialog.locator("[data-settings-appearance]").evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true)
  await closeDialog(page, dialog)
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", id!)
})

test("legacy oc-1 theme migrates to oc-2", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.setItem("opencode-theme-id", "oc-1")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("opencode-theme-css-dark", "--background-base:#000;")
  })

  await gotoSession()

  await expect(page.locator("html")).toHaveAttribute("data-theme", "oc-2")

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem("opencode-theme-id")
      })
    })
    .toBe("oc-2")

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem("opencode-theme-css-light")
      })
    })
    .toBeNull()

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem("opencode-theme-css-dark")
      })
    })
    .toBeNull()
})

test("changing font persists in localStorage and updates CSS variable", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click()
  const select = dialog.locator(settingsFontSelector)
  await expect(select).toBeVisible()

  const initialFontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono")
  })
  expect(initialFontFamily).toContain("IBM Plex Mono")

  await select.locator('[data-slot="select-select-trigger"]').click()

  const items = page.locator('[data-slot="select-select-item"]')
  await items.nth(2).click()

  await page.waitForTimeout(100)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.appearance?.font).not.toBe("ibm-plex-mono")

  const newFontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono")
  })
  expect(newFontFamily).not.toBe(initialFontFamily)
})

test("reasoning display migrates to enabled for existing settings", async ({ page, gotoSession }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        general: {
          showReasoningSummaries: false,
        },
      }),
    )
  }, settingsKey)

  await gotoSession()

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        if (!raw) return undefined
        return JSON.parse(raw)?.general?.showReasoningSummaries
      }, settingsKey)
    })
    .toBe(true)
})

test("color scheme and font rehydrate after reload", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  await dialog.getByRole("tab", { name: "Appearance", exact: true }).click()

  const colorSchemeSelect = dialog.locator(settingsColorSchemeSelector)
  await expect(colorSchemeSelect).toBeVisible()
  await colorSchemeSelect.locator('[data-slot="select-select-trigger"]').click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "Dark" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")

  const fontSelect = dialog.locator(settingsFontSelector)
  await expect(fontSelect).toBeVisible()

  const initialFontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim()
  })

  const initialSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  const currentFont =
    (await fontSelect.locator('[data-slot="select-select-trigger-value"]').textContent())?.trim() ?? ""
  await fontSelect.locator('[data-slot="select-select-trigger"]').click()

  const fontItems = page.locator('[data-slot="select-select-item"]')
  expect(await fontItems.count()).toBeGreaterThan(1)

  if (currentFont) {
    await fontItems.filter({ hasNotText: currentFont }).first().click()
  }
  if (!currentFont) {
    await fontItems.nth(1).click()
  }

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        font: expect.any(String),
      },
    })

  const updatedSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  const updatedFontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim()
  })
  expect(updatedFontFamily).not.toBe(initialFontFamily)
  expect(updatedSettings?.appearance?.font).not.toBe(initialSettings?.appearance?.font)

  await closeDialog(page, dialog)
  await page.reload()

  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        font: updatedSettings?.appearance?.font,
      },
    })

  const rehydratedSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim()
      })
    })
    .not.toBe(initialFontFamily)

  const rehydratedFontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim()
  })
  expect(rehydratedFontFamily).not.toBe(initialFontFamily)
  expect(rehydratedSettings?.appearance?.font).toBe(updatedSettings?.appearance?.font)
})

test("toggling notification agent switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsNotificationsAgentSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')
  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.notifications?.agent).toBe(false)
})

test("toggling notification permissions switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsNotificationsPermissionsSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')
  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.notifications?.permissions).toBe(false)
})

test("toggling notification errors switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsNotificationsErrorsSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')
  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(false)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(true)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.notifications?.errors).toBe(true)
})

test("changing sound agent selection persists in localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const select = dialog.locator(settingsSoundsAgentSelector)
  await expect(select).toBeVisible()

  await select.locator('[data-slot="select-select-trigger"]').click()

  const items = page.locator('[data-slot="select-select-item"]')
  await items.nth(2).click()

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.sounds?.agent).not.toBe("staplebops-01")
})

test("selecting none disables agent sound", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const select = dialog.locator(settingsSoundsAgentSelector)
  const trigger = select.locator('[data-slot="select-select-trigger"]')
  await expect(select).toBeVisible()
  await expect(trigger).toBeEnabled()

  await trigger.click()
  const items = page.locator('[data-slot="select-select-item"]')
  await expect(items.first()).toBeVisible()
  await items.first().click()

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.sounds?.agentEnabled).toBe(false)
})

test("changing permissions and errors sounds updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const permissionsSelect = dialog.locator(settingsSoundsPermissionsSelector)
  const errorsSelect = dialog.locator(settingsSoundsErrorsSelector)
  await expect(permissionsSelect).toBeVisible()
  await expect(errorsSelect).toBeVisible()

  const initial = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  const permissionsCurrent =
    (await permissionsSelect.locator('[data-slot="select-select-trigger-value"]').textContent())?.trim() ?? ""
  await permissionsSelect.locator('[data-slot="select-select-trigger"]').click()
  const permissionItems = page.locator('[data-slot="select-select-item"]')
  expect(await permissionItems.count()).toBeGreaterThan(1)
  if (permissionsCurrent) {
    await permissionItems.filter({ hasNotText: permissionsCurrent }).first().click()
  }
  if (!permissionsCurrent) {
    await permissionItems.nth(1).click()
  }

  const errorsCurrent =
    (await errorsSelect.locator('[data-slot="select-select-trigger-value"]').textContent())?.trim() ?? ""
  await errorsSelect.locator('[data-slot="select-select-trigger"]').click()
  const errorItems = page.locator('[data-slot="select-select-item"]')
  expect(await errorItems.count()).toBeGreaterThan(1)
  if (errorsCurrent) {
    await errorItems.filter({ hasNotText: errorsCurrent }).first().click()
  }
  if (!errorsCurrent) {
    await errorItems.nth(1).click()
  }

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      sounds: {
        permissions: expect.any(String),
        errors: expect.any(String),
      },
    })

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.sounds?.permissions).not.toBe(initial?.sounds?.permissions)
  expect(stored?.sounds?.errors).not.toBe(initial?.sounds?.errors)
})

test("toggling updates startup switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsUpdatesStartupSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')

  const isDisabled = await toggleInput.evaluate((el: HTMLInputElement) => el.disabled)
  if (isDisabled) {
    test.skip()
    return
  }

  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.updates?.startup).toBe(false)
})

test("toggling release notes switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsReleaseNotesSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')
  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.general?.releaseNotes).toBe(false)
})
