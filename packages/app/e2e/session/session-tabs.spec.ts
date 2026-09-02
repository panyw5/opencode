import { test, expect } from "../fixtures"
import { cleanupSession, sessionIDFromUrl, withSession } from "../actions"
import { projectSwitchSelector, promptSelector, sessionItemSelector, sessionNewButtonSelector } from "../selectors"
import { dirSlug, sessionPath } from "../utils"

type TabPermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

async function withMockTabPermissions<T>(
  page: any,
  initial: TabPermissionRequest[],
  fn: (state: { loaded: () => Promise<void>; replies: () => Array<{ id: string; response: string }> }) => Promise<T>,
  options?: { sessions?: any[] },
) {
  let pending = initial
  let listRequests = 0
  const responses: Array<{ id: string; response: string }> = []
  const permissionListPattern = /\/permission(?:\?|$)/
  const list = async (route: any) => {
    listRequests += 1
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pending) })
  }
  const reply = async (route: any) => {
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? ""
    responses.push({ id, response: route.request().postDataJSON()?.response ?? "" })
    pending = pending.filter((item) => item.id !== id)
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(true) })
  }
  const sessionList = options?.sessions?.length
    ? async (route: any) => {
        const response = await route.fetch()
        const json = await response.json()
        const sessions = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : undefined
        if (sessions) {
          for (const session of options.sessions ?? []) {
            if (!sessions.some((item: any) => item?.id === session.id)) sessions.push(session)
          }
        }
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          contentType: "application/json",
          body: JSON.stringify(json),
        })
      }
    : undefined

  await page.route(permissionListPattern, list)
  await page.route("**/session/*/permissions/*", reply)
  if (sessionList) await page.route("**/session?*", sessionList)
  try {
    return await fn({
      loaded: () => expect.poll(() => listRequests).toBeGreaterThan(0),
      replies: () => responses,
    })
  } finally {
    await page.unroute(permissionListPattern, list)
    await page.unroute("**/session/*/permissions/*", reply)
    if (sessionList) await page.unroute("**/session?*", sessionList)
  }
}

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

      await page.evaluate((href) => {
        const anchor = document.createElement("a")
        anchor.href = href
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      }, sessionPath(target.directory, target.id))
      await expect(page).toHaveURL(new RegExp(`/session/${target.id}(?:[?#]|$)`))
      await expect(draft).toBeVisible()
      await expect(draft).not.toHaveAttribute("data-active", "true")

      await draft.click()
      await expect(page).toHaveURL(/\/session(?:[?#]|$)/)
      await expect(page.locator(promptSelector)).toContainText("draft should remain visible")
    })
  })
})

test("an id-less session URL does not create a draft", async ({ page, directory, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  void gotoSession

  await page.goto(sessionPath(directory))

  await expect(page).toHaveURL(new RegExp(`/${dirSlug(directory)}(?:[?#]|$)`))
  await expect(page.locator('[data-component="session-tab"][data-draft="true"]')).toHaveCount(0)
})

test("new session draft tab closes after the first message creates a session", async ({ page, sdk, gotoSession }) => {
  const logs: string[] = []
  page.on("console", (message) => {
    const text = message.text()
    if (text.includes("[session-tabs]") || text.includes("[session-bar]")) logs.push(text)
  })
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`))
  await page.setViewportSize({ width: 1400, height: 800 })
  await gotoSession()

  const draft = page.locator('[data-component="session-tab"][data-draft="true"]')
  await expect(draft).toBeVisible()

  await page.locator(promptSelector).fill(`e2e promote draft ${Date.now()}`)
  await page.keyboard.press("Enter")

  await expect
    .poll(() => sessionIDFromUrl(page.url()) ?? "", { timeout: 30_000, message: logs.join("\n") })
    .not.toBe("")
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

test("cold start reconciliation removes an archived persisted tab", async ({ page, sdk, gotoSession, directory }) => {
  await withSession(sdk, `e2e cold reconcile ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate((sessionID) => {
          const value = localStorage.getItem("opencode.global.dat:layout")
          if (!value) return false
          const parsed = JSON.parse(value) as { sessionBar?: { all?: Array<{ id?: string }> } }
          return parsed.sessionBar?.all?.some((tab) => tab.id === sessionID) ?? false
        }, session.id),
      )
      .toBe(true)

    const context = page.context()
    await page.close()
    await sdk.session.update({ sessionID: session.id, time: { archived: Date.now() } })

    const restoredPage = await context.newPage()
    const logs: string[] = []
    restoredPage.on("console", (message) => {
      const text = message.text()
      if (text.includes("[session-tabs]")) logs.push(text)
    })
    restoredPage.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`))
    await restoredPage.goto(sessionPath(directory))

    await expect
      .poll(() => logs.some((entry) => entry.includes("reconcile committed")), { message: logs.join("\n") })
      .toBe(true)
    await expect(
      restoredPage.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`),
    ).toHaveCount(0)
    await restoredPage.close()
  })
})

