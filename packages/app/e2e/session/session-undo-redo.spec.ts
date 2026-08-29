import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { createSdk, modKey } from "../utils"
import { promptSelector } from "../selectors"

async function seedConversation(input: {
  page: Page
  sdk: ReturnType<typeof createSdk>
  sessionID: string
  token: string
}) {
  const messages = async () =>
    await input.sdk.session.messages({ sessionID: input.sessionID, limit: 100 }).then((r) => r.data ?? [])
  const seeded = await messages()
  const userIDs = new Set(seeded.filter((m) => m.info.role === "user").map((m) => m.info.id))

  const prompt = input.page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await input.sdk.session.promptAsync({
    sessionID: input.sessionID,
    noReply: true,
    parts: [{ type: "text", text: input.token }],
  })

  let userMessageID: string | undefined
  await expect
    .poll(
      async () => {
        const users = (await messages()).filter(
          (m) =>
            !userIDs.has(m.info.id) &&
            m.info.role === "user" &&
            m.parts.filter((p) => p.type === "text").some((p) => p.text.includes(input.token)),
        )
        if (users.length === 0) return false

        const user = users[users.length - 1]
        if (!user) return false
        userMessageID = user.info.id
        return true
      },
      { timeout: 90_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true)

  if (!userMessageID) throw new Error("Expected a user message id")
  await expect(input.page.locator(`[data-message-id="${userMessageID}"]`)).toHaveCount(1, { timeout: 30_000 })
  return { prompt, userMessageID }
}

test("slash undo sets revert and restores prior prompt", async ({ page, withProject }) => {
  test.setTimeout(120_000)

  const token = `undo_${Date.now()}`

  await withProject(async (project) => {
    const sdk = createSdk(project.directory)

    await withSession(sdk, `e2e undo ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)

      const seeded = await seedConversation({ page, sdk, sessionID: session.id, token })

      await seeded.prompt.click()
      await page.keyboard.type("/undo")

      const undo = page.locator('[data-slash-id="session.undo"]').first()
      await expect(undo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBe(seeded.userMessageID)

      await expect(seeded.prompt).toContainText(token)
      await expect(page.locator(`[data-message-id="${seeded.userMessageID}"]`)).toHaveCount(0)
    })
  })
})

test("slash redo clears revert and restores latest state", async ({ page, withProject }) => {
  test.setTimeout(120_000)

  const token = `redo_${Date.now()}`

  await withProject(async (project) => {
    const sdk = createSdk(project.directory)

    await withSession(sdk, `e2e redo ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)

      const seeded = await seedConversation({ page, sdk, sessionID: session.id, token })

      await seeded.prompt.click()
      await page.keyboard.type("/undo")

      const undo = page.locator('[data-slash-id="session.undo"]').first()
      await expect(undo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBe(seeded.userMessageID)

      await seeded.prompt.click()
      await page.keyboard.press(`${modKey}+A`)
      await page.keyboard.press("Backspace")
      await page.keyboard.type("/redo")

      const redo = page.locator('[data-slash-id="session.redo"]').first()
      await expect(redo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBeUndefined()

      await expect(seeded.prompt).not.toContainText(token)
      await expect(page.locator(`[data-message-id="${seeded.userMessageID}"]`)).toHaveCount(1)
    })
  })
})

test("slash undo/redo traverses multi-step revert stack", async ({ page, withProject }) => {
  test.setTimeout(120_000)

  const firstToken = `undo_redo_first_${Date.now()}`
  const secondToken = `undo_redo_second_${Date.now()}`

  await withProject(async (project) => {
    const sdk = createSdk(project.directory)

    await withSession(sdk, `e2e undo redo stack ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)

      const first = await seedConversation({
        page,
        sdk,
        sessionID: session.id,
        token: firstToken,
      })
      const second = await seedConversation({
        page,
        sdk,
        sessionID: session.id,
        token: secondToken,
      })

      expect(first.userMessageID).not.toBe(second.userMessageID)

      const firstMessage = page.locator(`[data-message-id="${first.userMessageID}"]`)
      const secondMessage = page.locator(`[data-message-id="${second.userMessageID}"]`)

      await expect(firstMessage).toHaveCount(1)
      await expect(secondMessage).toHaveCount(1)

      await second.prompt.click()
      await page.keyboard.press(`${modKey}+A`)
      await page.keyboard.press("Backspace")
      await page.keyboard.type("/undo")

      const undo = page.locator('[data-slash-id="session.undo"]').first()
      await expect(undo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBe(second.userMessageID)

      await expect(firstMessage).toHaveCount(1)
      await expect(secondMessage).toHaveCount(0)

      await second.prompt.click()
      await page.keyboard.press(`${modKey}+A`)
      await page.keyboard.press("Backspace")
      await page.keyboard.type("/undo")
      await expect(undo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBe(first.userMessageID)

      await expect(firstMessage).toHaveCount(0)
      await expect(secondMessage).toHaveCount(0)

      await second.prompt.click()
      await page.keyboard.press(`${modKey}+A`)
      await page.keyboard.press("Backspace")
      await page.keyboard.type("/redo")

      const redo = page.locator('[data-slash-id="session.redo"]').first()
      await expect(redo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBe(second.userMessageID)

      await expect(firstMessage).toHaveCount(1)
      await expect(secondMessage).toHaveCount(0)

      await second.prompt.click()
      await page.keyboard.press(`${modKey}+A`)
      await page.keyboard.press("Backspace")
      await page.keyboard.type("/redo")
      await expect(redo).toBeVisible()
      await page.keyboard.press("Enter")

      await expect
        .poll(async () => await sdk.session.get({ sessionID: session.id }).then((r) => r.data?.revert?.messageID), {
          timeout: 30_000,
        })
        .toBeUndefined()

      await expect(firstMessage).toHaveCount(1)
      await expect(secondMessage).toHaveCount(1)
    })
  })
})

test("reverted messages stay removed after a new prompt and session switch", async ({ page, withProject }) => {
  test.setTimeout(120_000)

  const firstToken = `revert_switch_first_${Date.now()}`
  const removedToken = `revert_switch_removed_${Date.now()}`
  const laterRemovedToken = `revert_switch_later_removed_${Date.now()}`
  const replacementToken = `revert_switch_replacement_${Date.now()}`
  const revertEvents: string[] = []
  let targetSessionID: string | undefined
  let consoleEvents = Promise.resolve()

  page.on("console", (message) => {
    consoleEvents = consoleEvents.then(async () => {
      const text = message.text()
      if (!text.includes("session-revert-sync") && !text.includes("prompt-submit")) return
      console.log(`[revert-switch-browser] ${text}`)
      if (!text.includes("session-revert-sync")) return
      const value = await message.args()[1]?.jsonValue().catch(() => undefined)
      if (value?.stage !== "event-received" || value.sessionID !== targetSessionID || typeof value.type !== "string") return
      revertEvents.push(value.type)
    })
  })

  await withProject(async (project) => {
    const sdk = createSdk(project.directory)

    await withSession(sdk, `e2e revert switch target ${Date.now()}`, async (target) => {
      targetSessionID = target.id
      await withSession(sdk, `e2e revert switch other ${Date.now()}`, async (other) => {
        await project.gotoSession(target.id)

        const first = await seedConversation({ page, sdk, sessionID: target.id, token: firstToken })
        const removed = await seedConversation({ page, sdk, sessionID: target.id, token: removedToken })
        const laterRemoved = await seedConversation({ page, sdk, sessionID: target.id, token: laterRemovedToken })
        const removedIDs = [removed.userMessageID, laterRemoved.userMessageID]
        const removedMessages = removedIDs.map((id) => page.locator(`[data-message-id="${id}"]`))

        await sdk.session.revert({ sessionID: target.id, messageID: removed.userMessageID })
        await expect
          .poll(() => sdk.session.get({ sessionID: target.id }).then((result) => result.data?.revert?.messageID), {
            timeout: 30_000,
          })
          .toBe(removed.userMessageID)
        await expect(page.locator(`[data-message-id="${first.userMessageID}"]`)).toHaveCount(1)
        for (const message of removedMessages) await expect(message).toHaveCount(0)

        await sdk.session.promptAsync({
          sessionID: target.id,
          noReply: true,
          parts: [{ type: "text", text: replacementToken }],
        })
        await expect
          .poll(() => sdk.session.get({ sessionID: target.id }).then((result) => result.data?.revert?.messageID), {
            timeout: 30_000,
          })
          .toBeUndefined()
        await expect
          .poll(
            () =>
              sdk.session
                .messages({ sessionID: target.id, limit: 100 })
                .then((result) => result.data?.some((item) => removedIDs.includes(item.info.id)) ?? false),
            { timeout: 30_000 },
          )
          .toBe(false)
        await expect
          .poll(async () => {
            await consoleEvents
            return revertEvents.slice(-3)
          }, { timeout: 30_000 })
          .toEqual(["message.removed", "message.removed", "session.updated"])
        for (const message of removedMessages) await expect(message).toHaveCount(0)

        await project.gotoSession(other.id)
        await expect(page.locator(promptSelector)).toBeVisible()
        await project.gotoSession(target.id)
        await expect(page.locator(promptSelector)).toBeVisible()

        for (const message of removedMessages) await expect(message).toHaveCount(0)
        await expect(page.getByText(removedToken, { exact: true })).toHaveCount(0)
        await expect(page.getByText(laterRemovedToken, { exact: true })).toHaveCount(0)
        await expect(page.getByText(replacementToken, { exact: true })).toHaveCount(1)
      })
    })
  })
})
