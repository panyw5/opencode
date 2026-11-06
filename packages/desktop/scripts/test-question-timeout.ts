import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[question-timeout-test] ${message}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`
const multiple = process.argv.includes("--multiple")
const focus = process.argv.includes("--focus")
const recovered = process.argv.includes("--recovered")
assert.ok(!recovered || focus, "--recovered is only supported with --focus")

await withCdp(async (cdp) => {
  const directory = await realpath(await mkdtemp("/tmp/opencode-question-timeout-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previousTab = await cdp.evaluate<{ directory: string; id: string } | null>(`(() => {
    const tab=document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? {directory:tab.dataset.directory,id:tab.dataset.sessionId} : null;
  })()`)
  const previous = previousTab
    ? `/${Buffer.from(previousTab.directory).toString("base64url")}/session/${previousTab.id}`
    : "/"
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
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
  const navigate = (route: string) =>
    cdp.evaluate(
      `window.__questionTimeoutNavigation = import(${JSON.stringify(`${source}/utils/notification-click.ts`)}).then(m => { m.handleNotificationClick(${JSON.stringify(route)}); return true })`,
    )
  const countdown = () =>
    cdp.evaluate<{
      text: string
      seconds: number
      urgent: string
      width: number
      paused: boolean
      opacity: number
    } | null>(`(() => {
    const el=document.querySelector('[data-slot="question-countdown"]');
    if(!el)return null;
    return {text:el.textContent,seconds:Number(el.textContent.match(/[0-9]+/)?.[0]),urgent:el.dataset.urgent,width:el.getBoundingClientRect().width,paused:el.dataset.paused==='true',opacity:Number(getComputedStyle(el).opacity)};
  })()`)
  let sessionID: string | undefined
  try {
    const session = await request("/session", "POST", { title: "QA model question timeout and countdown" })
    sessionID = session.id
    const route = `/${Buffer.from(directory).toString("base64url")}/session/${session.id}`
    await navigate(route)
    await wait("owned session", () =>
      cdp.evaluate(
        `document.querySelector('[data-component="session-page"]')?.dataset.sessionId===${JSON.stringify(session.id)}`,
      ),
    )
    if (recovered) {
      await request(`/session/${session.id}/shell`, "POST", {
        agent: "build",
        command: "printf QUESTION_FOCUS_SIDECAR_OK",
      })
      const rows = await request(`/session/${session.id}/message`)
      const tool = rows
        .flatMap((row: any) => row.parts)
        .find((part: any) => part.type === "tool" && part.state.status === "completed")
      assert.ok(tool?.state.output.includes("QUESTION_FOCUS_SIDECAR_OK"))
      log("PASS sidecar message sent and completed reply received")
      const questions = [
        {
          question: "QA recovered focus countdown",
          header: "QA",
          options: [
            { label: "One", description: "First option" },
            { label: "Two", description: "Second option" },
          ],
        },
      ]
      const question = {
        id: `que_focus_${Date.now()}`,
        sessionID: session.id,
        questions,
        tool: { messageID: tool.messageID, callID: tool.callID },
        expiresAt: Date.now() + 12_000,
      }
      await request(`/session/${session.id}/message/${tool.messageID}/part/${tool.id}`, "PATCH", {
        ...tool,
        tool: "question",
        state: {
          status: "running",
          input: { questions, timeout: 12 },
          metadata: { questionRequest: question },
          time: { start: Date.now() },
        },
      })
      // Rehydrate through the backend list, then publish an update even if this
      // directory's frontend bootstrap is already cached.
      await request("/question")
      await request(`/question/${question.id}/pause`, "POST", { paused: false })
    } else
      await request(`/session/${session.id}/prompt_async`, "POST", {
        agent: "build",
        parts: [
          {
            type: "text",
            text: `QA task: call the question tool exactly once with top-level timeout: 12 (seconds). ${multiple ? "Include exactly three questions, titled 'QA countdown check 1', 'QA countdown check 2', 'QA countdown check 3', each with header 'QA' and two options 'One' and 'Two'." : "Ask 'QA countdown check' with header 'QA' and two options 'One' and 'Two'."} Do not call any other tool or modify files. ${focus ? "The user will answer. After receiving the answer, respond exactly QUESTION_FOCUS_QA_OK and stop." : "Nobody will answer. After the question tool reports its timeout, respond with exactly QUESTION_TIMEOUT_QA_OK and stop. A timeout is not consent."}`,
          },
        ],
      })
    log(`registered ${recovered ? "recovered" : "model"} question test session=${session.id}`)
    let pending: any
    await wait("model question with deadline", async () => {
      pending = (await request("/question")).find((item: any) => item.sessionID === session.id)
      return !!pending?.expiresAt
    })
    log(`received ${recovered ? "recovered" : "model"} question id=${pending.id} expiresAt=${pending.expiresAt}`)
    assert.equal(pending.questions.length, multiple ? 3 : 1)
    await wait("visible countdown", async () => !!(await countdown()))
    await wait("dock enter animation settled", () =>
      cdp.evaluate(`(() => {
      const dock=document.querySelector('[data-kind="question"]');
      return !!dock && Number(getComputedStyle(dock.parentElement.parentElement).opacity)>0.99;
    })()`),
    )
    const first = await countdown()
    assert.ok(first && first.seconds > 0 && first.seconds <= 12, JSON.stringify(first))
    assert.equal(first.urgent, "true")
    assert.ok(first.width > 0)
    const progress = await cdp.evaluate<{ labels: string[]; fontSize: number }>(`({
      labels:[...document.querySelectorAll('[data-slot="question-progress-segment"]')].map(el=>el.textContent.trim()),
      fontSize:parseFloat(getComputedStyle(document.querySelector('[data-slot="question-countdown"]')).fontSize),
    })`)
    assert.deepEqual(progress.labels, multiple ? ["1", "2", "3"] : [])
    assert.ok(progress.fontSize >= 14, `countdown too small: ${progress.fontSize}px`)
    if (focus) {
      assert.equal(multiple, false, "--focus expects a single question")
      await cdp.call("Page.bringToFront")
      await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
      const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const r=document.querySelector('[data-slot="question-option"]').getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2};
      })()`)
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
      await wait("hover pauses countdown", async () => (await countdown())?.paused === true, 5000)
      await wait("paused countdown fades", async () => (await countdown())!.opacity <= 0.46, 2000)
      const paused = (await countdown())!
      await Bun.sleep(13_000)
      assert.equal((await countdown())?.seconds, paused.seconds)
      const held = (await request("/question")).find((item: any) => item.id === pending.id)
      assert.ok(held?.timeoutPause?.until > Date.now())
      log(`PASS mouse selection stays paused beyond original deadline; remaining=${paused.seconds}`)
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
      await wait("hover leave resumes", async () => (await countdown())?.paused === false, 5000)
      await wait("running countdown returns to full opacity", async () => (await countdown())!.opacity >= 0.99, 2000)
      log("PASS countdown opacity fades to 0.45 while paused and returns to 1 on blur")
      await wait("resumed countdown decreases", async () => (await countdown())!.seconds < paused.seconds, 3000)
      await cdp.evaluate(`document.querySelector('[data-slot="question-option"][data-custom="true"]').click()`)
      await wait("custom input focused", () =>
        cdp.evaluate(`document.activeElement?.matches('[data-slot="question-custom-input"]')`),
      )
      await cdp.call("Input.insertText", { text: "QUESTION_FOCUS_TYPED_ANSWER" })
      await wait("typing pauses countdown", async () => (await countdown())?.paused === true, 5000)
      const typing = (await countdown())!
      await Bun.sleep(17_000)
      assert.equal((await countdown())?.seconds, typing.seconds)
      assert.ok((await countdown())!.opacity <= 0.46, "focused input keeps countdown faded")
      assert.equal(
        await cdp.evaluate(`document.querySelector('[data-slot="question-custom-input"]').value`),
        "QUESTION_FOCUS_TYPED_ANSWER",
      )
      log("PASS focused input stays paused across lease renewals with pointer outside question")
      const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write("/tmp/opencode-question-focus.png", Buffer.from(screenshot.data, "base64"))
      await cdp.evaluate(`document.querySelector('[data-slot="question-footer-actions"] button:last-child').click()`)
      await wait("model receives typed answer", async () => {
        const rows = await request(`/session/${session.id}/message`)
        return rows.some((row: any) =>
          row.parts.some(
            (part: any) =>
              part.type === "tool" &&
              part.tool === "question" &&
              part.state.status === "completed" &&
              JSON.stringify(part.state.metadata?.answers).includes("QUESTION_FOCUS_TYPED_ANSWER"),
          ),
        )
      })
      if (!recovered)
        await wait("model acknowledges answer", async () => {
          const rows = await request(`/session/${session.id}/message`)
          return rows.some(
            (row: any) =>
              row.info.role === "assistant" &&
              row.parts.some((part: any) => part.type === "text" && part.text.trim() === "QUESTION_FOCUS_QA_OK"),
          )
        })
      log(
        recovered
          ? "PASS sidecar persisted recovered typed answer after original deadline"
          : "PASS typed answer persisted after original deadline and model replied QUESTION_FOCUS_QA_OK",
      )
      return
    }
    if (multiple) {
      await cdp.evaluate(`document.querySelectorAll('[data-slot="question-progress-segment"]')[2].click()`)
      assert.equal(
        await cdp.evaluate(
          `document.querySelector('[data-slot="question-progress-segment"][aria-current="step"]').textContent.trim()`,
        ),
        "3",
      )
      await cdp.evaluate(`document.querySelectorAll('[data-slot="question-progress-segment"]')[0].click()`)
      log("PASS numbered progress jumps to selected question and marks the current step")
    }
    for (const width of [1728, 768, 390]) {
      await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 1079, deviceScaleFactor: 1, mobile: false })
      const layout = await cdp.evaluate<{ offset: number; gap: number; grouped: boolean; overlap: boolean }>(`(() => {
        const title=document.querySelector('[data-slot="question-header-title"]');
        const timer=document.querySelector('[data-slot="question-countdown"]');
        const progress=document.querySelector('[data-slot="question-progress"]')?.getBoundingClientRect();
        const header=document.querySelector('[data-slot="question-header"]').getBoundingClientRect();
        const a=title.getBoundingClientRect(), b=timer.getBoundingClientRect();
        const sameRow=progress && a.top<progress.bottom && a.bottom>progress.top;
        return {offset:progress ? Math.abs((progress.left+progress.right-header.left-header.right)/2) : 0,gap:b.left-a.right,
          grouped:title.parentElement===timer.parentElement,overlap:!!sameRow && Math.max(a.right,b.right)>progress.left};
      })()`)
      assert.equal(layout.grouped, true, "countdown belongs beside question count")
      assert.ok(layout.offset <= 1, `progress marker off-center at width=${width}: ${layout.offset}px`)
      assert.equal(layout.overlap, false, `question metadata overlaps center marker at width=${width}`)
      if (width >= 768) assert.ok(layout.gap >= 8 && layout.gap <= 16, `countdown gap=${layout.gap}px`)
      log(
        `PASS width=${width}: countdown grouped with question count; marker center offset=${layout.offset.toFixed(1)}px`,
      )
    }
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    const image = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write(
      `/tmp/opencode-question-timeout${multiple ? "-multiple" : ""}.png`,
      Buffer.from(image.data, "base64"),
    )
    await cdp.evaluate(`document.querySelector('[data-slot="question-collapse"]').click()`)
    await wait(
      "countdown ticks while collapsed",
      async () => {
        const current = await countdown()
        return !!current && current.seconds < first.seconds
      },
      5000,
    )
    log("PASS countdown ticks while question body is collapsed")
    await navigate(previous)
    await wait(
      "left QA session",
      () =>
        cdp.evaluate(
          `document.querySelector('[data-component="session-page"]')?.dataset.sessionId!==${JSON.stringify(session.id)}`,
        ),
      5000,
    )
    await navigate(route)
    await wait(
      "returned to QA session",
      () =>
        cdp.evaluate(
          `document.querySelector('[data-component="session-page"]')?.dataset.sessionId===${JSON.stringify(session.id)}`,
        ),
      5000,
    )
    await wait(
      "countdown restored without reset",
      async () => {
        const current = await countdown()
        return !!current && current.seconds < first.seconds && current.seconds > 0
      },
      5000,
    )
    const restored = (await request("/question")).find((item: any) => item.id === pending.id)
    assert.equal(restored.expiresAt, pending.expiresAt)
    log("PASS navigating away and back preserves deadline")
    await wait(
      "question disappears automatically via backend event",
      () => cdp.evaluate(`!document.querySelector('[data-kind="question"]')`),
      20_000,
    )
    assert.ok(!(await request("/question")).some((item: any) => item.id === pending.id))
    let rows: any[] = []
    await wait("timeout tool result persisted", async () => {
      rows = await request(`/session/${session.id}/message`)
      return rows.some((row) =>
        row.parts.some(
          (part: any) => part.type === "tool" && part.tool === "question" && part.state.status === "error",
        ),
      )
    })
    const tool = rows.flatMap((row) => row.parts).find((part: any) => part.type === "tool" && part.tool === "question")
    assert.equal(tool.state.input.timeout, 12)
    assert.equal(tool.state.status, "error")
    assert.match(tool.state.error, /timed out without a user response/)
    assert.equal(tool.state.metadata?.answers, undefined)
    // Manual dismissal normally stops the current turn. Verify the next turn can
    // read the timeout result, independently of continue_loop_on_deny settings.
    const followupAt = Date.now()
    await request(`/session/${session.id}/prompt_async`, "POST", {
      agent: "build",
      parts: [
        {
          type: "text",
          text: "Read the preceding question tool result. If it timed out without a user response and no answer was selected, respond with exactly QUESTION_TIMEOUT_QA_OK. Do not call any tools.",
        },
      ],
    })
    await wait("model reads timeout result", async () => {
      const messages = await request(`/session/${session.id}/message`)
      return messages.some(
        (row: any) =>
          row.info.role === "assistant" &&
          row.info.time.created >= followupAt &&
          row.parts.some((part: any) => part.type === "text" && part.text.trim() === "QUESTION_TIMEOUT_QA_OK"),
      )
    })
    log(
      "PASS model timeout=12 forwarded; automatic dismissal persisted; next model turn read the timeout and replied QUESTION_TIMEOUT_QA_OK",
    )
  } finally {
    if (focus) await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: false })
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await navigate(previous)
    if (sessionID) {
      if (!recovered)
        await request(`/session/${sessionID}/abort`, "POST").catch((error) =>
          log(`abort cleanup failed: ${String(error)}`),
        )
      await request(`/session/${sessionID}`, "DELETE")
    }
    await rm(directory, { recursive: true, force: true })
    log("restored previous session and removed owned test data")
  }
})
