import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { GptProJob, GptProPageState } from "@opencode-ai/util/gpt-pro"
import { CdpClient, connectCdp, listTargets } from "./cdp"

// Exercises the actual dev sidecar -> desktop driver -> Chat -> background inbox.
// Never submits through a test adapter or retries a dispatched consultation.
const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(name) + 1]
const partID = args.includes("--prompt-part") ? option("--prompt-part") : undefined
const watchID = args.includes("--watch") ? option("--watch") : undefined
const exerciseRecovery = args.includes("--exercise-agent-recovery")
let prompt: string
if (partID) {
  const db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true })
  try {
    const row = db.query("select data from part where id=?").get(partID) as { data: string } | null
    const part = row ? JSON.parse(row.data) : null
    if (part?.tool !== "gpt_pro_consult" || typeof part.state?.input?.prompt !== "string")
      throw new Error("The source part is not a GPT-Pro consultation prompt")
    prompt = part.state.input.prompt
  } finally {
    db.close()
  }
} else if (args.includes("--prompt-file")) {
  prompt = await readFile(option("--prompt-file"), "utf8")
} else {
  throw new Error("Provide --prompt-file <path> or --prompt-part <id>; use a real multiline consultation")
}
prompt = prompt.replace(/\r\n/g, "\n").trim()
const output = await mkdtemp(join(tmpdir(), "opencode-gpt-pro-e2e-"))
let directory = args.includes("--directory") ? option("--directory") : join(output, "project")
await mkdir(directory, { recursive: true })
directory = await realpath(directory)
await writeFile(join(output, "prompt.txt"), prompt, { mode: 0o600 })
const log = (message: string) => console.log(`[gpt-pro-e2e] ${message}`)
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://")) {
  client.close()
  throw new Error("9222 is not the OpenCode development renderer")
}

