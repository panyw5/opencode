import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const log = (text: string) => console.log(`[revert-missing-e2e] ${text}`)

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected development renderer")
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, check: () => Promise<boolean>) => {
    for (let i = 0; i < 240; i++) {
      if (await check()) return
      await Bun.sleep(250)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigation = `${new URL(target.url).origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
  const previous = await cdp.evaluate<string | undefined>(
    `document.querySelector('[data-session-id] [data-component=prompt-input]')?.closest('[data-prompt-scope]')?.getAttribute('data-prompt-scope')`,
  )
  const navigate = (path: string) =>
    cdp.evaluate(
      `(()=>{void import(${JSON.stringify(navigation)}).then(m=>m.handleNotificationClick(${JSON.stringify(path)}));return true})()`,
    )
  const session = await request("/session", "POST", {
    title: "QA missing revert boundary",
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
  })
  const root = `[data-session-id="${session.id}"]`
  const editor = `document.querySelector('${root} [data-component=prompt-input]')`
  const rollback = `document.querySelector('${root} button[aria-label="重置到此点"]:not(:disabled)')`
  const send = `document.querySelector('${root} button[aria-label="发送"]:not(:disabled)')`
  const prompt = "Reply with exactly REVERT_MISSING_OK. Do not use tools."
  const fill = async () => {
    await cdp.evaluate(
      `(()=>{const e=${editor};e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`,
    )
    await cdp.call("Input.insertText", { text: prompt })
  }
  try {
    await request(`/session/${session.id}/message`, "POST", {
      noReply: true,
      agent: "build",
      model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
      parts: [{ type: "text", text: "QA seed model for missing-boundary regression" }],
    })
    await navigate(`/${Buffer.from(directory).toString("base64url")}/session/${session.id}`)
    await wait("composer", () => cdp.evaluate(`!!${editor}`))
    // Simulate a previously accepted prompt that never reached persistent storage.
    await cdp.evaluate(`(()=>{
      window.__revertOriginalFetch=window.fetch;
      window.fetch=async (...args)=>{
        const req=args[0]; const url=req instanceof Request?req.url:String(req);
        if(url.includes('/session/${session.id}/prompt_async')) {
          window.fetch=window.__revertOriginalFetch;
          window.__revertGhost=JSON.parse(req instanceof Request?await req.clone().text():args[1].body).messageID;
          return new Response(null,{status:204});
        }
        return window.__revertOriginalFetch(...args);
      };
    })()`)
    await fill()
    await wait("send enabled", () => cdp.evaluate(`!!${send}`))
    await cdp.evaluate(`${send}.click()`)
    await wait("ghost bubble", () => cdp.evaluate(`!!window.__revertGhost && !!${rollback}`))
    const ghost = await cdp.evaluate<string>("window.__revertGhost")
    if ((await request(`/session/${session.id}/message`)).some((row: any) => row.info.id === ghost))
      throw new Error("Ghost unexpectedly persisted")
    log(`ghost visible but absent in sidecar sid=${session.id} message=${ghost}`)
    await cdp.evaluate(`[...document.querySelectorAll('${root} button[aria-label="重置到此点"]')].at(-1).click()`)
    await wait("ghost removed", () => cdp.evaluate(`!document.querySelector('${root} [data-message-id="${ghost}"]')`))
    if ((await request(`/session/${session.id}`)).revert) throw new Error("Missing boundary was marked reverted")
    await wait("reset failure completed", () =>
      cdp.evaluate(
        `!!document.querySelector('${root} button[aria-label="重置到此点"]:not(:disabled)') && !document.querySelector('${root} button[aria-label="停止"]')`,
      ),
    )
    log("PASS missing boundary is not reported as a successful reset; ghost removed")
    await fill()
    await wait("real send enabled", () => cdp.evaluate(`!!${send}`))
    await cdp.evaluate(`${send}.click()`)
    await wait("real sidecar reply", async () => {
      const rows = await request(`/session/${session.id}/message`)
      return (
        rows.filter((row: any) => row.info.role === "user").length === 2 &&
        rows.some(
          (row: any) =>
            row.info.role === "assistant" &&
            row.info.time.completed &&
            row.parts.some((part: any) => part.type === "text" && part.text.includes("REVERT_MISSING_OK")),
        )
      )
    })
    log("PASS sidecar received one real user message after the seed and returned REVERT_MISSING_OK")
    await wait("real rollback", () => cdp.evaluate(`!!${rollback}`))
    await cdp.evaluate(`[...document.querySelectorAll('${root} button[aria-label="重置到此点"]')].at(-1).click()`)
    await wait("real revert persisted", async () => !!(await request(`/session/${session.id}`)).revert)
    log("PASS normal persisted message can still be reverted")
  } finally {
    await cdp.evaluate(
      "if(window.__revertOriginalFetch)window.fetch=window.__revertOriginalFetch;delete window.__revertOriginalFetch;delete window.__revertGhost",
    )
    await request(`/session/${session.id}/abort`, "POST").catch(() => {})
    await request(`/session/${session.id}`, "DELETE")
    if (previous) {
      const [dir, id] = JSON.parse(previous)
      if (dir && id) await navigate(`/${Buffer.from(dir).toString("base64url")}/session/${id}`)
    }
    log("owned test session cleaned")
  }
})
