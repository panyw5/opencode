import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { connectCdp } from "./cdp"

// Reuse a real, already-completed QA answer. Never submit another website prompt.
const args = process.argv.slice(2)
const value = (name: string) => args[args.indexOf(name) + 1]
const id = args.includes("--id") ? value("--id") : undefined
const restoreID = args.includes("--restore-id") ? value("--restore-id") : undefined
if (!id || !restoreID || id === restoreID) throw new Error("Provide distinct --id QA-result and --restore-id viewed-result")
const output = await mkdtemp(join(tmpdir(), "opencode-lifecycle-e2e-"))
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173")) {
  client.close()
  throw new Error("Only the development renderer may run lifecycle integration tests")
}
const log = (message: string) => console.log(`[gpt-pro-lifecycle-e2e] ${message}`)
type View = { pageID?: string; partition: string; epoch?: number }
const views = () => client.evaluate<View[]>("window.api.browser.getState()")
const read = (jobID: string) =>
  client.evaluate<GptProJob>(`window.api.gptPro.command({action:'read',id:${JSON.stringify(jobID)}})`)
const pageID = `gpt-pro-page-${id}`
let opened = false
try {
  const before = await views()
  const job = await read(id)
  if (job.phase !== "completed" || !job.owner.includes("opencode-multipage-e2e-") || !job.text?.startsWith("OPENCODE_MULTIPAGE_"))
    throw new Error("The selected result is not this harness's completed multipage QA answer")
  if (before.some((page) => (page.pageID ?? page.partition) === pageID))
    throw new Error("QA page is already resident; this harness will not take it over")
  if ((await read(restoreID)).phase !== "completed") throw new Error("Restore target must be a completed result")
  const afterRead = await views()
  if (JSON.stringify(afterRead) !== JSON.stringify(before)) throw new Error("Cached read allocated or changed a native page")
  log(`cached full read verified id=${id} answerChars=${job.text.length} no native allocation`)
  await client.evaluate(`window.api.gptPro.command({action:'open',id:${JSON.stringify(id)}})`)
  opened = true
  const epoch = (await views()).find((page) => (page.pageID ?? page.partition) === pageID)?.epoch
  if (!epoch) throw new Error("Explicit original-page opening did not create a native page")
  log(`original page explicitly opened id=${id} epoch=${epoch}; no send action requested`)
  await new Promise((resolve) => setTimeout(resolve, 35_000))
  if (!(await views()).some((page) => (page.pageID ?? page.partition) === pageID && page.epoch === epoch))
    throw new Error("The selected terminal page was closed during its viewing grace")
  log("selected terminal page survived more than the 30-second cleanup grace")
  await client.evaluate(`window.api.gptPro.command({action:'open',id:${JSON.stringify(restoreID)}})`)
  const deadline = Date.now() + 45_000
  while ((await views()).some((page) => (page.pageID ?? page.partition) === pageID)) {
    if (Date.now() > deadline)
      throw new Error("Hidden terminal page was not safely reaped; inspect diagnostics rather than force-close or resend")
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const saved = await read(id)
  if (saved.phase !== job.phase || saved.text !== job.text || saved.html !== job.html || saved.userID !== job.userID)
    throw new Error("Native-page teardown altered the persisted result or send evidence")
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, id, epoch, restoreID, answerChars: job.text.length }, null, 2), { mode: 0o600 })
  log(`PASS hidden page reclaimed, saved answer unchanged, prior result restored artifacts=${output}`)
} finally {
  if (opened) await client.evaluate(`window.api.gptPro.command({action:'open',id:${JSON.stringify(restoreID)}})`).catch(() => {})
  client.close()
}
