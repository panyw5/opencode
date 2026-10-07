// P0-D-03 spike: standalone WS echo server for validating the bridge client in
// Electron main. Run: bun packages/desktop/scripts/spike-bridge-echo.ts [port]
// Echoes {type:"resp", id, result: payload} for {type:"cmd", id, ...payload}.

const port = Number(process.argv[2] ?? 9777)

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return
    return new Response("upgrade required", { status: 426 })
  },
  websocket: {
    open(ws) {
      console.log(`[echo] client connected`)
      ws.send(JSON.stringify({ type: "hello", ts: Date.now() }))
    },
    message(ws, message) {
      const text = message.toString()
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        ws.send(JSON.stringify({ type: "resp", id: "?", error: "bad json" }))
        return
      }
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "resp", id: parsed.id, result: { pong: true, ts: Date.now() } }))
        return
      }
      ws.send(JSON.stringify({ type: "resp", id: parsed.id, result: { echoed: parsed } }))
    },
    close() {
      console.log(`[echo] client disconnected`)
    },
  },
})

console.log(`[echo] listening on ws://127.0.0.1:${port}`)
