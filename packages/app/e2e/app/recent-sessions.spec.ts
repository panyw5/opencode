import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { cleanupTestProject, createTestProject, openPalette } from "../actions"
import { createSdk } from "../utils"

test("recent sessions include nested directories across projects", async ({ page, withProject }) => {
  const other = await createTestProject()
  const logs: string[] = []
  page.on("console", (message) => {
    const text = message.text()
    if (!text.includes("[recent-sessions]")) return
    logs.push(text)
    console.log(text)
  })

  try {
    await withProject(
      async ({ directory, trackSession }) => {
        const nested = path.join(directory, "packages", "nested")
        await fs.mkdir(nested, { recursive: true })

        const otherSession = await createSdk(other).session.create({ title: "Recent other project" })
        const nestedSession = await createSdk(nested).session.create({ title: "Recent nested project" })
        if (!otherSession.data || !nestedSession.data) throw new Error("Failed to create recent-session fixtures")
        trackSession(otherSession.data.id, other)
        trackSession(nestedSession.data.id, nested)

        const palette = await openPalette(page, "Shift+P")
        await palette.getByRole("textbox").fill("Recent sessions")
        await palette.getByText("Recent sessions", { exact: true }).click()

        const dialog = page.getByRole("dialog")
        await expect(dialog.getByText("Recent other project", { exact: true })).toBeVisible()
        await expect(dialog.getByText("Recent nested project", { exact: true })).toBeVisible()
        await expect(
          dialog.getByRole("button", { name: new RegExp(`Recent nested project ${path.basename(directory)}`) }),
        ).toBeVisible()
        expect(logs.some((line) => line.includes(`load success sessions=`))).toBe(true)
        expect(logs.some((line) => line.includes(`:${nested}:`))).toBe(true)
        expect(logs.some((line) => line.includes(`:${other}:`))).toBe(true)
      },
      { extra: [other] },
    )
  } finally {
    await cleanupTestProject(other)
  }
})
