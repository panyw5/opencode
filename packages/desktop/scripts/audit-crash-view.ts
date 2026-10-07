// Throwaway audit script: crash a WebContentsView renderer via CDP
// Target.crash to verify the render-process-gone teardown path (F3).
import { BrowserController, USER_PARTITION } from "../src/main/browser"

const wsUrl = process.argv[2]
if (!wsUrl) throw new Error("usage: bun crash-view.ts <browser-ws-url>")

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map<number, (v: any) => void>()
const send = (method: string, params?: unknown, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000)
  })

ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}

await new Promise((resolve) => (ws.onopen = resolve))
const { result } = await send("Target.getTargets")
const targets = result.targetInfos.filter((t: any) => t.type === "page" && t.url.includes("example.com"))
console.log(JSON.stringify(targets.map((t: any) => ({ id: t.targetId, url: t.url })), null, 1))
for (const t of targets) {
  // Electron strips Target.crash/Page.crash; chrome://crash is the classic
  // intentional-crash page and fires a real render-process-gone.
  const { result: attached } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })
  const sessionId = attached.sessionId as string
  await send("Page.enable", undefined, sessionId)
  const r = await send("Page.navigate", { url: "chrome://crash" }, sessionId)
  console.log("chrome://crash nav on", t.targetId, JSON.stringify(r))
}
ws.close()
process.exit(0)
