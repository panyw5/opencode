import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { GptProJob, GptProPageState } from "@opencode-ai/util/gpt-pro"
import { CdpClient, connectCdp, listTargets } from "./cdp"

type Case = { sessionID: string; prompt: string; marker: string }
type Run = { directory: string; cases: Case[]; cancelFirst: boolean }
type Observation = { job?: GptProJob & { pageID?: string }; delivered: boolean }

const args = process.argv.slice(2)
const watchIndex = args.indexOf("--watch")
const watch = watchIndex >= 0 ? args[watchIndex + 1] : undefined
if (watchIndex >= 0 && !watch) throw new Error("--watch requires a saved run.json; never resend automatically")
const output = watch ? watch.replace(/\/run\.json$/, "") : await mkdtemp(join(tmpdir(), "opencode-multipage-e2e-"))
const log = (message: string) => console.log(`[gpt-pro-multipage-e2e] ${message}`)
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://")) {
  client.close()
  throw new Error("9222 is not the development renderer; refusing app operations")
}

let run: Run
try {
  const config = await client.evaluate<{ enabled: boolean }>("window.api.gptPro.getConfig()")
  if (!config.enabled) throw new Error("GPT-Pro is disabled; the test will not change user settings")
  if (watch) run = JSON.parse(await readFile(watch, "utf8")) as Run
  else {
    const directory = join(output, "project")
    await mkdir(directory, { recursive: true })
    run = { directory: await realpath(directory), cases: [], cancelFirst: args.includes("--cancel-first") }
  }
  const directory = JSON.stringify(run.directory)
  await client.evaluate(`(async () => {
    const sidecar = await window.api.awaitInitialization(() => {})
    window.__multipageRequest = async (path, body) => {
      const response = await fetch(sidecar.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-opencode-directory': encodeURIComponent(${directory}),
          Authorization: 'Basic ' + btoa((sidecar.username || 'opencode') + ':' + sidecar.password),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw Error('sidecar HTTP ' + response.status + ' path=' + path)
      return response.status === 204 ? null : response.json()
    }
  })()`)

  if (!watch) {
    for (const label of ["A", "B"]) {
      const marker = `OPENCODE_MULTIPAGE_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
      const session = await client.evaluate<{ id: string }>(`window.__multipageRequest('/session', {
        title: ${JSON.stringify(`GPT-Pro multipage integration ${label}`)},
        permission: [{permission:'gpt_pro_consult',pattern:'*',action:'allow'}],
      })`)
      run.cases.push({
        sessionID: session.id,
        marker,
        prompt:
          run.cancelFirst && label === "A"
            ? `This is a browser cancellation isolation integration test.\nWrite a detailed 1500-word explanation of how browser tabs isolate DOM state while sharing cookies. End with exactly this token:\n${marker}`
            : `This is a browser-page isolation integration test.\nReply with exactly this token, with no additional text:\n${marker}`,
      })
    }
    // Save all request identities before dispatch. Watch mode only observes, never posts again.
    await writeFile(join(output, "run.json"), JSON.stringify(run, null, 2), { mode: 0o600 })
    log(`dispatching two real sidecar consultations manifest=${join(output, "run.json")}`)
    await client.evaluate(`Promise.all(${JSON.stringify(run.cases)}.map(test => window.__multipageRequest(
      '/session/' + test.sessionID + '/prompt_async', {
        agent:'build',
        parts:[{type:'text',text:test.prompt,metadata:{gptProBackground:true}},{type:'agent',name:'gpt-pro'}],
      },
    )))`)
  }

  let stopped = false
  let independent = false
  let overlapped = false
  let previous = ""
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const observations = await client.evaluate<Observation[]>(`(async () => {
      const jobs = await window.api.gptPro.list()
      return Promise.all(${JSON.stringify(run.cases)}.map(async test => {
        const messages = await window.__multipageRequest('/session/' + test.sessionID + '/message')
        const summary = jobs.find(job => job.owner === ${directory} + '\\n' + test.sessionID &&
          job.prompt === test.prompt.slice(0,160))
        const job = summary ? await window.api.gptPro.command({action:'read',id:summary.id}) : undefined
        if(job && job.prompt !== test.prompt) throw Error('The original consultation was replaced; no new request accepted')
        const delivered = !!job?.text && messages.some(message => message.parts.some(part =>
          part.type === 'text' && part.metadata?.consultationID === job.id &&
          part.metadata?.phase === 'completed' && part.text.includes(test.marker)))
        return {job,delivered}
      }))
    })()`)
    const summary = observations
      .map(
        ({ job, delivered }, index) =>
          `${index ? "B" : "A"}=${job?.phase ?? "pending"} page=${job?.pageID ?? "pending"} sent=${job?.submitted ?? false} inbox=${delivered}`,
      )
      .join(" ")
    if (summary !== previous) {
      log(summary)
      previous = summary
    }
    const [first, second] = observations.map((observation) => observation.job)
    if (first && second && [first, second].every((job) => ["preparing", "sending", "generating"].includes(job.phase)))
      overlapped = true
    if (first?.pageID && second?.pageID) {
      if (first.pageID === second.pageID) throw new Error("Independent owners were assigned the same page")
      const states = await client.evaluate<Array<{ pageID?: string; partition: string; profileID?: string }>>(
        "window.api.browser.getState()",
      )
      const pages = [first, second].map((job) =>
        states.find((state) => (state.pageID ?? state.partition) === job.pageID),
      )
      if (pages.every(Boolean)) {
        if (pages[0]!.profileID !== pages[1]!.profileID || pages[0]!.profileID !== "persist:consult-gpt-pro")
          throw new Error("Consultation pages did not share the intended ChatGPT login profile")
        if (first.submitted && second.submitted) independent = true
      }
    }
    if (run.cancelFirst && first?.submitted && first.userID && second?.submitted && second.userID && !stopped) {
      if (["completed", "cancelled", "failed"].includes(first.phase))
        throw new Error("First consultation already finished; live stop isolation was not exercised")
      await client.evaluate(
        `window.__multipageRequest('/session/' + ${JSON.stringify(run.cases[0].sessionID)} + '/abort', {})`,
      )
      stopped = true
      log("explicitly stopped session A through the sidecar; observing B without resending")
    }
    for (const [index, observation] of observations.entries()) {
      const job = observation.job
      if (!job) continue
      if (run.cancelFirst && index === 0 && stopped) continue
      if (["paused", "failed", "interrupted", "send_uncertain", "cancelled"].includes(job.phase))
        throw new Error(`Case ${index} stopped phase=${job.phase}: ${job.error ?? job.recovery?.reason ?? "unknown"}`)
    }
    const done = run.cancelFirst
      ? stopped && first?.phase === "cancelled" && second?.phase === "completed" && observations[1].delivered
      : observations.every(({ job, delivered }) => job?.phase === "completed" && delivered)
    if (done) {
      if (!independent) throw new Error("No simultaneous independent shared-profile page evidence was captured")
      if (!overlapped) throw new Error("No overlapping consultation runners were observed; concurrency is unverified")
      for (const [index, observation] of observations.entries()) {
        const job = observation.job!
        const cancelledCase = run.cancelFirst && index === 0
        const test = run.cases[index]
        const other = run.cases[1 - index]
        if (
          !job.submitted ||
          !job.userID ||
          (!cancelledCase && (!job.html || !job.text?.includes(test.marker) || job.text.includes(other.marker)))
        )
          throw new Error("The final answer or owned user turn did not match its session marker")
        const matches = (await listTargets()).filter((target) => target.type === "page" && target.url === job.url)
        if (matches.length !== 1) throw new Error("The job URL did not resolve to exactly one development page")
        const pageClient = await CdpClient.connect(matches[0].webSocketDebuggerUrl)
        try {
          const page = await pageClient.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
          const answer = page.answers?.find((answer) => answer.userID === job.userID) ?? page.answer
          if (
            page.users.length !== 1 ||
            page.users[0].id !== job.userID ||
            page.users[0].text.trim() !== test.prompt ||
            (!cancelledCase &&
              (answer?.userID !== job.userID || !answer.complete || !answer.text.includes(test.marker)))
          )
            throw new Error("Actual website question/answer evidence did not match the recorded consultation")
          if (cancelledCase && page.generating)
            throw new Error("The cancelled session's actual website page is still generating")
        } finally {
          pageClient.close()
        }
      }
      await writeFile(
        join(output, "result.json"),
        JSON.stringify(
          {
            passed: true,
            independentPages: true,
            overlappingRunners: true,
            sharedProfile: true,
            stopIsolation: run.cancelFirst,
            stoppedWebsiteObserved: run.cancelFirst,
            cases: observations.map(({ job, delivered }) => ({
              id: job!.id,
              pageID: job!.pageID,
              userID: job!.userID,
              phase: job!.phase,
              delivered,
            })),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      log(`PASS real website answers and parent inboxes verified artifacts=${output}`)
      break
    }
    if (Date.now() + 2000 >= deadline) throw new Error("Integration timed out; saved requests preserved, never resent")
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
} finally {
  client.close()
}
