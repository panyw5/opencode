// Call an arbitrary CDP method on a target and print the result.
// usage: bun scripts/spike-cdp-call.ts <url-substring> <method> <params-json>
const [needle, method, paramsJson] = process.argv.slice(2)

const targets: Array<{ url: string; webSocketDebuggerUrl: string }> =
  await (await fetch("http://127.0.0.1:9222/json/list")).json()
const target = targets.find((t) => t.url.includes(needle))
if (!target) {
  console.error(`no target matching ${needle}`)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
const result = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), 10_000)
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data))
    if (data.id !== 1) return
    clearTimeout(timer)
    resolve(JSON.stringify(data.result ?? data.error ?? data, null, 2))
  })
  ws.send(JSON.stringify({ id: 1, method, params: paramsJson ? JSON.parse(paramsJson) : {} }))
})
console.log(result)
ws.close()
process.exit(0)
