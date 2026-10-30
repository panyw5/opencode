import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { connectCdp, listTargets } from "./cdp"

// Requires an expired/logged-out DEV profile. Never touches installed apps,
// imports credentials, resumes user consultations, or submits a website question.
const directory = `/private/tmp/opencode-gpt-login-regression-${randomUUID()}`
const log = (message: string) => console.log(`[gpt-login-regression] ${message}`)
const { client, target } = await connectCdp()
let socket: WebSocket | undefined
try {
  if (!target.url.includes("localhost:5173")) throw Error("Requires the dev renderer on 9222")
  const preflight = await client.evaluate<{
    authentication: string
    login: string
    candidate: boolean
    active: number
  }>(
    `Promise.all([window.api.gptPro.runtimeStatus(),window.api.gptPro.list()]).then(([r,jobs])=>({authentication:r.session.authentication.phase,login:r.login.phase,candidate:!!r.session.import.candidateProfileID,active:jobs.filter(j=>['queued','preparing','sending','generating'].includes(j.phase)).length}))`,
  )
  log(
    `preflight authentication=${preflight.authentication} connection=${preflight.login} candidate=${preflight.candidate} active=${preflight.active}`,
  )
  if (preflight.authentication === "authenticated")
    throw Error("Requires a logged-out dev profile; no page or sidecar session was created")
  if (preflight.active || preflight.candidate || ["waiting", "importing"].includes(preflight.login))
    throw Error("Consultation or login authorization is active; no page or sidecar session was created")
  await mkdir(directory, { recursive: true })
  await client.evaluate(`(async () => {
    const before = await window.api.gptPro.runtimeStatus()
    if (before.session.authentication.phase === 'authenticated') throw Error('Requires a logged-out dev profile')
    if (['waiting','importing'].includes(before.login.phase) || before.session.import.candidateProfileID) throw Error('Login authorization is in progress; refusing test')
    if ((await window.api.gptPro.list()).some(j => ['queued','preparing','sending','generating'].includes(j.phase))) throw Error('Active consultation; refusing test')
    await window.api.gptPro.open()
    let runtime = await window.api.gptPro.runtimeStatus()
    const loginDeadline = Date.now() + 20000
    while (runtime.session.authentication.phase !== 'invalid' && runtime.session.page.location !== 'login' && runtime.session.page.phase !== 'navigation_error') {
      if (runtime.session.authentication.phase === 'authenticated') throw Error('Requires a logged-out dev profile')
      const views = await window.api.browser.getState()
      if (views.some(v => {
        try { const url = new URL(v.url); return v.profileID === runtime.session?.profileID && url.origin === 'https://chatgpt.com' && ['/auth/login','/login'].includes(url.pathname) } catch { return false }
      })) break
      if (Date.now() >= loginDeadline) throw Error('Login page did not settle; no sidecar message sent')
      await new Promise(resolve => setTimeout(resolve, 200))
      runtime = await window.api.gptPro.runtimeStatus()
    }
  })()`)
  // Diagnostic open is an explicit preparation step and must not be mistaken for the owned test page.
  const initialTargets = new Set((await listTargets()).map((target) => target.id))
  const sessionID = await client.evaluate<string>(`(async () => {
    if ((await window.api.gptPro.list()).some(j => ['queued','preparing','sending','generating'].includes(j.phase))) throw Error('Active consultation; refusing test')
    const sidecar = await window.api.awaitInitialization(() => {})
    window.__gptLoginRegression = async (path, body) => {
      const response = await fetch(sidecar.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username || 'opencode')+':'+sidecar.password)},
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      if (!response.ok) throw Error('sidecar HTTP ' + response.status)
      return response.status === 204 ? null : response.json()
    }
    const session = await window.__gptLoginRegression('/session', {title:'GPT login regression: no webpage dispatch',permission:[{permission:'*',pattern:'*',action:'deny'},{permission:'gpt_pro_consult',pattern:'*',action:'allow'}]})
    await window.__gptLoginRegression('/session/'+session.id+'/prompt_async', {agent:'build',parts:[
      {type:'text',text:'Login regression test. Reply exactly OPENCODE_LOGIN_REGRESSION if authenticated. If login fails, only report that failure. Do not recover, resume, resend, or invoke browser tools.',metadata:{gptProBackground:true}},
      {type:'agent',name:'gpt-pro'}
    ]})
    console.debug('[gpt-login-regression] sidecar message dispatched once session='+session.id)
    return session.id
  })()`)
  log(`sidecar message sent once session=${sessionID}`)
  const deadline = Date.now() + 90_000
  let result:
    | { id: string; pageID: string; phase: string; injected: boolean; sendAttempted?: boolean; submitted: boolean }
    | undefined
  while (Date.now() < deadline) {
    result = await client.evaluate(`(async () => {
      const jobs=(await window.api.gptPro.list()).filter(j=>j.owner.endsWith('\\n'+${JSON.stringify(sessionID)}))
      if (jobs.length > 1) throw Error('Duplicate consultation')
      if (!jobs[0]) return undefined
      const j=jobs[0]
      const messages=await window.__gptLoginRegression('/session/'+${JSON.stringify(sessionID)}+'/message')
      const injected=messages.some(m=>m.parts.some(p=>p.type==='text'&&p.metadata?.consultationID===j.id&&p.metadata?.phase==='paused'&&p.text.includes('HUMAN LOGIN REQUIRED')&&!p.text.includes('HUMAN BROWSER VERIFICATION REQUIRED')))
      return {id:j.id,pageID:j.pageID,phase:j.phase,injected,sendAttempted:j.sendAttempted,submitted:j.submitted}
    })()`)
    if (result?.sendAttempted || result?.submitted) throw Error("Unexpected website dispatch")
    if (result?.phase === "paused" && result.injected) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!result || result.phase !== "paused" || !result.injected)
    throw Error("Login failure notification was not delivered")
  log(`PASS sidecar received paused notification consultation=${result.id}; website dispatches=0`)

  // Replace documents ONLY on this new, unsent regression page. Chromium
  // executes the same SPA login + document-home bounce observed on the site.
  const owned = (await listTargets()).filter(
    (item) => !initialTargets.has(item.id) && item.type === "page" && item.url.startsWith("https://chatgpt.com/"),
  )
  if (owned.length !== 1) throw Error("Refusing ambiguous browser target")
  socket = new WebSocket(owned[0].webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true })
    socket!.addEventListener("error", () => reject(Error("CDP connection failed")), { once: true })
  })
  let nextID = 0
  let documents = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const call = (method: string, params = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextID
      pending.set(id, { resolve, reject })
      socket!.send(JSON.stringify({ id, method, params }))
    })
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.reject(Error(message.error.message))
      else entry?.resolve(message.result)
    }
    if (message.method === "Fetch.requestPaused") {
      documents++
      const body =
        '<!doctype html><title>Login redirect regression</title><script>history.replaceState(null,"","/auth/login?next=%2F");setTimeout(()=>location.replace("/"),50)</script>'
      void call("Fetch.fulfillRequest", {
        requestId: message.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html" }],
        body: Buffer.from(body).toString("base64"),
      })
    }
  })
  await call("Fetch.enable", {
    patterns: [{ urlPattern: "https://chatgpt.com/*", resourceType: "Document", requestStage: "Request" }],
  })
  await client.evaluate(`window.api.browser.open(${JSON.stringify(result.pageID)},'https://chatgpt.com/')`)
  let blocked = false
  const loopDeadline = Date.now() + 10_000
  while (Date.now() < loopDeadline) {
    blocked = await client.evaluate<boolean>(
      `window.api.browser.getState().then(v=>!!v.find(v=>v.pageID===${JSON.stringify(result.pageID)})?.authRedirectLoop)`,
    )
    if (blocked) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!blocked) throw Error("Real Chromium redirect loop was not stopped")
  const count = documents
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (documents !== count || documents < 2 || documents > 4)
    throw Error("Loop protection did not reset for explicit navigation or failed to bound subsequent documents")
  const status = await client.evaluate<{ phase: string }>(`window.api.gptPro.runtimeStatus().then(r=>r.session.page)`)
  if (status.phase !== "navigation_error") throw Error("Runtime did not report the stopped loop")
  await call("Fetch.disable")
  socket.close()
  socket = undefined
  await client.evaluate(`window.api.browser.close(${JSON.stringify(result.pageID)})`)
  await client.evaluate(`window.api.gptPro.command({action:'stop',id:${JSON.stringify(result.id)}})`)
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify({ sessionID, ...result, documents, loopStopped: true, websiteDispatches: 0 }, null, 2),
  )
  log(`PASS real Chromium SPA loop stopped documents=${documents}; evidence=${directory}/result.json`)
} finally {
  socket?.close()
  client.close()
}
