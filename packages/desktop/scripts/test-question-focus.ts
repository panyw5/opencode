import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[question-focus-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp) => {
  const directory = await realpath(await mkdtemp("/tmp/opencode-question-focus-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const url = process.env.OPENCODE_QUESTION_TEST_SERVER ?? connection.url
  const previous = await cdp.evaluate<string>("location.href")
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(url === connection.url
          ? {
              Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
            }
          : {}),
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, check: () => Promise<boolean>, timeout = 60_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const countdown = () =>
    cdp.evaluate<number>(
      `Number(document.querySelector('[data-slot="question-countdown"]')?.textContent.match(/[0-9]+/)?.[0])`,
    )
  let sessionID: string | undefined
  try {
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
    const session = await request("/session", "POST", { title: "QA focused question pauses timeout" })
    sessionID = session.id
    const route = `/${Buffer.from(directory).toString("base64url")}/session/${session.id}`
    await cdp.evaluate(
      `import(${JSON.stringify(`${source}/utils/notification-click.ts`)}).then(m => m.handleNotificationClick(${JSON.stringify(route)}))`,
    )
    await wait("owned session", () =>
      cdp.evaluate(
        `document.querySelector('[data-component="session-page"]')?.dataset.sessionId===${JSON.stringify(session.id)}`,
      ),
    )
    await request(`/session/${session.id}/prompt_async`, "POST", {
      agent: "build",
      parts: [
        {
          type: "text",
          text: "QA task: call the question tool exactly once with top-level timeout: 6 seconds. Ask 'QA focused timeout' with header 'QA' and options 'One' and 'Two'. Do not call other tools or modify files. After timeout, stop.",
        },
      ],
    })
    log(`sent model message session=${session.id}`)
    let pending: any
    await wait("model question", async () => {
      pending = (await request("/question")).find((item: any) => item.sessionID === session.id)
      return !!pending?.expiresAt
    })
    const originalDeadline = pending.expiresAt
    log(`received question id=${pending.id} expiresAt=${originalDeadline}`)
    await wait("question dock", () => cdp.evaluate(`!!document.querySelector('[data-slot="question-countdown"]')`))
    await cdp.evaluate(
      `document.querySelector('[data-slot="question-option"][data-custom="true"] [data-slot="option-label"]').click()`,
    )
    await wait("custom input focus", () =>
      cdp.evaluate(`document.activeElement?.matches('[data-slot="question-custom-input"]')`),
    )
    await cdp.call("Input.insertText", { text: "QA answer in progress" })
    await wait("backend paused", async () => {
      pending = (await request("/question")).find((item: any) => item.id === pending.id)
      return !!pending?.timeoutPause
    })
    const budget = pending.timeoutPause.remaining
    await wait("paused countdown", () =>
      cdp.evaluate(`document.querySelector('[data-slot="question-countdown"]')?.dataset.paused==='true'`),
    )
    const frozen = await countdown()
    // Staying focused past the original deadline is the regression under test.
    await Bun.sleep(Math.max(0, originalDeadline - Date.now()) + 1500)
    assert.equal(await countdown(), frozen)
    pending = (await request("/question")).find((item: any) => item.id === pending.id)
    assert.equal(pending?.timeoutPause?.remaining, budget)
    assert.ok(pending.timeoutPause.until > Date.now())
    log(`PASS custom input remains at ${frozen}s beyond original deadline; backend budget=${budget}ms`)
    await cdp.evaluate(`document.querySelector('[data-slot="question-collapse"]').focus()`)
    assert.equal(await countdown(), frozen)
    log("PASS focus movement within question does not resume countdown")
    await cdp.evaluate(`document.querySelector('[data-slot="question-collapse"]').blur()`)
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown" })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown" })
    await wait("keyboard focus", () =>
      cdp.evaluate(`!!document.querySelector('[data-slot="question-option"][data-focused="true"]')`),
    )
    await wait(
      "keyboard focus pauses timeout",
      async () => !!(await request("/question")).find((item: any) => item.id === pending.id)?.timeoutPause,
    )
    log("PASS keyboard option navigation pauses countdown")
    await cdp.evaluate(`(() => {
      const outside=document.createElement('button');outside.id='question-focus-qa-outside';document.body.append(outside);
      outside.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));outside.focus();
    })()`)
    await wait("backend resumed", async () => {
      const current = (await request("/question")).find((item: any) => item.id === pending.id)
      return !!current && !current.timeoutPause
    })
    await wait("countdown ticks after blur", async () => (await countdown()) < frozen, 4000)
    log("PASS focus outside question resumes remaining budget")
    await wait("automatic timeout", () => cdp.evaluate(`!document.querySelector('[data-kind="question"]')`), 12_000)
    const rows = await request(`/session/${session.id}/message`)
    const tool = rows
      .flatMap((row: any) => row.parts)
      .find((part: any) => part.type === "tool" && part.tool === "question")
    assert.equal(tool.state.status, "error")
    assert.match(tool.state.error, /timed out without a user response/)
    assert.equal(tool.state.metadata?.answers, undefined)
    log("PASS timeout result received and persisted without an answer")
  } finally {
    await cdp.evaluate(`document.getElementById('question-focus-qa-outside')?.remove()`)
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: false })
    await cdp.call("Page.navigate", { url: previous })
    if (sessionID) {
      await request(`/session/${sessionID}/abort`, "POST")
      await request(`/session/${sessionID}`, "DELETE")
    }
    await rm(directory, { recursive: true, force: true })
    log("restored previous page and removed owned test data")
  }
})
