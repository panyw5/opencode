import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const log = (value: string) => console.log(`[revert-command-e2e] ${value}`)

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development renderer")
  const navigation = `${new URL(target.url).origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
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
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 240; i++) {
      if (await predicate()) return
      await Bun.sleep(250)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const previousScope = await cdp.evaluate<string | undefined>(
    "document.querySelector('[data-prompt-scope]')?.getAttribute('data-prompt-scope')",
  )
  const session = await request("/session", "POST", {
    title: "QA first slash command revert",
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
  })
  const navigate = async (dir: string, id: string) => {
    const route = `/${Buffer.from(dir).toString("base64url")}/session/${id}`
    await cdp.evaluate(
      `(()=>{void import(${JSON.stringify(navigation)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)}));return true})()`,
    )
  }
  const root = `[data-session-id="${session.id}"]`
  const editor = `document.querySelector('${root} [data-component=prompt-input]')`
  const rollback = `document.querySelector('${root} button[aria-label=重置到此点]:not(:disabled)')`
  const fill = async (text: string) => {
    await cdp.evaluate(
      `(() => { const e=${editor};e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r) })()`,
    )
    await cdp.call("Input.insertText", { text })
  }
  const commandAction = async (name: "undo" | "redo", messageID?: string) => {
    await fill(`/${name}`)
    const option = `document.querySelector('[data-slash-id="session.${name}"]')`
    await wait(`slash ${name} option`, () => cdp.evaluate(`!!${option}`))
    await cdp.evaluate(`${option}.click()`)
    await wait(
      `${name} confirmed boundary`,
      async () => (await request(`/session/${session.id}`)).revert?.messageID === messageID,
    )
    await wait(`${name} settled controls`, () =>
      cdp.evaluate(`!!document.querySelector('${root}[data-history-phase="idle"]')`),
    )
  }
  try {
    log(`created sid=${session.id}`)
    await navigate(directory, session.id)
    await wait("composer", () =>
      cdp.evaluate(`!!document.querySelector('[data-session-id="${session.id}"] [data-component=prompt-input]')`),
    )
    const invocation = "/test Reply with exactly REVERT_COMMAND_OK. Do not use tools."
    let commandError: unknown
    const command = request(`/session/${session.id}/command`, "POST", {
      command: "test",
      arguments: invocation.slice("/test ".length),
      agent: "build",
      model: "axonhub-codex/gpt-6.1-sol",
    }).catch((error) => {
      commandError = error
      log(`command failed error=${String(error)}`)
    })
    let messageID = ""
    await wait("command persisted", async () => {
      if (commandError) throw commandError
      const rows = await request(`/session/${session.id}/message`)
      const row = rows.find((row: any) => row.info.role === "user")
      messageID = row?.info.id ?? ""
      return row?.parts.some((part: any) => part.metadata?.kind === "command-invocation" && part.text === invocation)
    })
    log(`sidecar received first slash invocation sid=${session.id} message=${messageID}`)
    await wait("command reply", async () => {
      const rows = await request(`/session/${session.id}/message`)
      return rows.some(
        (row: any) =>
          row.info.role === "assistant" &&
          row.info.time.completed &&
          row.parts.some((part: any) => part.type === "text" && part.text.includes("REVERT_COMMAND_OK")),
      )
    })
    log("sidecar returned command reply")
    await command
    const seeds: string[] = []
    for (const text of ["QA second turn", "QA third turn"]) {
      await request(`/session/${session.id}/message`, "POST", {
        noReply: true,
        agent: "build",
        model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
        parts: [{ type: "text", text }],
      })
      const rows = await request(`/session/${session.id}/message`)
      seeds.push(rows.filter((row: any) => row.info.role === "user").at(-1).info.id)
    }
    await wait("rollback action", () => cdp.evaluate(`!!${rollback}`))
    await cdp.evaluate(`${rollback}.click()`)
    await wait("revert stored", async () => (await request(`/session/${session.id}`)).revert?.messageID === messageID)
    await wait("slash invocation restored", () =>
      cdp.evaluate(`${editor}?.textContent === ${JSON.stringify(invocation)}`),
    )
    log("PASS first slash command restored with arguments")
    await commandAction("redo", seeds[0])
    await commandAction("redo", seeds[1])
    await commandAction("redo")
    await commandAction("undo", seeds[1])
    await commandAction("undo", seeds[0])
    await commandAction("undo", messageID)
    await wait("undo restored original slash invocation", () =>
      cdp.evaluate(`${editor}?.textContent === ${JSON.stringify(invocation)}`),
    )
    log("PASS undo/redo restore all three user turns one boundary at a time through the same controller")

    // Edit the restored draft and submit normally, exercising sidecar cleanup of the reverted turn.
    const plain = "Reply with exactly REVERT_PLAIN_OK. Do not use tools."
    await cdp.evaluate(`(() => {
      const editor=${editor}; editor.focus();
      const range=document.createRange();range.selectNodeContents(editor);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    })()`)
    await cdp.call("Input.insertText", { text: plain })
    await wait("edited send enabled", () =>
      cdp.evaluate(`!!document.querySelector('${root} button[aria-label=发送]:not(:disabled)')`),
    )
    await cdp.evaluate(`document.querySelector('${root} button[aria-label=发送]').click()`)
    let plainID = ""
    await wait("edited reply", async () => {
      const rows = await request(`/session/${session.id}/message`)
      const user = rows.find((row: any) => row.info.role === "user")
      plainID = user?.info.id ?? ""
      return (
        plainID !== messageID &&
        rows.some(
          (row: any) =>
            row.info.role === "assistant" &&
            row.info.time.completed &&
            row.parts.some((part: any) => part.type === "text" && part.text.includes("REVERT_PLAIN_OK")),
        )
      )
    })
    log(`sidecar received edited prompt and returned reply message=${plainID}`)
    await wait("ordinary rollback action", () => cdp.evaluate(`!!${rollback}`))
    await cdp.evaluate(`${rollback}.click()`)
    await wait(
      "ordinary revert stored",
      async () => (await request(`/session/${session.id}`)).revert?.messageID === plainID,
    )
    await wait("ordinary prompt restored", () => cdp.evaluate(`${editor}?.textContent === ${JSON.stringify(plain)}`))
    log("PASS ordinary first prompt still restored")
  } finally {
    await request(`/session/${session.id}/abort`, "POST").catch(() => {})
    await request(`/session/${session.id}`, "DELETE")
    if (previousScope) {
      const [dir, id] = JSON.parse(previousScope)
      if (dir && id) await navigate(dir, id)
    }
    log("owned test session cleaned")
  }
})
