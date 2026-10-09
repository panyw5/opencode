import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GPT_PRO_PARTITION, isGptProOrigin, type GptProProbeStatus } from "@opencode-ai/util/gpt-pro"
import { CdpClient, listTargets, withCdp } from "./cdp"

// P0 only. Refuses non-dev renderers, drafts and existing
// conversations. No API calls or access to installed OpenCode instances.
const endpoint = "http://127.0.0.1:9222"
const testPrompt =
  "OpenCode browser integration test. Reply with: the exact marker OPENCODE_GPT_PRO_P0_OK, a two-column Markdown table with one data row, a JavaScript code block containing const value = 42;, and the equation x^2 + y^2 = z^2 rendered as math. Do not browse or use other tools."
const out = join(tmpdir(), "opencode-gpt-pro-probe")

async function inspect(open = false): Promise<GptProProbeStatus> {
  return withCdp(async (client, target) => {
    if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://"))
      throw new Error("9222 is not an OpenCode development renderer; no page will be operated")
    const status = await client.evaluate<GptProProbeStatus>(`window.api.gptPro.${open ? "open" : "status"}()`)
    console.log(
      `[gpt-pro-probe] phase=${status.phase} model=${status.page?.model ?? "unknown"} users=${status.page?.users.length ?? 0} revision=${status.page?.revision ?? 0} htmlChars=${status.page?.answer?.html.length ?? 0}`,
    )
    if (status.detail) console.log(`[gpt-pro-probe] detail=${status.detail}`)
    return status
  }, endpoint)
}

async function send() {
  const initial = await inspect()
  if (!initial.page?.composer || initial.page.generating)
    throw new Error("An idle, logged-in Chat page is required; no message was sent")
  if (initial.page.draft.trim() || initial.page.users.length !== 0)
    throw new Error("P0 requires an empty dedicated conversation; no draft or existing conversation will be modified")
  const targets = (await listTargets(endpoint)).filter((target) => target.type === "page" && isGptProOrigin(target.url))
  if (targets.length !== 1)
    throw new Error("Expected exactly one ChatGPT target in the development app; refusing an ambiguous page")
  const page = await CdpClient.connect(targets[0].webSocketDebuggerUrl)
  try {
    const focused = await page.evaluate<boolean>(`(() => {
      const editor = document.querySelector('#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]')
      if (!editor || (editor.innerText ?? editor.value ?? '').trim()) return false
      editor.focus()
      return document.activeElement === editor
    })()`)
    if (!focused) throw new Error("Could not focus an empty Chat composer; no message was sent")
    console.log("[gpt-pro-probe] inserting fixed integration-test prompt")
    await page.call("Input.insertText", { text: testPrompt })
    const filled = await inspect()
    if (!filled.page || filled.page.draft.trim() !== testPrompt || filled.page.users.length !== 0)
      throw new Error("Composer changed before submit; submission was not attempted")
    console.log("[gpt-pro-probe] submitting once; retries must inspect, never resend")
    await page.call("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    await page.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  } finally {
    page.close()
  }
  await watch()
}

async function watch() {
  const started = Date.now()
  const deadline = Date.now() + 30 * 60_000
  let html = ""
  let stableSince = 0
  let version = 0
  await mkdir(out, { recursive: true })
  while (Date.now() < deadline) {
    const status = await inspect()
    const state = status.page
    if (!state || !isGptProOrigin(state.url))
      throw new Error("Target page unavailable. Tracking stopped; no resend or fallback.")
    if (state.users.length > 1 || (state.users.length === 1 && state.users[0].text.trim() !== testPrompt))
      throw new Error("Dedicated conversation changed; refusing an unrelated reply")
    if (!state.users.length && Date.now() - started > 30000)
      throw new Error("Submission is unconfirmed. Original page is preserved; do not automatically resend.")
    if (state.answer?.truncated) throw new Error("Reply exceeded capture limit; P0 cannot pass with truncated output")
    const answer = state.answer
    if (answer && state.users.length === 1 && answer.userID === state.users[0].id) {
      if (html !== answer.html) {
        html = answer.html
        stableSince = Date.now()
        version++
        await writeFile(
          join(out, "latest.json"),
          JSON.stringify(
            { partition: GPT_PRO_PARTITION, version, capturedAt: new Date().toISOString(), page: state },
            null,
            2,
          ),
          { mode: 0o600 },
        )
        console.log(`[gpt-pro-probe] HTML version=${version} captured to ${out}/latest.json`)
      }
      if (!answer.complete || state.generating) stableSince = Date.now()
      if (answer.complete && !state.generating && stableSince && Date.now() - stableSince >= 3000) {
        if (!answer.text.includes("OPENCODE_GPT_PRO_P0_OK") || !html.includes("<table") || !html.includes("<code"))
          throw new Error("Reply completed but required integration-test content was not captured")
        await writeFile(join(out, "final.html"), html, { mode: 0o600 })
        console.log(`[gpt-pro-probe] P0 reply capture passed; final HTML: ${out}/final.html`)
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("P0 capture timed out. Original page is preserved; do not resend automatically.")
}

const action = process.argv[2]
try {
  if (action === "open") await inspect(true)
  else if (action === "login")
    await withCdp(async (client, target) => {
      if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://"))
        throw new Error("Not a development renderer")
      const status = await client.evaluate<{ phase: string; extensionDirectory?: string }>(
        "window.api.gptPro.loginInBrowser()",
      )
      console.log(
        `[gpt-pro-probe] login=${status.phase} extension=${status.extensionDirectory ?? "unknown"}; no credentials or connection token printed`,
      )
    }, endpoint)
  else if (action === "login-status")
    await withCdp(async (client) => {
      const status = await client.evaluate<{ phase: string; importedCookies?: number }>(
        "window.api.gptPro.loginStatus()",
      )
      console.log(`[gpt-pro-probe] login=${status.phase} importedCookies=${status.importedCookies ?? 0}`)
    }, endpoint)
  else if (action === "inspect") await inspect()
  else if (action === "send") await send()
  else if (action === "watch") await watch()
  else
    throw new Error(
      "Usage: bun packages/desktop/scripts/gpt-pro-probe.ts open|inspect|send|watch. Requires the dev Electron app on 9222.",
    )
} catch (error) {
  console.error(`[gpt-pro-probe] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
