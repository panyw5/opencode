import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withCdp } from "./cdp"

const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-streaming-snapshot-")))
const blocks = Array.from(
  { length: 16 },
  (_, i) =>
    `## Section ${i + 1}\n\nSNAPSHOT_${i}_START **bold text** and $x^2$.\n\n- item one\n- item two\n\n\`\`\`ts\nconst value${i} = ${i}\n\`\`\`\n\nSNAPSHOT_${i}_END\n\n`,
)
const expected = blocks.join("")
let sent = ""
let finished = false
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean }
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Test title" } }] })
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          const emit = (delta: object, finish_reason: string | null = null) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: "streaming-regression", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              ),
            )
          emit({ role: "assistant" })
          for (let i = 0; i < expected.length; i += 19) {
            const content = expected.slice(i, i + 19)
            sent += content
            emit({ content })
            await Bun.sleep(80)
          }
          emit({}, "stop")
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
          finished = true
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})

await Bun.write(
  join(directory, "opencode.json"),
  JSON.stringify({
    model: "streaming-qa/test",
    formatter: false,
    lsp: false,
    provider: {
      "streaming-qa": {
        npm: "@ai-sdk/openai-compatible",
        name: "Streaming regression",
        env: [],
        options: { apiKey: "loopback-only", baseURL: `http://127.0.0.1:${model.port}/v1` },
        models: {
          test: {
            name: "Streaming regression",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }),
)

try {
  await withCdp(async (cdp, target) => {
    assert.match(target.url, /^http:\/\/localhost:5173\//)
    const server = await cdp.evaluate<{ url: string; username?: string; password: string }>(
      "window.api.awaitInitialization(()=>{})",
    )
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
      Authorization: `Basic ${Buffer.from(`${server.username || "opencode"}:${server.password}`).toString("base64")}`,
    }
    const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(server.url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      assert.ok(response.ok, `${method} ${path} status=${response.status} ${response.ok ? "" : await response.text()}`)
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
    }
    const originalSession = await cdp.evaluate<{ id?: string; directory?: string }>(`(() => {
      const page = [...document.querySelectorAll('[data-component="session-page"]')].find(p=>p.getClientRects().length);
      const scope = [...document.querySelectorAll('[data-prompt-scope]')].filter(p=>p.getClientRects().length)
        .map(p=>JSON.parse(p.getAttribute('data-prompt-scope') || 'null')).find(Array.isArray);
      return { id: page?.dataset.sessionId, directory: scope?.[0] };
    })()`)
    const original =
      originalSession.id && originalSession.directory
        ? `/${Buffer.from(originalSession.directory).toString("base64url")}/session/${originalSession.id}`
        : "/"
    const navSource = `/@fs${resolve(import.meta.dir, "../../app/src/utils/notification-click.ts")}`
    const navigate = async (route: string) => {
      await cdp.evaluate(
        `(() => { void import(${JSON.stringify(navSource)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)})); return true })()`,
      )
      const id = route.split("/session/")[1]
      if (!id) return
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const ready = await cdp
          .evaluate<boolean>(`!!document.querySelector('[data-component="session-page"][data-session-id="${id}"]')`)
          .catch(() => false)
        if (ready) return
        await Bun.sleep(150)
      }
      throw new Error(`Navigation did not mount session ${id}`)
    }
    const route = (id: string) => `/${Buffer.from(directory).toString("base64url")}/session/${id}`
    const session = await api<{ id: string }>("/session", "POST", { title: "Streaming snapshot regression" })
    const other = await api<{ id: string }>("/session", "POST", { title: "Streaming switch target" })
    try {
      await api("/provider")
      await api(`/session/${session.id}/prompt_async`, "POST", {
        agent: "build",
        model: { providerID: "streaming-qa", modelID: "test" },
        parts: [{ type: "text", text: "Emit the controlled streaming Markdown test response." }],
      })
      console.log(`[streaming-snapshot-test] sent prompt session=${session.id}`)
      const startDeadline = Date.now() + 10000
      while (!sent && Date.now() < startDeadline) await Bun.sleep(100)
      assert.ok(sent, "sidecar did not start the controlled model stream; inspect backend logs")
      await navigate(route(session.id))
      const deadline = Date.now() + 45000
      let snapshots = 0
      let switched = false
      let reloaded = false
      let previous = ""
      while (Date.now() < deadline) {
        const messages = await api<
          Array<{ info: { role: string; time: { completed?: number } }; parts: Array<{ type: string; text?: string }> }>
        >(`/session/${session.id}/message`)
        const assistant = messages.find((item) => item.info.role === "assistant")
        const text =
          assistant?.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text || "")
            .join("") || ""
        if (text) {
          assert.ok(text.startsWith(previous), "API snapshot lost previously received content")
          assert.ok(sent.startsWith(text), "API snapshot does not match sent response")
          previous = text
          snapshots++
        }
        if (!switched && text.length > 400 && !finished) {
          await navigate(route(other.id))
          await Bun.sleep(250)
          await navigate(route(session.id))
          switched = true
          console.log(`[streaming-snapshot-test] switched back during stream text=${text.length}`)
        }
        if (!reloaded && text.length > 900 && !finished) {
          await cdp.call("Page.reload")
          await Bun.sleep(1500)
          await navigate(route(session.id))
          const readyDeadline = Date.now() + 10000
          while (Date.now() < readyDeadline) {
            const ready = await cdp.evaluate<boolean>(
              `!!document.querySelector('[data-component="session-page"][data-session-id="${session.id}"] [data-component="text-part"]')`,
            )
            if (ready) break
            await Bun.sleep(150)
          }
          reloaded = true
          console.log(`[streaming-snapshot-test] forced cold renderer reload text=${text.length}`)
        }
        if (switched && text.length > 500) {
          const dom = await cdp.evaluate<{
            text: string
            headings: number
            bold: number
            code: number
            pages: string[]
          }>(`(() => {
            const page = document.querySelector('[data-component="session-page"][data-session-id="${session.id}"]');
            const root = page?.querySelector('[data-component="text-part"]');
            return { text: root?.textContent || "", headings: root?.querySelectorAll("h2").length || 0,
              bold: root?.querySelectorAll("strong").length || 0, code: root?.querySelectorAll("pre").length || 0,
              pages: [...document.querySelectorAll('[data-component="session-page"]')].map(p=>p.dataset.sessionId) };
          })()`)
          assert.ok(
            dom.text.includes("SNAPSHOT_0_START"),
            `reopened stream lost its first paragraph ${JSON.stringify(dom)}`,
          )
          assert.ok(dom.text.includes("SNAPSHOT_0_END"), "reopened stream lost its first completed section")
          assert.ok(dom.headings && dom.bold && dom.code, "reopened stream lost Markdown structure")
        }
        if (assistant?.info.time.completed) {
          assert.equal(text, expected)
          assert.ok(switched && reloaded && snapshots > 10, "must test active snapshots, navigation and cold reload")
          console.log(
            `[streaming-snapshot-test] PASS snapshots=${snapshots} chars=${text.length} switched=true reloaded=true sent-and-received=true`,
          )
          return
        }
        await Bun.sleep(150)
      }
      throw new Error("Streaming response did not finish before timeout")
    } finally {
      await api(`/session/${session.id}/abort`, "POST").catch(() => {})
      await navigate(original)
      await api(`/session/${session.id}`, "DELETE")
      await api(`/session/${other.id}`, "DELETE")
      console.log("[streaming-snapshot-test] removed owned sessions and restored original route")
    }
  })
} finally {
  model.stop(true)
  await rm(directory, { recursive: true, force: true })
}
