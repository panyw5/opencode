import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CdpClient, withCdp } from "./cdp"

// Run against an isolated dev app: OPENCODE_TEST_ONBOARDING=1
// electron-vite dev --inspect 9230 (renderer CDP remains on 9222).
// --foreground verifies attention notifications with the app focused.
// --native-click requires a real OS notification click instead of emitting one.
const log = (message: string) => console.log(`[system-notification-test] ${message}`)
const nativeClick = process.argv.includes("--native-click")
const foreground = process.argv.includes("--foreground")
const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-notifications-")))
const targets = await (await fetch("http://127.0.0.1:9230/json/list")).json()
const main = await CdpClient.connect(targets[0].webSocketDebuggerUrl)
const wait = async (label: string, check: () => Promise<boolean>) => {
  const deadline = Date.now() + (nativeClick ? 180_000 : 30_000)
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean; messages: { role: string }[] }
    const tools = body.messages.at(-1)?.role === "user"
    const content = "NOTIFICATION_QA_DONE"
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content } }] })
    log(`model request tools=${tools}`)
    const calls = [
      {
        name: "question",
        arguments: JSON.stringify({
          questions: [
            {
              header: "QA",
              question: "Continue notification QA?",
              options: [{ label: "Continue", description: "Continue the test" }],
            },
          ],
        }),
      },
      {
        name: "bash",
        arguments: JSON.stringify({
          command: "printf NOTIFICATION_SIDECAR_OK",
          description: "Verify sidecar notification test",
        }),
      },
    ]
    const delta = tools
      ? {
          tool_calls: calls.map((fn, index) => ({
            index,
            id: `notification-qa-${index}`,
            type: "function",
            function: fn,
          })),
        }
      : { content }
    const chunk = (delta: object, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "notification-qa", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(
      chunk({ role: "assistant" }) + chunk(delta) + chunk({}, tools ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    )
  },
})

