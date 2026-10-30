import { access } from "node:fs/promises"

if (process.argv.includes("--version")) {
  console.log("pi-fixture-1.0.4")
  process.exit(0)
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n")
const sessionId = `pi-fixture-${process.pid}`
let count = 0
let input = ""
const handle = async (command) => {
  const respond = (data) => emit({ type: "response", id: command.id, command: command.type, success: true, data })
  if (command.type === "get_state" && process.argv.includes("--delay-state")) {
    emit({ type: "startup_waiting" })
    return
  }
  if (command.type === "get_state")
    return respond({
      sessionId,
      model: { provider: "fixture", id: "pi-test" },
      cwd: process.cwd(),
      home: process.env.PI_CODING_AGENT_DIR,
      args: process.argv.slice(2),
    })
  if (command.type === "delayed") {
    setTimeout(() => respond({ value: command.value }), command.delay)
    return
  }
  if (command.type === "never") return
  if (command.type === "reject")
    return emit({ type: "response", id: command.id, command: command.type, success: false, error: "Rejected command" })
  if (command.type === "extension_ui_response") return
  if (command.type === "abort" || command.type === "clear_queue") return respond({})
  if (command.type !== "prompt") return respond({})
  const prompt = command.message
  if (prompt === "handled") return respond({ disposition: "handled" })
  if (prompt === "exit") return process.exit(7)
  if (prompt === "bad") return process.stdout.write("not-json\n")
  respond({ disposition: "started" })
  emit({ type: "agent_start" })
  emit({ type: "message_start", message: { role: "user", content: prompt } })
  emit({ type: "message_start", message: { role: "assistant", content: [] } })
  if (prompt === "hang" || prompt.includes("PI_STOP_REQUEST")) {
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PI_STOP_PARTIAL" },
    })
    return
  }
  if (process.env.PI_RPC_GATE && count === 0) {
    const deadline = Date.now() + 20000
    while (true) {
      try {
        await access(process.env.PI_RPC_GATE)
        break
      } catch {}
      if (Date.now() > deadline) throw new Error("Pi fixture gate timeout")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const text = prompt === "unicode" ? "你好\u2028世界\u2029done" : `PI_REPLY_${++count}: ${prompt}`
  const line = Buffer.from(
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    }) + "\n",
  )
  // Deliberately split a multibyte UTF-8 character across chunks.
  const split = Math.max(1, line.indexOf(Buffer.from("你")) + 1)
  process.stdout.write(line.subarray(0, split))
  process.stdout.write(line.subarray(split))
  emit({ type: "tool_execution_start", toolCallId: `read-${count}`, toolName: "read", args: { path: "README.md" } })
  emit({
    type: "tool_execution_end",
    toolCallId: `read-${count}`,
    toolName: "read",
    result: { content: [{ type: "text", text: "fixture file contents" }] },
    isError: false,
  })
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: prompt === "error" ? "error" : "stop",
      errorMessage: prompt === "error" ? "Provider fixture failed" : undefined,
    },
  })
  emit({ type: "agent_end", willRetry: prompt === "retry" })
  if (prompt === "retry") {
    emit({ type: "agent_start" })
    emit({ type: "message_start", message: { role: "assistant", content: [] } })
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RECOVERED_AFTER_AGENT_END" }],
        stopReason: "stop",
      },
    })
  }
  emit({ type: "agent_settled" })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  input += chunk
  let index
  while ((index = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, index)
    input = input.slice(index + 1)
    if (line.trim())
      void handle(JSON.parse(line)).catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }
})
process.stdin.on("end", () => process.exit(0))
