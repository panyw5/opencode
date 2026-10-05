// One-off: verify Input.dispatchMouseEvent mouseWheel scrolls a real view.
// Usage: bun scripts/audit-scroll-view.ts <browserWS> <url-substring>
const [wsUrl, needle] = process.argv.slice(2)
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map<number, (v: any) => void>()
ws.onmessage = (e) => {
  const f = JSON.parse(String(e.data))
  if (f.id && pending.has(f.id)) {
    pending.get(f.id)(f)
    pending.delete(f.id)
  }
}
const send = (method: string, params?: unknown, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }))
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000)
  })
await new Promise((res) => ws.onopen = res)
const { result } = await send("Target.getTargets", {})
const pages = (result.targetInfos ?? []).filter((t: any) => t.type === "page" && t.url.includes(needle))
console.log("matching pages:", pages.map((p: any) => p.url.slice(0, 60)))
if (!pages.length) process.exit(1)
const { result: attached } = await send("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true })
const sid = attached.sessionId
const scrollY = async () => {
  const r = await send("Runtime.evaluate", { expression: "window.scrollY", returnByValue: true }, sid)
  return r.result?.result?.value
}
const before = await scrollY()
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 600 }, sid)
await new Promise((r) => setTimeout(r, 300))
const after = await scrollY()
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: -600 }, sid)
await new Promise((r) => setTimeout(r, 300))
const back = await scrollY()
console.log(JSON.stringify({ before, after, back, wheelWorks: after > before && back < after }))
ws.close()