try {
  assert.equal(
    await main.evaluate(`process.mainModule.require("electron").app.getAppPath()`),
    resolve(import.meta.dir, ".."),
  )
  assert.match(
    await main.evaluate<string>(`process.mainModule.require("electron").app.getPath("userData")`),
    /opencode-onboarding-/,
  )
  await Bun.write(
    join(directory, "opencode.json"),
    JSON.stringify({
      model: "notification-qa/test",
      small_model: "notification-qa/test",
      formatter: false,
      lsp: false,
      permission: { "*": "allow", bash: "ask" },
      provider: {
        "notification-qa": {
          npm: "@ai-sdk/openai-compatible",
          name: "Notification QA",
          env: [],
          options: { apiKey: "loopback-only", baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: { test: { name: "Notification QA", limit: { context: 100000, output: 10000 } } },
        },
      },
    }),
  )
  await main.evaluate(`(() => {
    const { Notification } = process.mainModule.require("electron");
    if (globalThis.__systemNotificationQA) throw new Error("Test already active");
    const qa = globalThis.__systemNotificationQA = { original: Notification.prototype.show, notifications: [], events: [], clicks: [] };
    Notification.prototype.show = function() {
      qa.notifications.push(this);
      this.on("show", () => qa.events.push("shown"));
      this.on("click", () => qa.clicks.push(this.body));
      this.on("failed", (_, error) => qa.events.push("failed:" + error));
      qa.original.call(this);
    };
  })()`)
  log("native delivery instrumentation ready")
  await withCdp(async (cdp, target) => {
    assert.match(target.url, /^http:\/\/(localhost|127\.0\.0\.1):\d+\//)
    assert.equal(await cdp.evaluate(`typeof window.api.onNotificationClick`), "function")
    const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
      "window.api.awaitInitialization(() => {})",
    )
    const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
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
    const session = await api("/session", "POST", { title: "System Notification QA" })
    const route = `/${Buffer.from(directory).toString("base64url")}/session/${session.id}`
    const windowExpression = `process.mainModule.require("electron").BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(${JSON.stringify(new URL(target.url).origin + "/")}))`
    const navigate = (route: string) =>
      main.evaluate(`${windowExpression}.webContents.send("notification-click", ${JSON.stringify(route)})`)
    try {
      log(`created test session=${session.id}`)
      await api("/provider")
      log("mock provider ready; opening session")
      await navigate(route)
      await wait("session renderer", () =>
        cdp.evaluate(
          `document.querySelector('[data-component="session-page"]')?.dataset.sessionId === ${JSON.stringify(session.id)}`,
        ),
      )
      await navigate("/")
      await main.evaluate(
        foreground ? `${windowExpression}.show(); ${windowExpression}.focus()` : `${windowExpression}.minimize()`,
      )
      await wait("window focus policy", () => main.evaluate(`${foreground ? "" : "!"}${windowExpression}.isFocused()`))
      await api(`/session/${session.id}/prompt_async`, "POST", {
        agent: "build",
        model: { providerID: "notification-qa", modelID: "test" },
        parts: [{ type: "text", text: "Run notification QA tools" }],
      })
      log(`sent real assistant message session=${session.id}`)
      await wait(
        "permission and question in sidecar",
        async () =>
          (await api("/permission")).some((item: any) => item.sessionID === session.id) &&
          (await api("/question")).some((item: any) => item.sessionID === session.id),
      )
      await wait("two native attention notifications", () =>
        main.evaluate(
          `globalThis.__systemNotificationQA.notifications.filter(n => n.body.includes("System Notification QA")).length === 2`,
        ),
      )
      await wait("native notification delivery", () =>
        main.evaluate(`globalThis.__systemNotificationQA.events.length >= 2`),
      )
      const events = await main.evaluate<string[]>("globalThis.__systemNotificationQA.events")
      assert.deepEqual(events, ["shown", "shown"], "both native show callbacks must fire")
      log(`PASS permission/question native callbacks foreground=${foreground}; OS visibility NOT verified by callbacks`)

      if (nativeClick) {
        log("waiting for a REAL notification-center/banner click; no synthetic click is dispatched")
        await wait("real OS notification click", () =>
          main.evaluate(
            `globalThis.__systemNotificationQA.clicks.some(body => body.includes("System Notification QA"))`,
          ),
        )
        log("PASS real OS notification click received")
      } else {
        // Callback wiring test only. This does not verify OS presentation or clicks.
        await main.evaluate(`(() => {
        const n = globalThis.__systemNotificationQA.notifications.find(n => n.body.includes("System Notification QA"));
        n.emit("close"); n.emit("click");
      })()`)
        log("callback wiring checked using synthetic events; real OS click NOT verified")
      }
      await wait("notification navigated to originating session", () =>
        cdp.evaluate(
          `document.querySelector('[data-component="session-page"]')?.dataset.sessionId === ${JSON.stringify(session.id)}`,
        ),
      )
      assert.equal(await main.evaluate(`${windowExpression}.isMinimized()`), false)
      assert.equal(await main.evaluate(`${windowExpression}.isFocused()`), true)
      log("PASS notification callback restores, focuses, and navigates the Electron window")

      const count = await main.evaluate<number>("globalThis.__systemNotificationQA.notifications.length")
      await cdp.evaluate(`window.api.showNotification("Foreground QA", "Must be suppressed")`)
      assert.equal(await main.evaluate("globalThis.__systemNotificationQA.notifications.length"), count)
      log("PASS focused window suppresses native notifications")

      const permission = (await api("/permission")).find((item: any) => item.sessionID === session.id)
      const question = (await api("/question")).find((item: any) => item.sessionID === session.id)
      await api(`/permission/${permission.id}/reply`, "POST", { reply: "once" })
      await api(`/question/${question.id}/reply`, "POST", { answers: [["Continue"]] })
      await wait("assistant reply received", async () =>
        (await api(`/session/${session.id}/message`)).some((message: any) =>
          message.parts.some((part: any) => part.text === "NOTIFICATION_QA_DONE"),
        ),
      )
      const messages = await api(`/session/${session.id}/message`)
      assert.ok(
        messages
          .flatMap((m: any) => m.parts)
          .some((p: any) => p.tool === "bash" && p.state.output?.includes("NOTIFICATION_SIDECAR_OK")),
      )
      await wait("received reply rendered", () =>
        cdp.evaluate(`document.body.textContent.includes("NOTIFICATION_QA_DONE")`),
      )
      log("PASS answered permission/question, verified sidecar tool output, assistant reply, and rendered reply")
    } finally {
      await api(`/session/${session.id}/abort`, "POST").catch(() => undefined)
      await navigate("/")
      await api(`/session/${session.id}`, "DELETE")
    }
  })
} finally {
  await main
    .evaluate(
      `(() => {
    const qa = globalThis.__systemNotificationQA;
    if (!qa) return;
    process.mainModule.require("electron").Notification.prototype.show = qa.original;
    qa.notifications.forEach(n => { n.removeAllListeners(); n.close() });
    delete globalThis.__systemNotificationQA;
  })()`,
    )
    .catch(() => undefined)
  main.close()
  model.stop(true)
  await rm(directory, { recursive: true, force: true })
  log("removed owned sessions, temporary config, and native test notifications")
}
