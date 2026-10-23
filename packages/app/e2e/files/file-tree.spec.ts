import { test, expect } from "../fixtures"

test("file tree can expand folders and open a file", async ({ page, gotoSession }) => {
  await gotoSession()

  const toggle = page.getByRole("button", { name: "Toggle file tree" })
  const panel = page.locator("#file-tree-panel")
  const treeTabs = panel.locator('[data-component="tabs"][data-variant="pill"][data-scope="filetree"]')

  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(panel).toBeVisible()
  await expect(treeTabs).toBeVisible()

  const allTab = treeTabs.getByRole("tab", { name: /^all files$/i })
  await expect(allTab).toBeVisible()
  await allTab.click()
  await expect(allTab).toHaveAttribute("aria-selected", "true")

  const tree = treeTabs.locator('[data-slot="tabs-content"]:not([hidden])')
  await expect(tree).toBeVisible()

  const hover = async (row: ReturnType<typeof tree.locator>) => {
    await allTab.hover()
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none")
    // Even a theme whose surface hover color equals the panel must show feedback.
    await row.evaluate((el) => (el as HTMLElement).style.setProperty("--surface-raised-base-hover", "transparent"))
    await row.hover()
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none")
    console.info(`[file-tree-hover] visible feedback verified: ${await row.innerText()}`)
    await row.evaluate((el) => (el as HTMLElement).style.removeProperty("--surface-raised-base-hover"))
    await allTab.hover()
    await expect.poll(() => row.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none")
  }

  const expand = async (name: string) => {
    const folder = tree.getByRole("button", { name, exact: true }).first()
    await expect(folder).toBeVisible()
    await expect(folder).toHaveAttribute("aria-expanded", /true|false/)
    await hover(folder.locator('[data-component="file-tree-node"]'))
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click()
    await expect(folder).toHaveAttribute("aria-expanded", "true")
  }

  await expand("packages")
  await expand("app")
  await expand("src")
  await expand("components")

  const file = tree.getByRole("button", { name: "file-tree.tsx", exact: true }).first()
  await expect(file).toBeVisible()
  await hover(file)
  await file.click()

  const tab = page.getByRole("tab", { name: "file-tree.tsx" })
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(allTab).toHaveAttribute("aria-selected", "true")

  const viewer = page.locator('[data-component="file"][data-mode="text"]').first()
  await expect(viewer).toBeVisible()
  await expect(viewer).toContainText("export default function FileTree")
})