test("cold start reconciliation removes a deleted persisted tab", async ({ page, sdk, gotoSession, directory }) => {
  await withSession(sdk, `e2e deleted reconcile ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate((sessionID) => {
          const value = localStorage.getItem("opencode.global.dat:layout")
          if (!value) return false
          const parsed = JSON.parse(value) as { sessionBar?: { all?: Array<{ id?: string }> } }
          return parsed.sessionBar?.all?.some((tab) => tab.id === sessionID) ?? false
        }, session.id),
      )
      .toBe(true)

    const context = page.context()
    await page.close()
    await sdk.session.delete({ sessionID: session.id })

    const restoredPage = await context.newPage()
    const logs: string[] = []
    restoredPage.on("console", (message) => {
      const text = message.text()
      if (text.includes("[session-tabs]")) logs.push(text)
    })
    await restoredPage.goto(sessionPath(directory))

    await expect
      .poll(() => logs.some((entry) => entry.includes("status=404")), { message: logs.join("\n") })
      .toBe(true)
    await expect(
      restoredPage.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`),
    ).toHaveCount(0)
    await restoredPage.close()
  })
})

test("cold start reconciliation retains a tab when verification fails", async ({ page, sdk, gotoSession, directory }) => {
  await withSession(sdk, `e2e reconcile failure ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`)).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate((sessionID) => {
          const value = localStorage.getItem("opencode.global.dat:layout")
          if (!value) return false
          const parsed = JSON.parse(value) as { sessionBar?: { all?: Array<{ id?: string }> } }
          return parsed.sessionBar?.all?.some((tab) => tab.id === sessionID) ?? false
        }, session.id),
      )
      .toBe(true)

    const context = page.context()
    await page.close()
    const restoredPage = await context.newPage()
    const logs: string[] = []
    const failVerification = async (route: any) => {
      await route.fulfill({ status: 418, contentType: "application/json", body: JSON.stringify({ error: "offline" }) })
    }
    restoredPage.on("console", (message) => {
      const text = message.text()
      if (text.includes("[session-tabs]")) logs.push(text)
    })
    restoredPage.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`))
    await restoredPage.route(`**/session/${session.id}`, failVerification)
    try {
      await restoredPage.bringToFront()
      await restoredPage.goto(sessionPath(directory))
      await expect(
        restoredPage.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`),
      ).toBeVisible()
      await expect
        .poll(() => logs.some((entry) => entry.includes("persisted reconcile requested")), { message: logs.join("\n") })
        .toBe(true)
      await expect(
        restoredPage.locator(`[data-component="session-tab"][data-session-id="${session.id}"]`),
      ).toBeVisible()
    } finally {
      await restoredPage.unroute(`**/session/${session.id}`, failVerification)
      await restoredPage.close()
    }
  })
})

test("closing the active session tab commits after routing to its neighbor", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e close active first ${Date.now()}`, async (first) => {
    await withSession(sdk, `e2e close active second ${Date.now()}`, async (second) => {
      await gotoSession(first.id)
      await gotoSession(second.id)

      const firstTab = page.locator(`[data-component="session-tab"][data-session-id="${first.id}"]`)
      const secondTab = page.locator(`[data-component="session-tab"][data-session-id="${second.id}"]`)
      await expect(firstTab).toBeVisible()
      await expect(secondTab).toHaveAttribute("data-active", "true")

      await secondTab.locator('[data-action="session-tab-close"]').click()
      await expect.poll(() => sessionIDFromUrl(page.url())).toBe(first.id)
      await expect(secondTab).toHaveCount(0)
      await expect(firstTab).toHaveAttribute("data-active", "true")
    })
  })
})

test("closing a background session tab does not change the active route", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e close background first ${Date.now()}`, async (first) => {
    await withSession(sdk, `e2e close background second ${Date.now()}`, async (second) => {
      await gotoSession(first.id)
      await gotoSession(second.id)

      const firstTab = page.locator(`[data-component="session-tab"][data-session-id="${first.id}"]`)
      const secondTab = page.locator(`[data-component="session-tab"][data-session-id="${second.id}"]`)
      await firstTab.locator('[data-action="session-tab-close"]').click()

      await expect(firstTab).toHaveCount(0)
      await expect.poll(() => sessionIDFromUrl(page.url())).toBe(second.id)
      await expect(secondTab).toHaveAttribute("data-active", "true")
    })
  })
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

