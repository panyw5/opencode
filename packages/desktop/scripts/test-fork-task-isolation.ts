import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (text: string) => console.log(`[fork-task-isolation] ${text}`)
const directory = await realpath(await mkdtemp("/tmp/opencode-fork-task-"))
let resumeID: string | undefined
let childCalls = 0
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean; messages: Array<{ role: string; content: unknown }> }
    const user = body.messages.findLast((message) => message.role === "user")
    const text = JSON.stringify(user?.content)
    const last = body.messages.at(-1)
    const child = text.includes("FORK_QA_CHILD")
    const call = !child && last?.role === "user" && /FORK_QA_(CREATE|FOREIGN|FRESH|RESUME)/.test(text)
    if (child) childCalls++
    log(`model request child=${child} task=${call} lastRole=${last?.role} childCalls=${childCalls}`)
    const content = child ? "FORK_QA_CHILD_OK" : "FORK_QA_DONE"
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content } }] })
    const params = {
      description: text.includes("CREATE") ? "QA original child" : "QA fork child",
      prompt: "FORK_QA_CHILD: reply with FORK_QA_CHILD_OK without using tools.",
      subagent_type: "general",
      ...(/FORK_QA_(FOREIGN|RESUME)/.test(text) ? { task_id: resumeID } : {}),
    }
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: `qa-${Date.now()}`,
              type: "function",
              function: { name: "task", arguments: JSON.stringify(params) },
            },
          ],
        }
      : { content }
    const chunk = (delta: object, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "fork-task-qa", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    return new Response(
      chunk({ role: "assistant" }) + chunk(delta) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})

type Session = { id: string; parentID?: string }
type Message = { info: { id: string; role: string }; parts: any[] }
try {
  await Bun.write(
    join(directory, "opencode.json"),
    JSON.stringify({
      model: "fork-qa/test",
      small_model: "fork-qa/test",
      formatter: false,
      lsp: false,
      permission: "allow",
      agent: { general: { model: "fork-qa/test" } },
      provider: {
        "fork-qa": {
          npm: "@ai-sdk/openai-compatible",
          name: "Fork isolation QA",
          env: [],
          options: { apiKey: "loopback-only", baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: {
            test: { name: "Fork QA", limit: { context: 100000, output: 10000 }, cost: { input: 0, output: 0 } },
          },
        },
      },
    }),
  )
  await withCdp(async (cdp, target) => {
    assert.match(target.url, /^http:\/\/localhost:5173\//)
    const connection = await cdp.evaluate<{ url: string; username?: string; password: string }>(
      "window.api.awaitInitialization(() => {})",
    )
    const previous = new URL(target.url).pathname + new URL(target.url).search
    const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(connection.url + path, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${connection.username || "opencode"}:${connection.password}`).toString("base64")}`,
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(directory),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`)
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
    }
    const prompt = async (id: string, text: string) => {
      log(`send session=${id} marker=${text}`)
      const reply = await api<Message>(`/session/${id}/message`, "POST", {
        agent: "build",
        model: { providerID: "fork-qa", modelID: "test" },
        parts: [{ type: "text", text }],
      })
      const messages = await api<Message[]>(`/session/${id}/message`)
      assert.ok(
        reply.parts.some((part) => part.text === "FORK_QA_DONE"),
        "current turn's parent reply received",
      )
      return messages
    }
    const taskParts = (messages: Message[]) =>
      messages.flatMap((message) => message.parts).filter((part) => part.type === "tool" && part.tool === "task")
    const navSource = `/@fs${resolve(import.meta.dir, "../../app/src/utils/notification-click.ts")}`
    const navigate = (route: string) =>
      cdp.evaluate(`(() => {
      void import(${JSON.stringify(navSource)}).then(m => m.handleNotificationClick(${JSON.stringify(route)}));
      return true;
    })()`)
    let source: Session | undefined
    let fork: Session | undefined
    try {
      source = await api<Session>("/session", "POST", { title: "QA fork task original" })
      await api("/provider")
      const original = taskParts(await prompt(source.id, "FORK_QA_CREATE"))
      assert.equal(original.length, 1)
      assert.equal(original[0].state.status, "completed")
      resumeID = original[0].state.metadata.sessionId
      assert.ok(resumeID)
      const childBefore = await api<Message[]>(`/session/${resumeID}/message`)
      assert.ok(childBefore.some((message) => message.parts.some((part) => part.text === "FORK_QA_CHILD_OK")))
      assert.equal((await api<Session>(`/session/${resumeID}`)).parentID, source.id)
      log(`PASS source task completed child=${resumeID}`)

      fork = await api<Session>(`/session/${source.id}/fork`, "POST", {})
      const childCallsBefore = childCalls
      const foreign = taskParts(await prompt(fork.id, "FORK_QA_FOREIGN")).at(-1)
      assert.equal(foreign.state.status, "error", "fork must reject the original child task ID")
      assert.match(foreign.state.error, /task_id must identify a child task of the current session/)
      assert.equal(childCalls, childCallsBefore, "no model request may be sent to the source child")
      assert.deepEqual(await api(`/session/${resumeID}/message`), childBefore)
      assert.deepEqual(await api(`/session/${fork.id}/children`), [])
      log("PASS cross-session resume rejected; original child history unchanged")

      const fresh = taskParts(await prompt(fork.id, "FORK_QA_FRESH")).at(-1)
      assert.equal(fresh.state.status, "completed")
      const freshID = fresh.state.metadata.sessionId
      assert.notEqual(freshID, resumeID)
      assert.equal((await api<Session>(`/session/${freshID}`)).parentID, fork.id)
      const freshBefore = await api<Message[]>(`/session/${freshID}/message`)
      resumeID = freshID
      const resumed = taskParts(await prompt(fork.id, "FORK_QA_RESUME")).at(-1)
      assert.equal(resumed.state.status, "completed")
      assert.equal(resumed.state.metadata.sessionId, freshID)
      assert.ok((await api<Message[]>(`/session/${freshID}/message`)).length > freshBefore.length)
      assert.deepEqual(
        (await api<Session[]>(`/session/${source.id}/children`)).map((s) => s.id),
        [original[0].state.metadata.sessionId],
      )
      assert.deepEqual(
        (await api<Session[]>(`/session/${fork.id}/children`)).map((s) => s.id),
        [freshID],
      )
      assert.deepEqual(await api(`/session/${original[0].state.metadata.sessionId}/message`), childBefore)
      log("PASS fresh task and same-parent resume isolated to fork")

      await navigate(`/${Buffer.from(directory).toString("base64url")}/session/${fork.id}`)
      const deadline = Date.now() + 20000
      let rendered = false
      while (Date.now() < deadline) {
        rendered = await cdp.evaluate<boolean>(`(() => {
          const page = document.querySelector('[data-component="session-page"][data-session-id="${fork.id}"]');
          return !!page && page.textContent.includes('QA fork child') && page.textContent.includes('FORK_QA_DONE');
        })()`)
        if (rendered) break
        await Bun.sleep(100)
      }
      assert.ok(rendered, "real Electron renderer shows fork task and received reply")
      log("PASS Electron CDP renderer displays fork child and reply")
    } finally {
      await navigate(previous)
      if (fork) await api(`/session/${fork.id}`, "DELETE")
      if (source) await api(`/session/${source.id}`, "DELETE")
      log("owned QA sessions removed; original route restored")
    }
  })
} finally {
  model.stop(true)
  await rm(directory, { recursive: true, force: true })
}
