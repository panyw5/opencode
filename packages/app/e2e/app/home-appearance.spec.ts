import { test, expect } from "../fixtures"

for (const width of [1440, 390]) {
  test(`home uses flat surfaces without horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")

    const home = page.locator('[data-component="home-shell"]')
    const launcher = home.locator(".home-command-deck")
    const input = home.getByRole("combobox")
    await expect(launcher).toBeVisible()
    await expect(input).toBeVisible()
    await expect(home.locator(".home-section").first()).toBeVisible()

    const surfaces = home.locator(":scope, .home-command-deck, .home-section, .home-work-row")
    for (const surface of await surfaces.all()) {
      await expect(surface).toHaveCSS("background-image", "none")
      await expect(surface).toHaveCSS("box-shadow", "none")
      await expect(surface).toHaveCSS("backdrop-filter", "none")
    }

    await input.focus()
    await expect(input).toHaveCSS("outline-style", "solid")
    await expect(input).toHaveCSS("outline-width", "2px")
    await expect(input).toHaveCSS("box-shadow", "none")
    expect(await home.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  })
}
