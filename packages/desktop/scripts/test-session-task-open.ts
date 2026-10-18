import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[session-task-open-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-task-open-"))
  const slug = Buffer.from(directory).toString("base64url")
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory: string; sessionID: string } | undefined>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? { directory: tab.dataset.directory, sessionID: tab.dataset.sessionId } : undefined;
  })()`)
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const exists = (selector: string) => cdp.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  const click = async (selector: string) => {
    await wait(`click ${selector}`, () => exists(selector))
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const navigate = (dir: string, sessionID?: string) =>
    cdp.evaluate(`(async () => {
      const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
      handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${sessionID ?? ""}`)});
    })()`)
  const float = '[data-component="session-todo-float"]'
  const panel = '[data-component="session-project-task-mount"]'
  const openButton = '[data-action="session-project-task-open"]'
  const rail = `[data-action="project-switch"][aria-label=${JSON.stringify(basename(directory))}]`
  const menu = `[data-action="project-menu"][data-project="${slug}"]`
  const closeDialog = async () => {
    if (!(await exists("[data-project-task-dialog]"))) return
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[data-project-task-dialog]');
      const close = dialog.querySelector('[data-slot="dialog-close-button"]')
        ?? [...dialog.querySelectorAll('button')].find(b => /^(Close|关闭)$/.test(b.getAttribute('aria-label') || ''));
      if (!close) throw Error('dialog close button missing');
      close.click();
    })()`)
    await wait("detail closed", async () => !(await exists("[data-project-task-dialog]")))
  }
  let sessionID: string | undefined
  let taskID: string | undefined
  try {
    const task = await request("/project-task", "POST", {
      title: "QA mounted task detail",
      description: "Task detail button regression",
    })
    taskID = task.id
    const session = await request("/session", "POST", { title: "QA session task detail button" })
    sessionID = session.id
    const marker = "SESSION_TASK_OPEN_SIDECAR_OK"
    await request(`/session/${sessionID}/shell`, "POST", { agent: "build", command: `printf ${marker}` })
    const messages = await request(`/session/${sessionID}/message`)
    assert.ok(messages.some((m: any) => m.info.role === "user"))
    assert.ok(
      messages.some(
        (m: any) =>
          m.info.role === "assistant" &&
          m.parts.some(
            (p: any) => p.type === "tool" && p.state.status === "completed" && p.state.output.includes(marker),
          ),
      ),
    )
    log(`PASS real sidecar message sent and reply verified session=${sessionID}`)
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent("opencode:deep-link", {
      detail: { urls: [${JSON.stringify(`opencode://open-project?directory=${encodeURIComponent(directory)}`)}] }
    }))`)
    await navigate(directory, sessionID)
    await wait("test session active", () =>
      exists(`[data-component="session-tab"][data-active="true"][data-session-id="${sessionID}"]`),
    )
    await wait("test project rail", () => exists(rail))
    if (!(await exists(menu))) await click(rail)
    await click(`${float} > button`)
    await wait("unmounted panel", () => exists(panel))
    assert.equal(await exists(openButton), false)
    log("PASS no linked task hides detail button")
    await request(`/session/${sessionID}/project-task`, "PUT", { taskID })
    await wait("linked task button", () => exists(openButton))
    await wait("linked task title loaded", () =>
      cdp.evaluate(
        `document.querySelector('${panel} [data-slot="dropdown-menu-trigger"]')?.textContent.includes('QA mounted task detail') === true`,
      ),
    )
    const geometry = await cdp.evaluate<{ right: boolean; sameRow: boolean; label: string }>(`(() => {
      const button = document.querySelector('${openButton}');
      const trigger = document.querySelector('${panel} [data-slot="dropdown-menu-trigger"]');
      const a = button.getBoundingClientRect(), b = trigger.getBoundingClientRect();
      return { right: a.left >= b.right, sameRow: Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<2,
        label: button.getAttribute('aria-label') };
    })()`)
    assert.ok(geometry.right && geometry.sameRow)
    assert.ok(geometry.label)
    await cdp.call("Page.captureScreenshot").then(async (shot: any) => {
      await Bun.write("/tmp/opencode-session-task-open.png", Buffer.from(shot.data, "base64"))
    })
    for (let index = 0; index < 2; index++) {
      if (index) await click(`${float} > button`)
      await click(openButton)
      await wait("correct task detail", () => exists(`[data-project-task-dialog="${taskID}"]`))
      assert.equal(
        await cdp.evaluate(`document.querySelector('${float}')?.getAttribute('data-collapsed')`),
        "true",
        "task float closes before details open",
      )
      await closeDialog()
      log(`PASS linked task opens correct details attempt=${index + 1}`)
    }
    await click(`${float} > button`)
    await request(`/session/${sessionID}/project-task`, "DELETE")
    await wait("button hidden after unlink", async () => !(await exists(openButton)))
    log("PASS unlink hides button reactively")
    await click('[data-action="session-todo-float-close"]')
    await click('[data-action="session-new-button"]')
    await wait("new session route", () =>
      cdp.evaluate(
        `!!document.querySelector('[data-component="session-page"]') && !document.querySelector('[data-component="session-page"]').getAttribute('data-session-id')`,
      ),
    )
    await cdp.evaluate(`(async () => {
      const { setPendingProjectTaskMount } = await import(${JSON.stringify(`${source}/components/session/pending-project-task-mount.ts`)});
      setPendingProjectTaskMount(${JSON.stringify(directory)}, { taskID: ${JSON.stringify(taskID)}, inject: true });
    })()`)
    await click(`${float} > button`)
    await wait("pending linked task button", () => exists(openButton))
    await click(openButton)
    await wait("pending task details", () => exists(`[data-project-task-dialog="${taskID}"]`))
    await closeDialog()
    log("PASS new session pending selection opens details")
  } finally {
    await closeDialog()
    await cdp.evaluate(`(async () => {
      const { setPendingProjectTaskMount } = await import(${JSON.stringify(`${source}/components/session/pending-project-task-mount.ts`)});
      setPendingProjectTaskMount(${JSON.stringify(directory)}, { taskID: undefined });
    })()`)
    if (await exists('[data-action="session-todo-float-close"]'))
      await click('[data-action="session-todo-float-close"]')
    if (!(await exists(menu)) && (await exists(rail))) await click(rail)
    if (await exists(menu)) {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(menu)}).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }))`,
      )
      const closeProject = `[data-action="project-close-menu"][data-project="${slug}"]`
      await wait("close test project", () => exists(closeProject))
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(closeProject)}).dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }))`,
      )
    }
    if (sessionID) await request(`/session/${sessionID}`, "DELETE")
    if (taskID) await request(`/project-task/${taskID}`, "DELETE")
    if (previous?.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
    await rm(directory, { recursive: true, force: true })
    log("test data cleaned and previous session restored")
  }
})
