import { strict as assert } from "node:assert"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[project-task-editor-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-progress-editor-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory: string; sessionID: string } | undefined>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? { directory: tab.dataset.directory, sessionID: tab.dataset.sessionId } : undefined;
  })()`)
  const labels = await cdp.evaluate<Record<string, string>>(`(async () => {
    const base = await import(${JSON.stringify(`${source}/i18n/en.ts`)});
    const locale = document.documentElement.lang || "en";
    const translated = await import(${JSON.stringify(`${source}/i18n/`)} + locale + '.ts');
    return { ...base.dict, ...translated.dict };
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
    if (!response.ok) throw new Error(`HTTP ${response.status} ${method} ${path}`)
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
  const click = async (selector: string) => {
    await wait(`click target available: ${selector}`, () =>
      cdp.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`),
    )
  }
  const navigate = (dir: string, sessionID: string) =>
    cdp.evaluate(`window.__projectEditorNavigation = (async () => {
    const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
    handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${sessionID}`)});
  })()`)
  const root = "[data-project-task-dialog]"
  const documentButton = (document: string) => `${root} [data-project-task-document="${document}"]`
  const textarea = `${root} textarea`
  const edit = `${root} [data-component="markdown-editor-field"] button[aria-label=${JSON.stringify(labels["trellis.tasks.edit"])}]`
  const save = `${root} [data-action="project-task-save-document"]`
  const selected = (document: string) =>
    cdp.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(documentButton(document))})?.getAttribute("aria-pressed") === "true"`,
    )
  const input = (text: string) =>
    cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(textarea)});
    if (!field || field.readOnly) throw new Error("editable textarea missing");
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  })()`)
  const close = async () => {
    if (await cdp.evaluate(`!!document.querySelector('${root}')`)) {
      await click(`${root} button[aria-label=${JSON.stringify(labels["trellis.tasks.close"])}]`)
      await wait("dialog closed", () => cdp.evaluate(`!document.querySelector('${root}')`))
    }
  }
  let taskID: string | undefined
  let sessionID: string | undefined
  try {
    const task = await request("/project-task", "POST", {
      title: "QA editable progress",
      description: "# Original brief\n",
    })
    taskID = task.id
    const detail = await request(`/project-task/${taskID}/detail`)
    assert.equal(typeof detail.progressContent, "string", "sidecar must expose editable progress")
    const file = join(detail.workspaceDirectory, detail.progressPath)
    const brief = join(detail.workspaceDirectory, detail.descriptionPath)
    const session = await request("/session", "POST", { title: "QA project progress editor" })
    sessionID = session.id
    const providers = await request("/provider")
    const providerID = providers.connected.find((id: string) =>
      providers.all.some((p: any) => p.id === id && Object.keys(p.models).length),
    )
    const provider = providers.all.find((p: any) => p.id === providerID)
    assert.ok(provider, "a configured provider is required for a no-reply message")
    await request(`/session/${sessionID}/message`, "POST", {
      noReply: true,
      agent: "build",
      model: { providerID, modelID: providers.default[providerID] ?? Object.keys(provider.models)[0] },
      parts: [{ type: "text", text: "PROJECT_PROGRESS_EDITOR_QA" }],
    })
    const messages = await request(`/session/${sessionID}/message`)
    assert.ok(
      messages.some((message: any) => message.parts.some((part: any) => part.text === "PROJECT_PROGRESS_EDITOR_QA")),
    )
    log(`sidecar message sent and received session=${sessionID}`)
    await request(`/session/${sessionID}/project-task`, "PUT", { taskID })
    await cdp.evaluate(
      `window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [${JSON.stringify(`opencode://open-project?directory=${encodeURIComponent(directory)}`)}] } }))`,
    )
    await navigate(directory, sessionID)
    const rail = `[data-action="project-switch"][aria-label=${JSON.stringify(basename(directory))}]`
    await wait("test project rail", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(rail)})`))
    await wait("test session active", () =>
      cdp.evaluate(
        `!!document.querySelector('[data-component="session-tab"][data-active="true"][data-session-id="${sessionID}"]')`,
      ),
    )
    const projectMenu = `[data-action="project-menu"][data-project="${Buffer.from(directory).toString("base64url")}"]`
    const panelReady = () =>
      cdp.evaluate<boolean>(
        `(() => { const menu = document.querySelector(${JSON.stringify(projectMenu)}); return !!menu && !menu.closest('[inert]'); })()`,
      )
    if (!(await panelReady())) await click(rail)
    await wait("test project sidebar active", panelReady)
    await cdp.evaluate(
      `window.dispatchEvent(new CustomEvent("opencode:present-task-open", { detail: { sessionID: ${JSON.stringify(sessionID)}, kind: "project_task", taskID: ${JSON.stringify(taskID)} } }))`,
    )
    await wait("editor loaded", () =>
      cdp.evaluate(
        `document.querySelector('[data-project-task-dialog="${taskID}"] [data-project-task-document]')?.disabled === false`,
      ),
    )
    const ui = await cdp.evaluate<{
      title: string
      statuses: string[]
      border: string
      shadow: string
      toggleFirst: boolean
    }>(`(() => {
      const dialog = document.querySelector('${root}');
      const shell = dialog.querySelector('[data-slot="project-task-markdown-shell"]');
      const style = getComputedStyle(shell);
      return { title: dialog.querySelector('[data-slot="dialog-title"]').textContent,
        statuses: [...dialog.querySelectorAll('[data-project-task-status]')].map(b => b.textContent.trim()),
        border: style.borderTopWidth, shadow: style.boxShadow,
        toggleFirst: !!(dialog.querySelector('[data-project-task-document]').compareDocumentPosition(dialog.querySelector('[data-project-task-status]')) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`)
    assert.deepEqual(ui.statuses, [
      labels["projectTask.status.open"],
      labels["projectTask.status.inProgress"],
      labels["projectTask.status.done"],
    ])
    assert.equal(ui.title.includes(" · "), false, "header must not include status and todo summaries")
    assert.equal(ui.border, "1px")
    assert.equal(ui.shadow, "none")
    assert.ok(ui.toggleFirst)
    log("translated statuses, toggle position and thin border verified")
    await click(documentButton("progress"))
    await click(edit)
    assert.equal(await cdp.evaluate(`document.querySelector('${textarea}').value`), detail.progressContent)
    const content = "# QA Progress\n\nSaved through the desktop editor.\n"
    await input(content)
    await click(save)
    await wait(
      "saved progress on disk",
      async () =>
        (await readFile(file, "utf8")) === content &&
        (await cdp.evaluate(`document.querySelector('${save}')?.disabled === true`)),
    )
    assert.equal(await readFile(brief, "utf8"), task.description)
    log(`progress saved and verified file=${file}`)
    const recovered = `${content}\nRecovered after a failed save.\n`
    await input(recovered)
    await cdp.evaluate(`(() => {
      window.__projectProgressFetch = window.fetch;
      window.fetch = (input, init) => {
        const req = new Request(input, init);
        if (req.method === "PATCH" && new URL(req.url).pathname === ${JSON.stringify(`/project-task/${taskID}`)}) return Promise.reject(new Error("QA save failure"));
        return window.__projectProgressFetch(input, init);
      };
    })()`)
    await click(documentButton("description"))
    await wait("failed save shown", () =>
      cdp.evaluate(`document.querySelector('${root}')?.textContent.includes("QA save failure")`),
    )
    assert.ok(await selected("progress"))
    assert.equal(await cdp.evaluate(`document.querySelector('${textarea}').value`), recovered)
    assert.equal(await readFile(file, "utf8"), content)
    await cdp.evaluate("window.fetch = window.__projectProgressFetch; delete window.__projectProgressFetch")
    await click(save)
    await wait(
      "retry saved",
      async () =>
        (await readFile(file, "utf8")) === recovered &&
        (await cdp.evaluate(`document.querySelector('${save}')?.disabled === true`)),
    )
    log("failed save retains document and draft; retry succeeds")
    const minimized = `${recovered}\nUnsaved minimized draft.\n`
    await input(minimized)
    await click(`${root} [data-action="dialog-minimize"]`)
    await wait("editor minimized", () => cdp.evaluate(`!document.querySelector('${root}')`))
    assert.equal(await readFile(file, "utf8"), recovered)
    await click('[data-action="panel-stash"]')
    await wait("restored progress draft", () =>
      cdp.evaluate(`document.querySelector('${textarea}')?.value === ${JSON.stringify(minimized)}`),
    )
    assert.ok(await selected("progress"))
    await click(documentButton("description"))
    await wait("description selected", () => selected("description"))
    assert.equal(await readFile(file, "utf8"), minimized)
    assert.equal(await cdp.evaluate(`document.querySelector('${textarea}').value`), task.description)
    log("minimize/restore preserves progress selection and draft; switching saves the draft")
    await close()
    const reloaded = await request(`/project-task/${taskID}/detail`)
    assert.equal(reloaded.progressContent, minimized)
    assert.equal(reloaded.description, task.description)
    assert.equal(await readFile(file, "utf8"), minimized)
    log("PASS fresh sidecar reads after closing return the saved progress and unchanged brief")
  } catch (error) {
    log(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
    throw error
  } finally {
    await cdp.evaluate(
      "if (window.__projectProgressFetch) { window.fetch = window.__projectProgressFetch; delete window.__projectProgressFetch; }",
    )
    try {
      await close()
      const slug = Buffer.from(directory).toString("base64url")
      const rail = `[data-action="project-switch"][aria-label=${JSON.stringify(basename(directory))}]`
      const menu = `[data-action="project-menu"][data-project="${slug}"]`
      if (
        !(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(menu)})`)) &&
        (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(rail)})`))
      )
        await click(rail)
      if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(menu)})`)) {
        await cdp.evaluate(
          `document.querySelector(${JSON.stringify(menu)}).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }))`,
        )
        await wait("close test project menu", () =>
          cdp.evaluate(`!!document.querySelector('[data-action="project-close-menu"][data-project="${slug}"]')`),
        )
        await cdp.evaluate(
          `document.querySelector('[data-action="project-close-menu"][data-project="${slug}"]').dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }))`,
        )
        await wait("test project closed", () => cdp.evaluate(`!document.querySelector(${JSON.stringify(rail)})`))
      }
    } finally {
      if (sessionID) await request(`/session/${sessionID}`, "DELETE")
      if (taskID) await request(`/project-task/${taskID}`, "DELETE")
      if (previous?.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
      await rm(directory, { recursive: true, force: true })
      log("owned test task/session cleaned and previous session restored")
    }
  }
})
