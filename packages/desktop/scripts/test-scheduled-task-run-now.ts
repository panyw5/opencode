import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[scheduled-run-now-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-scheduled-refresh-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory: string; sessionID: string } | undefined>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? { directory: tab.dataset.directory, sessionID: tab.dataset.sessionId } : undefined;
  })()`)
  const labels = await cdp.evaluate<Record<string, string>>(`(async () => {
    const base = await import(${JSON.stringify(`${source}/i18n/en.ts`)});
    const translated = await import(${JSON.stringify(`${source}/i18n/`)} + (document.documentElement.lang || 'en') + '.ts');
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
    if (!response.ok) throw new Error(`HTTP ${response.status} ${method} ${path}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const click = async (selector: string) => {
    await wait(`click ${selector}`, () =>
      cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return false;
      el.click(); return true;
    })()`),
    )
  }
  const navigate = (dir: string, sessionID: string) =>
    cdp.evaluate(`(async () => {
    const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
    handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${sessionID}`)});
  })()`)
  const root = "[data-scheduled-task-dialog]"
  const slug = Buffer.from(directory).toString("base64url")
  const rail = `[data-action="project-switch"][aria-label=${JSON.stringify(basename(directory))}]`
  const menu = `[data-action="project-menu"][data-project="${slug}"]`
  let taskID: string | undefined
  let sessionID: string | undefined
  const runSessions = new Set<string>()
  try {
    const project = await request("/project/current")
    const providers = await request("/provider")
    const providerID = process.env.OPENCODE_TEST_PROVIDER ?? "axonhub-codex"
    const modelID = process.env.OPENCODE_TEST_MODEL ?? "gpt-6-luna"
    assert.ok(providers.connected.includes(providerID), `provider ${providerID} must be connected`)
    assert.ok(providers.all.find((p: any) => p.id === providerID)?.models[modelID], `model ${modelID} must exist`)
    const session = await request("/session", "POST", { title: "QA scheduled task local refresh" })
    sessionID = session.id
    const prompt = "Reply with exactly SCHEDULED_LOCAL_REFRESH_OK. Do not use tools."
    const task = await request("/scheduled-task", "POST", {
      projectID: project.id,
      directory,
      name: "QA local scheduled refresh",
      prompt,
      schedule: { kind: "every", interval: 86_400_000 },
      executionMode: "new_session",
      agent: "build",
      model: { providerID, modelID },
      enabled: false,
      unattended: true,
    })
    taskID = task.id
    log(`created owned task=${taskID} directory=${directory}`)
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent("opencode:deep-link", {
      detail: { urls: [${JSON.stringify(`opencode://open-project?directory=${encodeURIComponent(directory)}`)}] }
    }))`)
    await navigate(directory, sessionID!)
    await wait("test project", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(rail)})`))
    await wait("test session", () =>
      cdp.evaluate(
        `!!document.querySelector('[data-component="session-tab"][data-active="true"][data-session-id="${sessionID}"]')`,
      ),
    )
    if (!(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(menu)})`))) await click(rail)
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent("opencode:present-task-open", {
      detail: { sessionID: ${JSON.stringify(sessionID)}, kind: "scheduled_task", taskID: ${JSON.stringify(taskID)} }
    }))`)
    await wait("task editor", () =>
      cdp.evaluate(`!!document.querySelector('${root} [data-slot="scheduled-task-runs"]')`),
    )
    await Bun.sleep(500)
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('${root}');
      const form = dialog.querySelector('form');
      const field = form.querySelector('input');
      field.value = 'Unsaved local refresh draft';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      window.__scheduledRefreshQA = { dialog, form, field, history: dialog.querySelector('[data-slot="scheduled-task-runs"]'), requests: [], removed: 0 };
      const qa = window.__scheduledRefreshQA;
      qa.observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.removedNodes) {
          if ([qa.dialog, qa.form, qa.field, qa.history, qa.row].filter(Boolean).some(el => node === el || node.contains(el))) qa.removed++;
        }
      });
      qa.observer.observe(document.body, { childList: true, subtree: true });
      qa.fetch = window.fetch;
      window.fetch = (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url || input.href, location.href).pathname;
        if (path.startsWith('/scheduled-task')) qa.requests.push({ path, method: init?.method || input.method || 'GET' });
        return qa.fetch.call(window, input, init);
      };
    })()`)
    for (let index = 0; index < 2; index++) {
      await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('${root} button')].find(el => el.textContent.trim() === ${JSON.stringify(labels["scheduled.runNow"])});
        if (!button || button.disabled) throw new Error('run-now not ready');
        button.click();
      })()`)
      await wait(`run ${index + 1} received and replied`, async () => {
        const runs = await request(`/scheduled-task/${taskID}/run`)
        for (const run of runs) if (run.sessionID) runSessions.add(run.sessionID)
        if (runs.length !== index + 1 || runs[0].status === "running") return false
        assert.equal(runs[0].status, "ok", runs[0].error)
        const messages = await request(`/session/${runs[0].sessionID}/message`)
        assert.ok(
          messages.some((m: any) => m.info.role === "user" && m.parts.some((p: any) => p.text?.includes(prompt))),
        )
        assert.ok(
          messages.some(
            (m: any) =>
              m.info.role === "assistant" && m.parts.some((p: any) => p.text?.includes("SCHEDULED_LOCAL_REFRESH_OK")),
          ),
        )
        return cdp.evaluate(`document.querySelectorAll('${root} [data-run-id]').length === ${index + 1} &&
          [...document.querySelectorAll('${root} [data-run-id]')].every(el => !el.disabled && el.textContent.includes('ok'))`)
      })
      const state = await cdp.evaluate<any>(`(() => {
        const qa = window.__scheduledRefreshQA;
        return { stable: qa.dialog === document.querySelector('${root}') && qa.form.isConnected && qa.field.isConnected && qa.history.isConnected,
          draft: qa.field.value, removed: qa.removed,
          globalReads: qa.requests.filter(r => r.method === 'GET' && (r.path === '/scheduled-task' || r.path.endsWith('/run'))).length };
      })()`)
      assert.equal(state.stable, true)
      assert.equal(state.draft, "Unsaved local refresh draft")
      assert.equal(state.removed, 0)
      assert.equal(state.globalReads, 0, "run-now must not reload task lists or history")
      await cdp.evaluate(`window.__scheduledRefreshQA.row = document.querySelector('${root} [data-run-id]')`)
      log(
        `PASS run=${index + 1}: sidecar received prompt/reply; local live history; stable dialog/draft/rows; no list/history reload`,
      )
    }
  } finally {
    await cdp.evaluate(`(() => {
      const qa = window.__scheduledRefreshQA;
      if (!qa) return;
      window.fetch = qa.fetch; qa.observer.disconnect(); delete window.__scheduledRefreshQA;
    })()`)
    if (await cdp.evaluate(`!!document.querySelector('${root}')`)) {
      await click(`${root} button[aria-label=${JSON.stringify(labels["common.close"])}]`)
      await wait("editor closed", () => cdp.evaluate(`!document.querySelector('${root}')`))
    }
    try {
      if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(menu)})?.closest('[inert]')`)) await click(rail)
      if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(menu)})`)) {
        await cdp.evaluate(
          `document.querySelector(${JSON.stringify(menu)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }))`,
        )
        const close = `[data-action="project-close-menu"][data-project="${slug}"]`
        await wait("close test project menu", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(close)})`))
        await cdp.evaluate(
          `document.querySelector(${JSON.stringify(close)}).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }))`,
        )
      }
    } finally {
      if (taskID) {
        for (const run of await request(`/scheduled-task/${taskID}/run`))
          if (run.sessionID) runSessions.add(run.sessionID)
        await request(`/scheduled-task/${taskID}`, "DELETE")
      }
      for (const id of runSessions) await request(`/session/${id}`, "DELETE")
      if (sessionID) await request(`/session/${sessionID}`, "DELETE")
      if (previous?.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
      await rm(directory, { recursive: true, force: true })
      log("owned task/sessions cleaned and previous session restored")
    }
  }
})