test("session tab permission capsule can view, allow once, and reject", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e permission tab ${Date.now()}`, async (requested) => {
    await withSession(sdk, `e2e permission tab current ${Date.now()}`, async (current) => {
      const permission = {
        id: "per_e2e_session_tab",
        sessionID: requested.id,
        permission: "bash",
        patterns: ["/tmp/opencode-e2e-session-tab"],
        always: ["*"],
        metadata: { description: "Need tab permission" },
      }
      let pending = [permission]
      let response = ""
      let listRequests = 0
      const permissionListPattern = /\/permission(?:\?|$)/
      const permissionLogs: string[] = []
      const logPermission = (message: { text(): string }) => {
        const text = message.text()
        if (text.includes("[session-tab-permission]")) permissionLogs.push(text)
      }
      const logPermissionRequest = (request: { url(): string; method(): string }) => {
        if (request.url().includes("permission")) {
          permissionLogs.push(`[e2e] request ${request.method()} ${request.url()}`)
        }
      }
      const list = async (route: any) => {
        listRequests += 1
        permissionLogs.push(`[e2e] permission list ${route.request().method()} ${route.request().url()}`)
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pending) })
      }
      const reply = async (route: any) => {
        response = route.request().postDataJSON()?.response ?? ""
        pending = []
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(true) })
      }

      await gotoSession(requested.id)
      await gotoSession(current.id)
      await page.route(permissionListPattern, list)
      await page.route("**/session/*/permissions/*", reply)
      page.on("console", logPermission)
      page.on("request", logPermissionRequest)
      try {
        await page.reload()
        await expect.poll(() => listRequests, { message: permissionLogs.join("\n") }).toBeGreaterThan(0)

        const capsule = page.locator('[data-component="session-tab-permission-capsule"]')
        await expect(capsule, permissionLogs.join("\n")).toBeVisible()
        await expect(capsule).toHaveAttribute("data-session-id", requested.id)
        await expect(capsule).toHaveAttribute("data-state", "open")
        await expect(capsule).toHaveAttribute("data-positioned", "true")
        await expect(capsule.getByRole("button", { name: /allow once/i })).toBeVisible()
        await expect(capsule.getByRole("button", { name: /deny/i })).toBeVisible()
        await expect
          .poll(() => capsule.evaluate((element) => getComputedStyle(element).animationName))
          .toBe("session-tab-permission-enter")
        await page.emulateMedia({ reducedMotion: "reduce" })
        await expect
          .poll(() => capsule.evaluate((element) => getComputedStyle(element).animationDuration))
          .toBe("0.16s")
        for (const scheme of ["light", "dark"] as const) {
          const colors = await capsule.evaluate((element, colorScheme) => {
            document.documentElement.dataset.colorScheme = colorScheme
            return {
              capsule: getComputedStyle(element).backgroundColor,
              session: getComputedStyle(document.querySelector("main")!).backgroundColor,
            }
          }, scheme)
          expect(colors.capsule).not.toBe(colors.session)
        }
        const requestedTab = page.locator(`[data-component="session-tab"][data-session-id="${requested.id}"]`)
        const [tabBox, capsuleBox] = await Promise.all([requestedTab.boundingBox(), capsule.boundingBox()])
        expect(tabBox).not.toBeNull()
        expect(capsuleBox).not.toBeNull()
        expect(capsuleBox!.y).toBeGreaterThanOrEqual(tabBox!.y + tabBox!.height)
        expect(capsuleBox!.x + capsuleBox!.width).toBeLessThanOrEqual(1400)

        await capsule.getByRole("button", { name: /view/i }).click()
        await expect(page).toHaveURL(new RegExp(`/session/${requested.id}(?:[?#]|$)`))

        const closeAnimation = page.evaluate(() => {
          const element = document.querySelector('[data-component="session-tab-permission-capsule"]')
          if (!element) throw new Error("Permission capsule not found before close")
          return new Promise<string>((resolve) => {
            const observer = new MutationObserver(() => {
              if (element.getAttribute("data-state") !== "closing") return
              observer.disconnect()
              resolve(getComputedStyle(element).animationName)
            })
            observer.observe(element, { attributes: true, attributeFilter: ["data-state"] })
          })
        })
        await capsule.getByRole("button", { name: /allow once/i }).click()
        await expect.poll(() => response).toBe("once")
        expect(await closeAnimation).toBe("session-tab-permission-exit")
        await expect(capsule).toHaveCount(0)

        response = ""
        pending = [{ ...permission, id: "per_e2e_session_tab_reject" }]
        await page.reload()
        await expect(capsule).toBeVisible()
        await capsule.getByRole("button", { name: /deny/i }).click()
        await expect.poll(() => response).toBe("reject")
        await expect(capsule).toHaveCount(0)
      } finally {
        await page.unroute(permissionListPattern, list)
        await page.unroute("**/session/*/permissions/*", reply)
        page.off("console", logPermission)
        page.off("request", logPermissionRequest)
      }
    })
  })
})

