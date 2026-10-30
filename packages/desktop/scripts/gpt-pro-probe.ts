import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { withCdp } from "./cdp"

// Explicit dev diagnostic only. Managed submissions always pass through the controller's durable boundary.
const prompt =
  "OpenCode integration test. Return OPENCODE_GPT_PRO_P0_OK, a two-column Markdown table, a JavaScript code block and the equation x^2 + y^2 = z^2."
const request = <T>(expression: string) =>
  withCdp(async (client, target) => {
    if (!target.url.includes("localhost:5173")) throw Error("Requires the development renderer on 9222")
    return client.evaluate<T>(expression)
  })
async function watch(id: string) {
  if (!id) throw Error("watch requires an existing consultation ID; nothing was sent")
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const job = await request<GptProJob>(`window.api.gptPro.command({action:'read',id:${JSON.stringify(id)}})`)
    console.info(`[gpt-pro-probe] id=${id} phase=${job.phase} revision=${job.revision}`)
    if (job.prompt !== prompt) throw Error("Refusing an unrelated consultation")
    if (["paused", "failed", "send_uncertain", "cancelled", "interrupted"].includes(job.phase))
      throw Error(`Stopped at ${job.phase}; original page retained, never resend automatically`)
    if (job.phase === "completed") {
      if (!job.text?.includes("OPENCODE_GPT_PRO_P0_OK")) throw Error("Completion marker missing")
      const root = join(tmpdir(), "opencode-gpt-pro-probe")
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(join(root, "latest.json"), JSON.stringify(job), { mode: 0o600 })
      console.info(`[gpt-pro-probe] completed evidence=${root}/latest.json`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw Error("Tracking timed out; no automatic resend")
}
async function main() {
  const action = process.argv[2]
  if (action === "send") {
    const job = await request<GptProJob>(`window.api.gptPro.command({prompt:${JSON.stringify(prompt)}})`)
    console.info(`[gpt-pro-probe] controller admitted id=${job.id}; no blind keyboard submission`)
    await watch(job.id)
  } else if (action === "watch") await watch(process.argv[3])
  else if (["open", "status", "inspect", "login", "login-status"].includes(action)) {
    const method = action === "login" ? "loginInBrowser" : action === "login-status" ? "loginStatus" : action
    const value = await request<unknown>(`window.api.gptPro.${method}()`)
    // Diagnostic page bodies are deliberately not printed to the terminal.
    console.info(`[gpt-pro-probe] ${action} completed resultAvailable=${value !== undefined}`)
  } else throw Error("Usage: gpt-pro-probe.ts open|status|inspect|send|watch <id>|login|login-status")
}
void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
