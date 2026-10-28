import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("smoke model selection updates prompt footer", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")

  const command = page.locator('[data-slash-id="model.choose"]')
  await expect(command).toBeVisible()
  await command.hover()

  await page.keyboard.press("Enter")

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()

  const input = dialog.getByRole("textbox").first()

  const selected = dialog.locator('[data-slot="list-item"][data-selected="true"]').first()
  await expect(selected).toBeVisible()
  await expect(dialog.locator('[data-slot="list-viewport"]')).toHaveCSS("row-gap", "2px")
  const rows = await dialog.locator('[data-slot="list-item"]').evaluateAll((items) =>
    items.map((item) => ({
      height: (item as HTMLElement).offsetHeight,
      shrink: getComputedStyle(item.parentElement!).flexShrink,
    })),
  )
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.height).toBeGreaterThanOrEqual(40)
    expect(row.shrink).toBe("0")
  }

  const other = dialog.locator('[data-slot="list-item"]:not([data-selected="true"])').first()
  const target = (await other.count()) > 0 ? other : selected

  const key = await target.getAttribute("data-key")
  if (!key) throw new Error("Failed to resolve model key from list item")

  const model = key.split(":").slice(1).join(":")

  await input.fill(model)

  // The padding above the label must select the model too, not just the text.
  await dialog.locator(`[data-slot="list-item"][data-key="${key}"]`).click({ position: { x: 4, y: 3 } })

  await expect(dialog).toHaveCount(0)

  await page.locator(promptSelector).click()
  await page.keyboard.type("/model")
  await expect(command).toBeVisible()
  await command.hover()
  await page.keyboard.press("Enter")

  const dialogAgain = page.getByRole("dialog")
  await expect(dialogAgain).toBeVisible()
  await expect(dialogAgain.locator(`[data-slot="list-item"][data-key="${key}"][data-selected="true"]`)).toBeVisible()
})
