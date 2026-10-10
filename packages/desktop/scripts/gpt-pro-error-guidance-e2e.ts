import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connectCdp } from "./cdp"

// Exercise an actual tool error without submitting a ChatGPT question or changing login.
const directory = process.argv[2]
if (!directory?.includes("/T/opencode-gpt-pro-attachments-"))
  throw new Error("Provide the existing temporary attachment-QA project directory, never a user project")
const output = await mkdtemp(join(tmpdir(), "opencode-error-guidance-e2e-"))
const title = `GPT-Pro error guidance QA ${randomUUID().slice(0, 8)}`
const missingID = `gpt_${randomUUID()}`
const { client, target } = await connectCdp()
if (!target.url.includes("localhost:5173")) {
  client.close()
  throw new Error("Only the development renderer may run this test")
}
const log = (message: string) => console.log(`[gpt-pro-error-guidance-e2e] ${message}`)
const originalSession = await client.evaluate<string | undefined>(
  "document.querySelector('[data-component=tool-part-wrapper]')?.getAttribute('data-session-id')",
)
let id: string | undefined
let opened = false
try {
  await client.evaluate(`(async()=>{
    const sidecar=await window.api.awaitInitialization(()=>{})
    window.__errorGuidanceRequest=async(path,body,method)=>{
      const response=await fetch(sidecar.url+path,{
        method:method||(body===undefined?'GET':'POST'),
        headers:{'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username||'opencode')+':'+sidecar.password)},
        body:body===undefined?undefined:JSON.stringify(body),
      })
      if(!response.ok)throw Error('Sidecar HTTP '+response.status)
      return response.status===204?null:response.json()
    }
    const providers=await window.__errorGuidanceRequest('/provider')
    if(!providers.connected.includes('axonhub-codex')||!providers.all.find(p=>p.id==='axonhub-codex')?.models['gpt-6-luna'])
      throw Error('Requested GPT-6-Luna test provider unavailable; no fallback used')
  })()`)
  const session = await client.evaluate<{ id: string }>(`window.__errorGuidanceRequest('/session',{
    title:${JSON.stringify(title)},permission:[{permission:'*',pattern:'*',action:'allow'}],
  })`)
  id = session.id
  await writeFile(join(output, "run.json"), JSON.stringify({ directory, id, missingID, originalSession }, null, 2), {
    mode: 0o600,
  })
  await client.evaluate(`window.__errorGuidanceRequest('/session/'+${JSON.stringify(id)}+'/prompt_async',{
    agent:'build',model:{providerID:'axonhub-codex',modelID:'gpt-6-luna'},
    parts:[{type:'text',text:${JSON.stringify(`Call gpt_pro_consult exactly once with action=status, consultation_id=${missingID}, wait_ms=0. This deliberately missing ID is a tool-error handling test. Do not create any consultation, send a ChatGPT prompt, open a browser, read files, retry, or use other tools. After receiving the tool error, reply with GPT_PRO_ERROR_GUIDANCE_RECEIVED and a brief Chinese explanation of the received error.`)}}],
  })`)
  log(`real GPT-6-Luna request dispatched session=${id}; status-only nonexistent ID, no ChatGPT send`)
  const deadline = Date.now() + 180_000
  let received = false
  while (Date.now() < deadline) {
    const observation = await client.evaluate<{ count: number; error?: string; received: boolean }>(`(async()=>{
      const messages=await window.__errorGuidanceRequest('/session/'+${JSON.stringify(id)}+'/message')
      const tools=messages.flatMap(m=>m.parts).filter(p=>p.type==='tool')
      const texts=messages.filter(m=>m.info.role==='assistant').flatMap(m=>m.parts).filter(p=>p.type==='text')
      return {count:tools.length,error:tools.find(p=>p.tool==='gpt_pro_consult'&&p.state.status==='error')?.state.error,
        received:texts.some(p=>p.text.includes('GPT_PRO_ERROR_GUIDANCE_RECEIVED'))}
    })()`)
    if (observation.count > 1) throw new Error("The test agent retried or called an unexpected tool")
    if (observation.received) {
      if (!observation.error?.includes("Consultation not found"))
        throw new Error("The real missing-record error was not received")
      received = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!received) throw new Error("Tool error receipt timed out; request was not repeated")
  log("real tool error and matching assistant acknowledgement verified")
  const clickSession = (sessionID: string) =>
    client.evaluate<boolean>(`(()=>{
    const link=[...document.querySelectorAll('a[href]')].find(e=>e.getAttribute('href')?.includes('/session/'+${JSON.stringify(sessionID)}))
    if(!link)return false;link.click();return true
  })()`)
  for (let attempt = 0; attempt < 30 && !opened; attempt++) {
    opened = await clickSession(id)
    if (!opened) await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if (!opened) throw new Error("Actual test session link did not appear; no synthetic tool card was injected")
  let evidence: { found: boolean; hinted: boolean; collapsed: boolean; alert: boolean; rawPrimary: boolean } | undefined
  for (let attempt = 0; attempt < 50; attempt++) {
    evidence = await client.evaluate(`(()=>{
      const wrapper=document.querySelector('[data-tool="gpt_pro_consult"][data-session-id="${id}"]')
      const notice=wrapper?.querySelector('[data-error-code="history_missing"]')
      const details=notice?.querySelector('details')
      const copy=[...notice?.querySelectorAll('p')||[]].map(e=>e.textContent).join(' ')
      return {found:!!notice,hinted:/不要|do not/i.test(copy)&&/原|original/i.test(copy),collapsed:!!details&&!details.open,
        alert:notice?.getAttribute('role')==='alert',rawPrimary:copy.includes('Error invoking remote method')}
    })()`)
    if (evidence.found) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if (!evidence?.found || !evidence.hinted || !evidence.collapsed || !evidence.alert || evidence.rawPrimary)
    throw new Error(`Actual error card did not show safe localized instructions: ${JSON.stringify(evidence)}`)
  const screenshot = async (name: string) => {
    const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await writeFile(join(output, name), Buffer.from(shot.data, "base64"))
  }
  await screenshot("desktop.png")
  await client.call("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await screenshot("narrow.png")
  await client.call("Emulation.clearDeviceMetricsOverride")
  await client.evaluate(`(()=>{
    const details=document.querySelector('[data-tool="gpt_pro_consult"][data-session-id="${id}"] details')
    details.querySelector('summary').click()
  })()`)
  const expanded = await client.evaluate<boolean>(
    `document.querySelector('[data-tool="gpt_pro_consult"][data-session-id="${id}"] details')?.open===true`,
  )
  if (!expanded) throw new Error("Diagnostic details did not expand")
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, id, evidence, expanded }, null, 2), {
    mode: 0o600,
  })
  log(
    `PASS actual startup/tool error card, localized guidance and collapsed/expandable diagnostics artifacts=${output}`,
  )
  if (originalSession) await clickSession(originalSession)
} finally {
  await client.call("Emulation.clearDeviceMetricsOverride").catch(() => {})
  if (opened && originalSession)
    await client
      .evaluate(
        `(()=>{const link=[...document.querySelectorAll('a[href]')].find(e=>e.getAttribute('href')?.includes('/session/'+${JSON.stringify(originalSession)}));link?.click()})()`,
      )
      .catch(() => {})
  if (id) {
    await client
      .evaluate(`window.__errorGuidanceRequest('/session/'+${JSON.stringify(id)}+'/abort',{})`)
      .catch(() => {})
    await client
      .evaluate(`window.__errorGuidanceRequest('/session/'+${JSON.stringify(id)},undefined,'DELETE')`)
      .catch(() => {})
  }
  client.close()
}
