// Evaluate a JS expression in a CDP target and print the result.
// usage: bun scripts/spike-cdp-eval.ts <url-substring> <expression>
const [needle, expression] = process.argv.slice(2)

const targets: Array<{ url: string; webSocketDebuggerUrl: string; title: string }> =
  await (await fetch("http://127.0.0.1:9222/json/list")).json()
const target = targets.find((t) => t.url.includes(needle))
if (!target) {
  console.error(`no target matching ${needle}; have:`, targets.map((t) => t.url))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
const result = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("eval timeout")), 10_000)
  ws.addEventListener(
    "message",
    (event) => {
      const data = JSON.parse(String(event.data))
      if (data.id !== 1) return
      clearTimeout(timer)
      resolve(JSON.stringify(data.result ?? data, null, 2))
    },
    { once: false },
  )
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  )
})
console.log(result)
ws.close()
process.exit(0)
