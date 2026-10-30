import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { connectCdp, listTargets, CdpClient } from "./cdp"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { GptProJob, GptProPageState } from "@opencode-ai/util/gpt-pro"

const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const directory = option("--directory") ?? `/private/tmp/opencode-pro-auth-e2e-${randomUUID()}`
const marker = option("--marker") ?? `OPENCODE_PRO_AUTH_${randomUUID().replaceAll("-", "")}`
await mkdir(directory, { recursive: true })
const { client, target } = await connectCdp()
const log = (message: string) => console.log(`[gpt-pro-auth-e2e] ${message}`)
try {
  if (!target.url.includes("localhost:5173")) throw Error("This test requires the dev renderer on 9222")
  const authentication = await client.evaluate<string>("window.api.gptPro.runtimeStatus().then(r=>r.session.authentication.phase)")
  if (authentication !== "authenticated") throw Error("A verified development login is required; no session or sidecar prompt was created")
  const ids = await client.evaluate<{ parent: string; child: string }>(`(async () => {
    const runtime = await window.api.gptPro.runtimeStatus()
    if (runtime.session.authentication.phase !== 'authenticated') throw Error('A verified development login is required; no sidecar prompt was sent')
    const sidecar = await window.api.awaitInitialization(() => {})
    window.__proAuthRequest = async (path, body) => {
      const response = await fetch(sidecar.url + path, {method:body===undefined?'GET':'POST', headers:{'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username||'opencode')+':'+sidecar.password)},body:body===undefined?undefined:JSON.stringify(body)})
      if (!response.ok) throw Error('sidecar HTTP ' + response.status)
      return response.status===204?null:response.json()
    }
    const provided = ${JSON.stringify({ parent: option("--parent"), child: option("--child") })}
    if (provided.parent && provided.child) return provided
    const active=(await window.api.gptPro.list()).some(j=>['queued','preparing','sending','generating'].includes(j.phase))
    if (active) throw Error('A consultation is active; this test will not interrupt it')
    const parent = await window.__proAuthRequest('/session',{title:'GPT-Pro auth-state parent regression',permission:[{permission:'*',pattern:'*',action:'deny'},{permission:'gpt_pro_consult',pattern:'*',action:'allow'}]})
    const child = await window.__proAuthRequest('/session',{parentID:parent.id,title:'GPT-Pro auth-state child regression',permission:[{permission:'*',pattern:'*',action:'deny'},{permission:'gpt_pro_consult',pattern:'*',action:'allow'}]})
    await window.__proAuthRequest('/session/'+child.id+'/prompt_async',{agent:'build',parts:[{type:'text',text:${JSON.stringify(`Reply with exactly ${marker}. Do not search or use tools.`)},metadata:{gptProBackground:true}},{type:'agent',name:'gpt-pro'}]})
    console.debug('[gpt-pro-auth-e2e] child prompt sent once session='+child.id)
    return {parent:parent.id,child:child.id}
  })()`)
  log(`tracking child=${ids.child} parent=${ids.parent}; never resending`)
  let job: GptProJob | undefined
  let last = ""
  const deadline = Date.now() + 5 * 60_000
  let handoffSent = false
  while (Date.now() < deadline) {
    const result = await client.evaluate<{
      job?: GptProJob
      completedNotification: boolean
      parentRead: boolean
      extraConsultations: number
      auth: string
      encrypted: boolean
      bridge: boolean
    }>(`(async () => {
      const jobs=await window.api.gptPro.list()
      const owned=jobs.filter(j=>j.owner.endsWith('\\n'+${JSON.stringify(ids.child)}))
      const job=owned[0]?await window.api.gptPro.command({action:'read',id:owned[0].id}):undefined
      const child=await window.__proAuthRequest('/session/'+${JSON.stringify(ids.child)}+'/message')
      const parent=await window.__proAuthRequest('/session/'+${JSON.stringify(ids.parent)}+'/message')
      const runtime=await window.api.gptPro.runtimeStatus()
      return {job,completedNotification:child.some(m=>m.parts.some(p=>p.type==='text'&&p.metadata?.consultationID===job?.id&&p.metadata?.phase==='completed'&&p.text.includes(${JSON.stringify(marker)}))),parentRead:parent.some(m=>m.parts.some(p=>p.type==='tool'&&p.tool==='gpt_pro_consult'&&p.state.status==='completed'&&p.state.input?.action==='read'&&p.state.metadata?.read_only_handoff===true&&p.state.output?.includes(${JSON.stringify(marker)}))),extraConsultations:jobs.filter(j=>j.owner.endsWith('\\n'+${JSON.stringify(ids.parent)})).length+Math.max(0,owned.length-1),auth:runtime.session.authentication.phase,encrypted:runtime.credentials.phase==='available',bridge:runtime.bridge.connected}
    })()`)
    job = result.job
    const observed = `phase=${job?.phase ?? "pending"} notification=${result.completedNotification} parentRead=${result.parentRead} auth=${result.auth} encrypted=${result.encrypted} bridge=${result.bridge}`
    if (observed !== last) {
      log(observed)
      last = observed
    }
    if (job && ["failed", "send_uncertain", "interrupted", "cancelled", "paused"].includes(job.phase))
      throw Error(`Test stopped phase=${job.phase} code=${job.errorCode}; original question not resent`)
    if (job?.phase === "completed" && !handoffSent && !result.parentRead) {
      handoffSent = true
      await client.evaluate(
        `window.__proAuthRequest('/session/'+${JSON.stringify(ids.parent)}+'/prompt_async',{agent:'build',parts:[{type:'text',text:${JSON.stringify(`Read the completed descendant consultation ${job.id} using gpt_pro_consult action=read, then return its marker. Do not consult, intervene, stop, resume or create another consultation.`)}}]})`,
      )
    }
    if (job?.phase === "completed" && result.completedNotification && result.parentRead) {
      if (
        result.extraConsultations ||
        !job.accountID ||
        !job.submitted ||
        job.text?.trim() !== marker ||
        !result.encrypted ||
        !result.bridge ||
        result.auth !== "authenticated"
      )
        throw Error("Runtime, ownership, credential or single-send evidence mismatch")
      await client.evaluate(`window.api.gptPro.command({action:'open',id:${JSON.stringify(job.id)}})`)
      const chatTarget = (await listTargets()).find((target) => target.type === "page" && target.url === job!.url)
      if (!chatTarget) throw Error("Original ChatGPT conversation target unavailable")
      const chat = await CdpClient.connect(chatTarget.webSocketDebuggerUrl)
      try {
        let page = await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
        const loaded = Date.now() + 30000
        while (!page.users.some(user => user.id === job!.userID) && Date.now() < loaded) {
          await new Promise(resolve => setTimeout(resolve, 250))
          page = await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
        }
        if (
          page.users.length !== 1 ||
          page.users[0].id !== job.userID ||
          page.generating ||
          page.answer?.text.trim() !== marker
        )
          throw Error("Website must show one owned question and its matching answer")
      } finally {
        chat.close()
      }
      await writeFile(
        `${directory}/result.json`,
        JSON.stringify(
          {
            ...ids,
            consultationID: job.id,
            marker,
            completedNotification: true,
            parentReadOnlyHandoff: true,
            websiteQuestions: 1,
            encrypted: true,
            authentication: "authenticated",
          },
          null,
          2,
        ),
      )
      log(
        `PASS real sidecar, single website question, completed inbox delivery, parent read-only handoff; evidence=${directory}/result.json`,
      )
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (Date.now() >= deadline) throw Error("Test deadline reached; no resend or unrelated cancellation attempted")
} finally {
  client.close()
}
