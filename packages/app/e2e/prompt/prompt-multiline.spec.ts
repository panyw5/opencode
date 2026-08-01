import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("prompt editor starts at three input lines without extra shell space", async ({ page, gotoSession }) => {
  await gotoSession()

  const prompt = page.locator(promptSelector)
  const scroll = page.locator('[data-slot="prompt-editor-scroll"]')

  await expect(prompt).toHaveCSS("min-height", "96px")
  await expect(scroll).toHaveJSProperty("clientHeight", 96)
})

test("shift+enter inserts a newline without submitting", async ({ page, gotoSession }) => {
  await gotoSession()

  await expect(page).toHaveURL(/\/session\/?$/)

  const prompt = page.locator(promptSelector)
  await prompt.focus()
  await expect(prompt).toBeFocused()

  await prompt.pressSequentially("line one")
  await expect(prompt).toBeFocused()

  await prompt.press("Shift+Enter")
  await expect(page).toHaveURL(/\/session\/?$/)
  await expect(prompt).toBeFocused()

  await prompt.pressSequentially("line two")

  await expect(page).toHaveURL(/\/session\/?$/)
  await expect.poll(() => prompt.evaluate((el) => el.innerText)).toBe("line one\nline two")
})
