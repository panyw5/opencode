import { expect, chromium } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"

const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const base = Bun.env.MENU_INTERACT_BASE_URL ?? "http://127.0.0.1:4467"
const directory = Bun.env.MENU_INTERACT_DIRECTORY ?? root
const backend = Bun.env.MENU_INTERACT_SERVER ?? "http://127.0.0.1:4098"
const log = (message: string) => console.info(`[menu-real] ${message}`)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on("console", (message) => {
  if (/theme-applied/.test(message.text())) log(message.text())
})

async function closeMenus() {
  // Move away before releasing so a pending press cannot select an action.
  await page.mouse.move(1, 1)
  await page.mouse.up()
  await page.keyboard.press("Escape")
  await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
}

async function checkMenu(label: string, open: () => Promise<unknown>, kind: "context" | "dropdown") {
  await closeMenus()
  await open()
  const menu = page.locator(`[data-component="${kind}-menu-content"]:visible`).last()
  await expect(menu).toBeVisible()
  const candidate = menu.locator(`[data-slot="${kind}-menu-item"]:not([data-disabled]):not([data-highlighted])`).first()
  await expect(candidate).toBeVisible()
  const index = await candidate.evaluate((el) =>
    [
      ...el.parentElement!.querySelectorAll(`[data-slot="${el.getAttribute("data-slot")}"]:not([data-disabled])`),
    ].indexOf(el),
  )
  const item = menu.locator(`[data-slot="${kind}-menu-item"]:not([data-disabled])`).nth(index)
  await expect(item).toBeVisible()
  const read = () =>
    item.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      shadow: getComputedStyle(el).boxShadow,
      duration: getComputedStyle(el).transitionDuration,
    }))
  const panel = await menu.boundingBox()
  if (!panel) throw new Error(`Missing ${label} panel`)
  // Keep the pointer inside the portal: hovering another project rail entry
  // can legitimately change the sidebar and unmount its context menu.
  await page.mouse.move(panel.x + 2, panel.y + 2)
  await item.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
  const rest = await read()
  await item.hover()
  await item.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
  const hover = await read()
  expect(hover.bg, `${label} hover`).not.toBe(rest.bg)
  expect(hover.shadow, `${label} hover edge`).not.toBe("none")
  await page.mouse.down()
  try {
    const pressed = await read()
    expect(pressed.bg, `${label} pressed`).not.toBe(hover.bg)
    expect(pressed.duration.split(",").every((duration) => Number.parseFloat(duration) === 0)).toBe(true)
    log(`${label} rest=${rest.bg} hover=${hover.bg} pressed=${pressed.bg}`)
    await menu.screenshot({ path: `/tmp/opencode-menu-${label}.png`, animations: "disabled" })
  } finally {
    await closeMenus()
  }
  await open()
  const reopened = page.locator(`[data-component="${kind}-menu-content"]:visible`).last()
  await expect(reopened).toBeVisible()
  await reopened.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
  await reopened.press("Home")
  const highlighted = reopened.locator("[data-highlighted]:not([data-disabled])").first()
  await expect(highlighted).toBeVisible()
  await expect(highlighted).toHaveCSS("box-shadow", /inset/)
  log(`${label} keyboard highlight verified`)
  await closeMenus()
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => !!document.getElementById("oc-theme")?.textContent)
  const source = await page.evaluate(() =>
    [...document.querySelectorAll("style[data-vite-dev-id]")]
      .map((el) => el.getAttribute("data-vite-dev-id"))
      .find((path) => path?.endsWith("/packages/app/src/index.css")),
  )
  expect(source, "actual Vite workspace").toBe(`${root}/packages/app/src/index.css`)
  await page.addStyleTag({
    content: await readFile(new URL("../../desktop/src/renderer/popup-surfaces.css", import.meta.url), "utf8"),
  })
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "desktop"
    document.documentElement.dataset.os = "macos"
  })
  const project = page.locator('[data-action="project-switch"]').first()
  if (!(await project.count())) {
    const input = page.locator('[data-component="home-path-input"] input')
    await expect(input).toBeVisible()
    await input.fill(directory)
    await input.press("Enter")
  }
  await expect(project).toBeVisible({ timeout: 30000 })
  await expect(page.locator('[data-component="sidebar-session-loading"]')).toHaveCount(0, { timeout: 30000 })
  // Workspace bootstrap can replace the project rail while its children load.
  await page.waitForTimeout(1500)
  for (const mode of ["light", "dark"] as const) {
    const expected = resolveThemeVariant(DEFAULT_THEMES.claude[mode], mode === "dark")
    await page.evaluate((mode) => {
      window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: mode }))
      window.dispatchEvent(new StorageEvent("storage", { key: "opencode-theme-id", newValue: "claude" }))
    }, mode)
    await page.waitForFunction(
      ({ mode, ink }) => {
        const root = document.documentElement
        return (
          root.dataset.theme === "claude" &&
          root.dataset.colorScheme === mode &&
          getComputedStyle(root).getPropertyValue("--text-strong").trim().toLowerCase() === ink.toLowerCase()
        )
      },
      { mode, ink: expected["text-strong"] },
    )
    await checkMenu(`project-claude-${mode}`, () => project.click({ button: "right" }), "context")
    const dropdown = page.locator('[data-action="session-new-project-menu"]')
    await checkMenu(`project-dropdown-claude-${mode}`, () => dropdown.click(), "dropdown")
  }
  // Create only an isolated, empty session; no model request is sent.
  const response = await fetch(`${backend}/session?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Menu feedback QA (empty)" }),
  })
  if (!response.ok) throw new Error(`Create QA session: ${response.status}`)
  const session = (await response.json()) as { id: string }
  try {
    await page.goto(`${base}/${Buffer.from(directory).toString("base64url")}/session/${session.id}`)
    const tab = page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`).first()
    await expect(tab).toBeVisible({ timeout: 30000 })
    await page.addStyleTag({
      content: await readFile(new URL("../../desktop/src/renderer/popup-surfaces.css", import.meta.url), "utf8"),
    })
    await page.evaluate(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: "dark" }))
      window.dispatchEvent(new StorageEvent("storage", { key: "opencode-theme-id", newValue: "claude" }))
    })
    await page.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue("--text-strong").trim() === "#f4f3ef",
    )
    await checkMenu("session-tab-claude-dark", () => tab.click({ button: "right" }), "context")
    // Existing safe menu action: open the title editor, then cancel it.
    await tab.click({ button: "right" })
    await page.locator('[data-component="context-menu-content"] [data-action="session-tab-edit-title"]').click()
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await page.keyboard.press("Escape")
    log("session tab click opens title editor; cancelled without changes")

    const filesToggle = page.getByRole("button", { name: "Toggle file tree", exact: true })
    await expect(filesToggle).toBeVisible()
    if ((await filesToggle.getAttribute("aria-expanded")) !== "true") await filesToggle.click()
    const tree = page.locator("#file-tree-panel")
    await expect(tree).toBeVisible()
    const all = tree.getByRole("tab", { name: /^All files$/i })
    await all.click()
    const file = tree.getByRole("button", { name: "CLAUDE.md", exact: true }).first()
    await expect(file).toBeVisible({ timeout: 30000 })
    await file.click()
    const fileTab = page.getByRole("tab", { name: "CLAUDE.md", exact: true })
    await expect(fileTab).toBeVisible()
    await checkMenu("file-tab-claude-dark", () => fileTab.click({ button: "right" }), "context")

    // Track only PTYs created by this page, never delete terminals created by
    // another concurrently running user/session.
    const createdPTYs: Array<Promise<string | undefined>> = []
    const trackPTY = (response: import("@playwright/test").Response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/pty") return
      createdPTYs.push(response.json().then((pty: { id?: string }) => pty.id))
    }
    page.on("response", trackPTY)
    try {
      const toggle = page.locator('[aria-controls="terminal-panel"]')
      await expect(toggle).toBeVisible()
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
      const terminal = page.locator('#terminal-panel [data-slot="tabs-trigger"]').first()
      await expect(terminal).toBeVisible({ timeout: 30000 })
      await checkMenu("terminal-tab-claude-dark", () => terminal.click({ button: "right" }), "dropdown")
    } finally {
      page.off("response", trackPTY)
      for (const id of await Promise.all(createdPTYs)) {
        if (!id) throw new Error("Missing created QA terminal ID")
        const cleanup = await fetch(`${backend}/pty/${id}?directory=${encodeURIComponent(directory)}`, {
          method: "DELETE",
        })
        if (!cleanup.ok) throw new Error(`Cleanup QA terminal: ${cleanup.status}`)
        log(`removed QA terminal ${id}`)
      }
    }
  } finally {
    const cleanup = await fetch(`${backend}/session/${session.id}?directory=${encodeURIComponent(directory)}`, {
      method: "DELETE",
    })
    if (!cleanup.ok) throw new Error(`Cleanup QA session: ${cleanup.status}`)
    log(`removed isolated empty QA session ${session.id}`)
  }
  log("PASS real project, dropdown, session/file/terminal-tab mouse and keyboard feedback")
} finally {
  await browser.close()
}
