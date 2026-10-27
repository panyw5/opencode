import { withCdp } from "./cdp"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const log = (text: string) => console.log(`[history-source-e2e] ${text}`)
const root = fileURLToPath(new URL("../../../", import.meta.url))
const temporary = await mkdtemp("/tmp/opencode-history-e2e-")
const directory = `${temporary}/workspace`
await mkdir(directory)
await Bun.$`git init -q ${directory}`.quiet()
let provider: unknown
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected development Electron")
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const response = await fetch(`${connection.url}/config`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
    },
  })
  if (!response.ok) throw new Error(`Config HTTP ${response.status}`)
  provider = (await response.json()).provider?.["axonhub-codex"]
})
if (!provider) throw new Error("Development sidecar has no axonhub-codex provider")
const port = 4098
const password = crypto.randomUUID()
const output = "/tmp/opencode-history-source-e2e.log"
await Bun.write(`${temporary}/models.json`, "{}")
await mkdir(`${temporary}/data/opencode`, { recursive: true })
const auth = await Bun.file(`${process.env.HOME}/.local/share/opencode/auth.json`)
  .json()
  .catch(() => ({}))
await Bun.write(
  `${temporary}/data/opencode/auth.json`,
  JSON.stringify(auth["axonhub-codex"] ? { "axonhub-codex": auth["axonhub-codex"] } : {}),
)
await Bun.write(output, "")
const child = Bun.spawn(
  [
    "bun",
    "run",
    "--conditions=browser",
    `${root}packages/opencode/src/index.ts`,
    "--print-logs",
    "serve",
    "--port",
    String(port),
    "--hostname",
    "127.0.0.1",
  ],
  {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: `${temporary}/config`,
      XDG_DATA_HOME: `${temporary}/data`,
      OPENCODE_CONFIG_DIR: `${temporary}/config/opencode`,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_MODELS_PATH: `${temporary}/models.json`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { "axonhub-codex": provider },
        model: "axonhub-codex/gpt-6.1-sol",
        plugin: [],
        mcp: {},
        permission: { "*": "deny" },
      }),
    },
    stdout: Bun.file(output),
    stderr: Bun.file(output),
  },
)
const sessions: string[] = []
const request = async (path: string, method = "GET", body?: unknown, expected = 200) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const value = response.status === 204 ? undefined : await response.json()
  if (response.status !== expected) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(value)}`)
  return value
}
const send = (sessionID: string, text: string, extra: Record<string, unknown> = {}) =>
  request(`/session/${sessionID}/message`, "POST", {
    agent: "build",
    model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
    parts: [{ type: "text", text }],
    ...extra,
  })
try {
  for (let i = 0; ; i++) {
    try {
      await request("/global/health")
      break
    } catch (error) {
      if (i > 120 || child.exitCode !== null) throw error
      await Bun.sleep(250)
    }
  }
  log(`source backend ready pid=${child.pid} logs=${output}`)
  const session = await request("/session", "POST", { title: "QA unified history source" })
  sessions.push(session.id)
  const first = await send(session.id, "Reply with exactly HISTORY_FIRST_OK. Do not use tools.")
  if (!first.parts.some((part: any) => part.type === "text" && part.text.includes("HISTORY_FIRST_OK")))
    throw new Error("First reply missing")
  let rows = await request(`/session/${session.id}/message`)
  const original = rows.find((row: any) => row.info.role === "user").info.id
  log(`source received first prompt and returned HISTORY_FIRST_OK user=${original}`)
  await request(`/session/${session.id}/revert`, "POST", { messageID: original })
  if ((await request(`/session/${session.id}`)).revert?.messageID !== original) throw new Error("Revert not persisted")
  await request(`/session/${session.id}/unrevert`, "POST")
  if ((await request(`/session/${session.id}`)).revert) throw new Error("Restore not persisted")
  await request(`/session/${session.id}/revert`, "POST", { messageID: original })
  const second = await send(session.id, "Reply with exactly HISTORY_RESEND_OK. Do not use tools.")
  if (!second.parts.some((part: any) => part.type === "text" && part.text.includes("HISTORY_RESEND_OK")))
    throw new Error("Resend reply missing")
  rows = await request(`/session/${session.id}/message`)
  if (
    rows.some((row: any) => row.info.id === original) ||
    rows.filter((row: any) => row.info.role === "user").length !== 1
  )
    throw new Error("Reverted history survived resend")
  if ((await request(`/session/${session.id}`)).revert) throw new Error("Cleanup did not clear revert")
  log("PASS source revert, restore, resend cleanup and real HISTORY_RESEND_OK reply")
  const absent = await request(`/session/${session.id}/revert`, "POST", { messageID: original }, 404)
  if (absent.name !== "NotFoundError") throw new Error("Missing boundary lacks typed error")
  const mixed = await request("/session", "POST", { title: "QA mixed IDs and concurrent history" })
  sessions.push(mixed.id)
  for (const messageID of ["msg_z_earliest", "msg_m_boundary", "msg_a_latest"])
    await send(mixed.id, messageID, { messageID, noReply: true })
  await Promise.all(
    ["msg_m_boundary", "msg_a_latest"].map((messageID) =>
      request(`/session/${mixed.id}/revert`, "POST", { messageID }),
    ),
  )
  const boundary = (await request(`/session/${mixed.id}`)).revert.messageID
  await send(mixed.id, "replacement", { noReply: true })
  const remaining = (await request(`/session/${mixed.id}/message`)).map((row: any) => row.info.id)
  if (
    !remaining.includes("msg_z_earliest") ||
    remaining.includes("msg_a_latest") ||
    (boundary === "msg_m_boundary" && remaining.includes("msg_m_boundary"))
  )
    throw new Error("Concurrent mixed-ID suffix is wrong")
  log(`PASS concurrent source mutations and chronological cleanup boundary=${boundary}`)
} finally {
  for (const sessionID of sessions)
    await request(`/session/${sessionID}`, "DELETE").catch((error) =>
      log(`cleanup error sid=${sessionID} error=${String(error)}`),
    )
  child.kill()
  await child.exited
  await rm(temporary, { recursive: true, force: true })
  log("owned source backend, sessions and temporary workspace cleaned")
}
