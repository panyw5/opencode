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
  const pointerClick = async (selector: string) => {
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw Error('Missing pointer target');
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
  }
  const navigate = (dir: string, sessionID?: string) =>
    cdp.evaluate(`window.__sessionTaskOpenNavigation = (async () => {
      const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
      handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${sessionID ?? ""}`)});
    })()`)
  const float = '[data-component="session-status-float"]'
  const panel = '[data-component="session-project-task-mount"]'
  const openButton = '[data-action="session-project-task-open"]'
  const rail = `[data-action="project-switch"][aria-label=${JSON.stringify(basename(directory))}]`
  const menu = `[data-action="project-menu"][data-project="${slug}"]`
  const expandedRail = '[data-action="project-switch"][data-sidebar-expanded="true"]'
  const sidebarKeybind = await cdp.evaluate<string>(`(async () => {
    const settings = JSON.parse(await window.api.storeGet("default.dat", "settings.v3") || "{}");
    return settings.keybinds?.["sidebar.toggle"] ?? "mod+b";
  })()`)
  assert.notEqual(sidebarKeybind, "none", "sidebar toggle must be bound for the shortcut regression")
  const toggleSidebar = async () => {
    const parts = sidebarKeybind.toLowerCase().split("+")
    const key = parts.pop()!
    const modifiers =
      (parts.includes("mod") || parts.includes("meta") ? 4 : 0) |
      (parts.includes("ctrl") ? 2 : 0) |
      (parts.includes("shift") ? 8 : 0) |
      (parts.includes("alt") ? 1 : 0)
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers })
  }
  const peekOtherProject = async () => {
    if (await exists(expandedRail)) await click(expandedRail)
    const other = await cdp.evaluate<string>(`(() => {
      const rail = [...document.querySelectorAll('[data-action="project-switch"]')]
        .find(el => el.getAttribute('data-project') !== ${JSON.stringify(slug)});
      if (!rail) throw Error('another project is required for the temporary preview regression');
      return '[data-action="project-switch"][data-project="' + rail.getAttribute('data-project') + '"]';
    })()`)
    await click(other)
    await wait("other project preview", () => exists(`${other}[data-sidebar-expanded="true"]`))
    assert.ok(await exists(`[data-component="session-tab"][data-active="true"][data-session-id="${sessionID}"]`))
    await click(other)
    await wait("preview closed", async () => !(await exists(expandedRail)))
    log("PASS previewing another project leaves the current session unchanged")
  }
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
    const surface = await cdp.evaluate<{ border: string; shadow: string; outline: string }>(`(() => {
      const content = document.querySelector('[data-slot="session-status-float-panel"]').closest('[data-component="popover-content"]');
      const style = getComputedStyle(content);
      return { border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle };
    })()`)
    log(`status surface border=${surface.border} shadow=${surface.shadow} outline=${surface.outline}`)
    assert.equal(surface.border, "1px")
    assert.equal(surface.outline, "none")
    assert.equal(surface.shadow.includes("inset"), false, "status surface must not double its border with inset rings")
    assert.notEqual(surface.shadow, "none", "status surface retains its outer shadow")
    assert.ok(await cdp.evaluate(`(() => {
      const context = document.querySelector('[data-component="session-context-usage-panel"]');
      const task = document.querySelector('${panel}');
      return !!context && !!task && context.getBoundingClientRect().bottom <= task.getBoundingClientRect().top;
    })()`), "context usage appears above project task association")
    log("PASS context usage appears before project task association")
    assert.equal(await exists(openButton), false)
    assert.equal(await exists(`${panel} input[type="checkbox"]`), false, "context injection option removed")
    assert.equal(await exists('[data-component="session-todo-float"]'), false, "standalone task capsule removed")
    const contextToggle = '[data-action="session-context-details-toggle"]'
    assert.equal(
      await cdp.evaluate(`document.querySelector('${contextToggle}').getAttribute('aria-expanded')`),
      "false",
    )
    assert.ok(await exists('[data-slot="session-context-token-summary"]'))
    assert.ok(await cdp.evaluate(`(() => {
      const trigger = document.querySelector('${contextToggle}');
      const label = trigger.querySelector('span').getBoundingClientRect();
      const usage = trigger.querySelector('[data-slot="session-context-token-summary"]').parentElement.getBoundingClientRect();
      const arrow = trigger.querySelector('[data-slot="collapsible-arrow"]').getBoundingClientRect();
      return usage.left >= label.right && usage.left - label.right <= 12 && arrow.left >= usage.right;
    })()`), "usage summary follows its label without a large gap")
    log("PASS context usage summary sits immediately after label")
    assert.equal(await exists('[data-slot="session-context-details"]'), false)
    await click(contextToggle)
    await wait("context details expanded", () => exists('[data-slot="session-context-details"]'))
    await click(contextToggle)
    await wait("context details collapsed", async () => !(await exists('[data-slot="session-context-details"]')))
    log("PASS context starts collapsed with token summary; details expand and collapse")
    log("PASS no linked task hides detail button")
    await pointerClick(`${panel} [data-slot="dropdown-menu-trigger"]`)
    await wait("task picker menu", () => exists('[data-slot="dropdown-menu-item"]'))
    const menuSurface = await cdp.evaluate<{ border: string; shadow: string }>(`(() => {
      const item = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
        .find(el => el.textContent.includes('QA mounted task detail'));
      const style = getComputedStyle(item.closest('[data-component="dropdown-menu-content"]'));
      return { border: style.borderTopWidth, shadow: style.boxShadow };
    })()`)
    log(`task menu surface border=${menuSurface.border} shadow=${menuSurface.shadow}`)
    assert.equal(menuSurface.border, "1px")
    assert.equal(menuSurface.shadow.includes("inset"), false, "task dropdown retains a single border")
    assert.equal(await cdp.evaluate(`(() => {
      const task = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
        .find(el => el.textContent.includes('QA mounted task detail'));
      return task?.textContent.trim();
    })()`), "QA mounted task detail", "task menu shows title without progress or status subtitle")
    log("PASS task dropdown shows task names only")
    await cdp.evaluate(`(() => {
      const task = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')]
        .find(el => el.textContent.includes('QA mounted task detail'));
      if (!task) throw Error('test task missing from picker');
      task.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
    })()`)
    await wait("linked task button", () => exists(openButton))
    assert.equal((await request(`/session/${sessionID}`)).mountedTaskID, taskID)
    assert.equal((await request(`/session/${sessionID}`)).injectTaskContext, true, "task context injection defaults on")
    assert.equal(await exists(`${panel} input[type="checkbox"]`), false)
    log("PASS task selection defaults to context injection without an option")
    await wait("linked task title loaded", () =>
      cdp.evaluate(
        `document.querySelector('${panel} [data-slot="dropdown-menu-trigger"]')?.textContent.includes('QA mounted task detail') === true`,
      ),
    )
    const geometry = await cdp.evaluate<{
      right: boolean
      sameRow: boolean
      balancedHeight: boolean
      square: boolean
      label: string
    }>(`(() => {
      const button = document.querySelector('${openButton}');
      const trigger = document.querySelector('${panel} [data-slot="dropdown-menu-trigger"]');
      const a = button.getBoundingClientRect(), b = trigger.getBoundingClientRect();
      return { right: a.left >= b.right, sameRow: Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<2,
        balancedHeight: Math.abs(b.height-a.height-2)<1, square: Math.abs(a.height-a.width)<1,
        label: button.getAttribute('aria-label') };
    })()`)
    assert.ok(geometry.right && geometry.sameRow)
    assert.ok(geometry.balancedHeight && geometry.square, "square detail button is 2px shorter to balance its shadow")
    assert.ok(geometry.label)
    await cdp.call("Page.captureScreenshot").then(async (shot: any) => {
      await Bun.write("/tmp/opencode-session-task-open.png", Buffer.from(shot.data, "base64"))
    })
    try {
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
      })
      await wait("narrow status panel fits", () => cdp.evaluate(`(() => {
        const panel = document.querySelector('[data-slot="session-status-float-panel"]');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
      })()`))
      await cdp.call("Page.captureScreenshot").then(async (shot: any) => {
        await Bun.write("/tmp/opencode-session-status-narrow.png", Buffer.from(shot.data, "base64"))
      })
      log("PASS merged status panel fits narrow window")
    } finally {
      await cdp.call("Emulation.clearDeviceMetricsOverride")
    }
    await peekOtherProject()
    await toggleSidebar()
    await wait("sidebar shortcut restores current session project", () =>
      exists(`${rail}[data-sidebar-expanded="true"]`),
    )
    await toggleSidebar()
    await wait("shortcut closes sidebar", async () => !(await exists(expandedRail)))
    log(`PASS shortcut restores current project keybind=${sidebarKeybind}`)
    await peekOtherProject()
    try {
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: 1000,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await toggleSidebar()
      await wait("mobile shortcut restores current session project", () =>
        exists(`[data-component="sidebar-nav-mobile"].translate-x-0 ${menu}`),
      )
      await toggleSidebar()
      await wait(
        "mobile shortcut closes sidebar",
        async () => !(await exists('[data-component="sidebar-nav-mobile"].translate-x-0')),
      )
      log("PASS narrow-window shortcut restores current project")
    } finally {
      await cdp.call("Emulation.clearDeviceMetricsOverride")
    }
    for (let index = 0; index < 2; index++) {
      if (index) await click(`${float} > button`)
      await peekOtherProject()
      await click(openButton)
      await wait("correct task detail", () => exists(`[data-project-task-dialog="${taskID}"]`))
      assert.ok(await exists(`${rail}[data-sidebar-expanded="true"]`), "task details restore the session project")
      assert.equal(
        await cdp.evaluate(`document.querySelector('${float}')?.getAttribute('data-expanded')`),
        "false",
        "status float closes before details open",
      )
      await closeDialog()
      log(`PASS linked task opens correct details attempt=${index + 1}`)
    }
    await click(`${float} > button`)
    await request(`/session/${sessionID}/project-task`, "DELETE")
    await wait("button hidden after unlink", async () => !(await exists(openButton)))
    log("PASS unlink hides button reactively")
    await click('[data-action="session-status-float-close"]')
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
    await click('[data-action="home-open"]')
    await wait(
      "home has no current session project",
      async () => !(await exists('[data-action="project-switch"][data-session-current="true"]')),
    )
    await click(rail)
    await wait("home manual project selection", () => exists(`${rail}[data-sidebar-expanded="true"]`))
    await click(rail)
    await toggleSidebar()
    await wait("home shortcut keeps manually selected project", () => exists(`${rail}[data-sidebar-expanded="true"]`))
    log("PASS home shortcut preserves manual selection when no session is active")
  } finally {
    log("cleaning test UI")
    await closeDialog()
    await cdp.evaluate(`(() => {
      for (const tab of document.querySelectorAll('[data-component="session-tab"]')) {
        if (tab.getAttribute('data-directory') !== ${JSON.stringify(directory)} || tab.hasAttribute('data-session-id')) continue;
        tab.querySelector('[data-action="session-tab-close"]')?.click();
      }
    })()`)
    await cdp.evaluate(`(async () => {
      const { setPendingProjectTaskMount } = await import(${JSON.stringify(`${source}/components/session/pending-project-task-mount.ts`)});
      setPendingProjectTaskMount(${JSON.stringify(directory)}, { taskID: undefined });
    })()`)
    if (await exists('[data-action="session-status-float-close"]'))
      await click('[data-action="session-status-float-close"]')
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
    try {
      if (sessionID) await request(`/session/${sessionID}`, "DELETE")
      if (taskID) await request(`/project-task/${taskID}`, "DELETE")
      log("test session and task deleted; restoring previous session")
      if (previous?.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    log("test data cleaned and previous session restored")
  }
})