try {
  const active = await client.evaluate<boolean>(
    `(async () => (await window.api.gptPro.list()).some(j=>['queued','preparing','sending','generating','paused'].includes(j.phase)))()`,
  )
  if (active && !watchID) throw new Error("Another consultation owns the browser; no test was sent")
  if (exerciseRecovery && !watchID) {
    await client.evaluate(`window.api.browser.open('persist:consult-gpt-pro','https://chatgpt.com/')`)
    const readyDeadline = Date.now() + 90000
    let prepared = false
    while (Date.now() < readyDeadline) {
      const target = (await listTargets()).find((t) => t.type === "page" && t.url === "https://chatgpt.com/")
      if (target) {
        const chat = await CdpClient.connect(target.webSocketDebuggerUrl)
        try {
          const page = await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
          if (page.composer && page.model && !page.generating && !page.users.length && !page.draft.trim()) {
            await chat.evaluate(`(()=>{
              document.querySelector('[role="dialog"][aria-label="Browser recovery exercise"] button')?.click()
              const modal=document.createElement('div')
              modal.setAttribute('role','dialog');modal.setAttribute('aria-label','Browser recovery exercise')
              modal.style.cssText='position:fixed;inset:120px 12% auto;z-index:2147483647;background:white;color:black;border:2px solid #333;border-radius:12px;padding:24px'
              modal.innerHTML='<h2>Browser recovery exercise</h2><p>This temporary test overlay prevents focusing the composer. Dismiss it to continue the original consultation.</p><button type="button" style="padding:12px 24px">Continue to ChatGPT</button>'
              const button=modal.querySelector('button')
              const trap=e=>{if(e.target instanceof Element&&e.target.closest('#prompt-textarea,[data-composer-markdown]'))button.focus()}
              document.addEventListener('focusin',trap,true)
              button.addEventListener('click',()=>{document.removeEventListener('focusin',trap,true);modal.remove()})
              document.body.append(modal);return true
            })()`)
            prepared = true
            break
          }
        } finally {
          chat.close()
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!prepared) throw Error("Could not prepare an empty real Chat page; no test sent")
    log(
      "installed real focus-blocking overlay; fixed flow must hand off and the owning model must dismiss it with browser tools",
    )
  }
  const targets = (await listTargets()).filter((t) => t.type === "page" && t.url.startsWith("https://chatgpt.com/"))
  if (!watchID && targets.length === 1) {
    const chat = await CdpClient.connect(targets[0].webSocketDebuggerUrl)
    try {
      const page = await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
      if (page.generating) throw new Error("The browser is generating; no test was sent")
      if (page.draft.trim()) {
        if (!args.includes("--clear-matching-draft") || page.draft !== prompt)
          throw new Error("A draft exists. Only --clear-matching-draft may clear an exact copy of the test prompt")
        await writeFile(join(output, "preserved-draft.txt"), page.draft, { mode: 0o600 })
        await chat.evaluate(
          `(() => { const editor=[...document.querySelectorAll('#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]')].find(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')); if(!editor) throw Error('No editor'); editor.focus(); return true })()`,
        )
        for (const type of ["rawKeyDown", "keyUp"])
          await chat.call("Input.dispatchKeyEvent", {
            type,
            key: "a",
            code: "KeyA",
            modifiers: 4,
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
          })
        for (const type of ["rawKeyDown", "keyUp"])
          await chat.call("Input.dispatchKeyEvent", {
            type,
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
            nativeVirtualKeyCode: 8,
          })
        if ((await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)).draft.trim())
          throw new Error("The matching draft could not be cleared. No test was sent")
        log(`preserved and cleared exact failed draft chars=${prompt.length}`)
      }
    } finally {
      chat.close()
    }
  }
  const existingID = args.includes("--session") ? option("--session") : undefined
  const model = args.includes("--model") ? option("--model") : undefined
  const slash = model?.indexOf("/") ?? -1
  if (model && slash < 1) throw new Error("--model must be provider/model")
  const modelRef = model ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined
  const sessionID = await client.evaluate<string>(`(async () => {
    const sidecar=await window.api.awaitInitialization(()=>{})
    window.__gptProE2eRequest=async (path,body) => {
      const headers={'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username||'opencode')+':'+sidecar.password)}
      const r=await fetch(sidecar.url+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})
      if(!r.ok) throw Error('sidecar HTTP '+r.status+' path='+path)
      if(r.status===204) return null
      return r.json()
    }
    const existing=${JSON.stringify(existingID ?? null)}
    if(${JSON.stringify(watchID ?? null)}) {
      if(!existing) throw Error('--watch requires --session')
      window.__gptProE2ePrevious=[]
      return existing
    }
    const session=existing?await window.__gptProE2eRequest('/session/'+existing):await window.__gptProE2eRequest('/session',{title:'GPT Pro multiline end-to-end test',permission:[{permission:'gpt_pro_consult',pattern:'*',action:'allow'}]})
    if(session.directory!==${JSON.stringify(directory)}) throw Error('Session directory does not match the requested project')
    window.__gptProE2ePrevious=(await window.__gptProE2eRequest('/session/'+session.id+'/message')).map(m=>m.info.id)
    await window.__gptProE2eRequest('/session/'+session.id+'/prompt_async',{agent:'build',model:${JSON.stringify(modelRef ?? null)}||undefined,parts:[{type:'text',text:${JSON.stringify(prompt)},metadata:{gptProBackground:true}},{type:'agent',name:'gpt-pro'}]})
    return session.id
  })()`)
  log(
    `${watchID ? "watching original submitted consultation" : "submitted to real sidecar"} session=${sessionID} promptChars=${prompt.length} lines=${prompt.split("\n").length}`,
  )
  await writeFile(
    join(output, "run.json"),
    JSON.stringify({ sessionID, directory, promptChars: prompt.length }, null, 2),
    { mode: 0o600 },
  )
  let id: string | undefined = watchID
  let observed = ""
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    const state = await client.evaluate<{
      tool?: { id?: string; promptMatches: boolean; status: string }
      job?: GptProJob
      page?: GptProPageState
      notificationMatches: boolean
      recoveryTools: Array<{ tool: string; status: string }>
    }>(`(async () => {
      const messages=await window.__gptProE2eRequest('/session/'+${JSON.stringify(sessionID)}+'/message')
      const fresh=messages.filter(m=>!window.__gptProE2ePrevious.includes(m.info.id))
      const tool=fresh.flatMap(m=>m.parts).filter(p=>p.type==='tool'&&p.tool==='gpt_pro_consult'&&p.state.input?.prompt===${JSON.stringify(prompt)}&&(!${JSON.stringify(watchID ?? null)}||p.state.metadata?.consultation_id===${JSON.stringify(watchID ?? null)})).at(-1)
      const id=${JSON.stringify(id ?? null)}||tool?.state.metadata?.consultation_id
      const job=id?await window.api.gptPro.command({action:'read',id}):undefined
      const page=(await window.api.gptPro.status()).page
      const notificationMatches=!!job?.text&&fresh.some(m=>m.parts.some(p=>p.type==='text'&&p.metadata?.consultationID===id&&p.metadata?.phase==='completed'&&p.text.includes(job.text)))
      const recoveryTools=fresh.flatMap(m=>m.parts).filter(p=>p.type==='tool'&&p.tool.startsWith('browser_')&&p.state.input?.consultation_id===id).map(p=>({tool:p.tool,status:p.state.status}))
      return {tool:tool?{id:tool.state.metadata?.consultation_id,promptMatches:tool.state.input.prompt===${JSON.stringify(prompt)},status:tool.state.status}:undefined,job,page,notificationMatches,recoveryTools}
    })()`)
    id ??= state.tool?.id
    const summary = `id=${id ?? "pending"} phase=${state.job?.phase ?? "pending"} recovery=${state.job?.recovery?.stage ?? "none"} tools=${state.recoveryTools.map((t) => t.tool + ":" + t.status).join(",")} submitted=${state.job?.submitted ?? false} userID=${state.job?.userID ?? "pending"} answerChars=${state.job?.text?.length ?? 0} inbox=${state.notificationMatches}`
    if (summary !== observed) {
      log(summary)
      observed = summary
    }
    if (
      state.job &&
      !state.job.recovery &&
      ["failed", "paused", "cancelled", "interrupted", "send_uncertain"].includes(state.job.phase)
    )
      throw new Error(
        `Consultation stopped phase=${state.job.phase}: ${state.job.error ?? "unknown error"}; never resent`,
      )
    if (state.job?.phase === "completed" && state.notificationMatches) {
      const { job, page } = state
      if (!job.submitted || job.model !== "GPT-6 Pro" || !job.text || !job.html || !state.tool?.promptMatches)
        throw new Error("The completed job is missing submission, model, prompt or full-answer evidence")
      if (
        page?.users.length !== 1 ||
        page.users[0].id !== job.userID ||
        page.users[0].text !== prompt ||
        page.generating ||
        !page.answer?.complete ||
        page.answer.userID !== job.userID
      )
        throw new Error("The website did not show exactly one matching question and its completed answer")
      if (
        args.includes("--require-rich-output") &&
        (!job.text.includes("OPENCODE_GPT_PRO_MULTILINE_FULL_E2E_OK") ||
          job.text.length < 1000 ||
          !job.html.includes("<table") ||
          !job.html.includes("<code") ||
          !/<math|class="[^"]*katex/.test(job.html))
      )
        throw new Error("The substantive rich-text answer is missing its marker, table, code or rendered math")
      if (
        exerciseRecovery &&
        !["browser_read", "browser_click"].every((tool) =>
          state.recoveryTools.some((t) => t.tool === tool && t.status === "completed"),
        )
      )
        throw Error("The model did not actually inspect and repair the handed-off browser with existing tools")
      await writeFile(join(output, "answer.txt"), job.text, { mode: 0o600 })
      await writeFile(join(output, "answer.html"), job.html, { mode: 0o600 })
      await writeFile(
        join(output, "result.json"),
        JSON.stringify(
          {
            sessionID,
            consultationID: id,
            model: job.model,
            url: job.url,
            promptChars: prompt.length,
            answerChars: job.text.length,
            htmlChars: job.html.length,
            userID: job.userID,
            websiteQuestions: page.users.length,
            completed: true,
            deliveredToParent: true,
            recoveryTools: state.recoveryTools,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      )
      log(`PASS full multiline consultation delivered to original session; artifacts=${output}`)
      break
    }
    if (Date.now() + 2000 >= deadline)
      throw new Error("End-to-end test timed out; original consultation preserved, never resent")
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
} finally {
  client.close()
}