test("multiple session permission capsules stack without overlap", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e permission stack first ${Date.now()}`, async (first) => {
    await withSession(sdk, `e2e permission stack second ${Date.now()}`, async (second) => {
      await withSession(sdk, `e2e permission stack current ${Date.now()}`, async (current) => {
        await gotoSession(first.id)
        await gotoSession(second.id)
        await gotoSession(current.id)

        const request = (id: string, sessionID: string): TabPermissionRequest => ({
          id,
          sessionID,
          permission: "bash",
          patterns: [`/tmp/${id}`],
          always: ["*"],
          metadata: { description: `Need permission for ${sessionID}` },
        })

        await withMockTabPermissions(
          page,
          [request("per_e2e_stack_first", first.id), request("per_e2e_stack_second", second.id)],
          async (state) => {
            await page.reload()
            await state.loaded()

            const capsules = page.locator('[data-component="session-tab-permission-capsule"]')
            await expect(capsules).toHaveCount(2)
            const firstByID = page.locator(
              `[data-component="session-tab-permission-capsule"][data-session-id="${first.id}"]`,
            )
            const secondByID = page.locator(
              `[data-component="session-tab-permission-capsule"][data-session-id="${second.id}"]`,
            )
            await expect(firstByID).toBeVisible()
            await expect(secondByID).toBeVisible()

            const boxes = await Promise.all([firstByID.boundingBox(), secondByID.boundingBox()])
            expect(boxes[0]).not.toBeNull()
            expect(boxes[1]).not.toBeNull()
            const ordered = boxes.map((box) => box!).sort((a, b) => a.y - b.y)
            expect(ordered[0].y + ordered[0].height).toBeLessThanOrEqual(ordered[1].y)
          },
        )
      })
    })
  })
})

test("child permission is exposed from the visible parent session tab", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  await withSession(sdk, `e2e permission parent ${Date.now()}`, async (parent) => {
    await withSession(sdk, `e2e permission parent current ${Date.now()}`, async (current) => {
      const child = await sdk.session
        .create({ title: `e2e permission child ${Date.now()}`, parentID: parent.id })
        .then((result) => result.data)
      if (!child?.id) throw new Error("Child session create did not return an id")

      try {
        await gotoSession(parent.id)
        await gotoSession(current.id)

        await withMockTabPermissions(
          page,
          [
            {
              id: "per_e2e_child_tab",
              sessionID: child.id,
              permission: "bash",
              patterns: ["/tmp/opencode-e2e-child-tab"],
              always: ["*"],
              metadata: { description: "Need child permission" },
            },
          ],
          async (state) => {
            await page.reload()
            await state.loaded()

            const parentTab = page.locator(`[data-component="session-tab"][data-session-id="${parent.id}"]`)
            const capsule = page.locator(
              `[data-component="session-tab-permission-capsule"][data-session-id="${child.id}"]`,
            )
            await expect(parentTab).toHaveAttribute("data-permission", "true")
            await expect(capsule).toBeVisible()

            await capsule.getByRole("button", { name: /view/i }).click()
            await expect(page).toHaveURL(new RegExp(`/session/${parent.id}(?:[?#]|$)`))
            await capsule.getByRole("button", { name: /deny/i }).click()
            await expect.poll(() => state.replies()).toContainEqual({ id: "per_e2e_child_tab", response: "reject" })
          },
          { sessions: [child] },
        )
      } finally {
        await cleanupSession({ sdk, sessionID: child.id })
      }
    })
  })
})
