import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION, CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { GptProJob, GptProPageState, GptProProbeStatus } from "@opencode-ai/util/gpt-pro"
import { CdpClient, connectCdp, listTargets } from "./cdp"

// Exercises file-input transport separately from an opt-in real sidecar run.
// Never prints fixture contents, data URLs, credentials, or attachment paths.
const args = process.argv.slice(2)
const arg = (name: string) => args[args.indexOf(name) + 1]
const probeOnly = args.includes("--probe-only")
const fixtureOnly = args.includes("--fixture-only")
const showSession = args.includes("--show-session")
const backgroundRequested = args.includes("--background")
const showOnlySession = args.includes("--show-session-only") ? arg("--show-session-only") : undefined
const watchRunPath = args.includes("--watch-run") ? resolve(arg("--watch-run") ?? "") : undefined
const watchSession = args.includes("--watch") ? arg("--watch") : undefined
const consultationID = args.includes("--consultation") ? arg("--consultation") : undefined
const requestedNonce = args.includes("--nonce") ? arg("--nonce") : undefined
const requestedDirectory = args.includes("--directory") ? resolve(arg("--directory") ?? "") : undefined
if (args.includes("--watch-run") && !arg("--watch-run")) throw new Error("--watch-run requires a run.json path")
if (args.includes("--watch") && !watchSession) throw new Error("--watch requires an existing session ID; no request was sent")
if (watchRunPath && (watchSession || probeOnly || fixtureOnly)) throw new Error("--watch-run cannot be combined with other modes")
if (watchSession && !requestedDirectory) throw new Error("--watch requires --directory; use --watch-run <run.json> to reuse a saved run")
if (consultationID && !watchSession && !watchRunPath) throw new Error("--consultation is only valid in watch mode; no request was sent")
if (probeOnly && fixtureOnly) throw new Error("Choose one harmless probe mode")
if (args.includes("--directory") && !arg("--directory")) throw new Error("--directory requires a path")
if (args.includes("--show-session-only") && !showOnlySession) throw new Error("--show-session-only requires an existing session ID")
if (showOnlySession && !requestedDirectory) throw new Error("--show-session-only requires --directory")
if (showOnlySession && (watchRunPath || watchSession || probeOnly || fixtureOnly || showSession))
  throw new Error("--show-session-only cannot be combined with other modes")
if (args.includes("--nonce") && !requestedNonce) throw new Error("--nonce requires a 1-16 character ASCII token")
if (requestedNonce && !/^[A-Za-z0-9_-]{1,16}$/.test(requestedNonce))
  throw new Error("--nonce must be a 1-16 character ASCII alphanumeric token")
const endpoint = Bun.env.OPENCODE_CDP_ENDPOINT || "http://127.0.0.1:9222"
const savedRun = watchRunPath ? JSON.parse(await readFile(watchRunPath, "utf8")) as {
  sessionID: string
  directory: string
  background?: boolean
  nonce?: string
  prompt?: string
  markers?: Record<string, string>
  fixtures?: Record<string, string>
} : undefined
if (watchRunPath && (!savedRun?.sessionID || !savedRun.directory)) throw new Error("Run manifest is missing sessionID or directory")
if (savedRun?.nonce && requestedNonce && savedRun.nonce !== requestedNonce)
  throw new Error("--nonce does not match the saved run; watch mode will not change its request")
if (savedRun && backgroundRequested && savedRun.background !== true)
  throw new Error("--background does not match the saved run; watch mode will not change its delivery mode")
const nonce = savedRun?.nonce ?? requestedNonce
const backgroundMode = savedRun?.background ?? backgroundRequested
const output = savedRun ? dirname(watchRunPath!) : await mkdtemp(join(tmpdir(), "opencode-gpt-pro-attachments-"))
let directory = savedRun?.directory ?? requestedDirectory ?? join(output, "project")
const existingSession = savedRun?.sessionID ?? watchSession
if (!savedRun && !watchSession && !showOnlySession) await mkdir(directory, { recursive: true })
directory = await realpath(directory)

const generatedMarkers = {
  markdown: `OPENCODE_ATTACHMENT_MARKDOWN_7F3A${nonce ? `_${nonce}` : ""}`,
  text: `OPENCODE_ATTACHMENT_TEXT_91C2${nonce ? `_${nonce}` : ""}`,
  pdf: `OPENCODE_ATTACHMENT_PDF_4B8D${nonce ? `_${nonce}` : ""}`,
  png: `OPENCODE_ATTACHMENT_PNG_6E10${nonce ? `_${nonce}` : ""}`,
  pasted: `OPENCODE_ATTACHMENT_PASTED_IMAGE_2D59${nonce ? `_${nonce}` : ""}`,
}
const generatedFixtures = {
  markdown: join(directory, "evidence.md"),
  text: join(directory, "notes.txt"),
  pdf: join(directory, "report.pdf"),
  png: join(directory, "chart.png"),
  pasted: join(directory, "pasted-image.png"),
}
const markers = (savedRun?.markers ?? generatedMarkers) as typeof generatedMarkers
const basePrompt = "Read all five attached files/images and report the exact unique marker found in each, labeling which marker came from which attachment. The markers are present only in the attachments; do not guess or infer them."
const prompt = savedRun?.prompt ?? `${basePrompt}${nonce ? ` Case ID: ${nonce}.` : ""}`
const fixtures = savedRun?.fixtures
  ? Object.fromEntries(
      Object.entries(generatedFixtures).map(([key, path]) => [key, join(directory, basename(savedRun.fixtures?.[key] ?? path))]),
    ) as typeof generatedFixtures
  : generatedFixtures

function pdf(marker: string) {
  const stream = `BT /F1 12 Tf 48 720 Td (${marker}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

const { client, target } = await connectCdp(endpoint)
if (!target.url.includes("localhost:5173") && !target.url.startsWith("oc://")) {
  client.close()
  throw new Error("9222 is not the OpenCode development renderer; refusing all app operations")
}
const log = (message: string) => console.log(`[gpt-pro-attachments-e2e] ${message}`)

async function inspectLiveTarget(job: GptProJob) {
  const matches = (await listTargets(endpoint)).filter((target) => target.type === "page" && target.url === job.url)
  if (matches.length !== 1) throw new Error("The consultation URL did not match exactly one live ChatGPT CDP target")
  const chat = await CdpClient.connect(matches[0].webSocketDebuggerUrl)
  try {
    const page = await chat.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
    const images = await chat.evaluate<{
      url: string
      composer: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      users: Array<{
        id?: string
        attachments: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      }>
    }>(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    const hasImageEvidence = images.composer.length > 0 || images.users.some((user) => user.attachments.length > 0)
    if (
      page.url !== job.url ||
      (hasImageEvidence &&
        (images.url !== page.url ||
          images.users.length !== page.users.length ||
          images.users.some((user, index) => user.id !== page.users[index]?.id)))
    )
      throw new Error("Live ChatGPT target or user IDs changed during attachment evidence inspection")

    const used = new Set<number>()
    page.attachments = (page.attachments ?? []).map((attachment) => {
      const match = images.composer.findIndex((image, index) => !used.has(index) && image.name === attachment.name)
      if (match < 0) return attachment
      used.add(match)
      return { ...attachment, ...images.composer[match] }
    })
    page.users = page.users.map((user, index) => {
      const imageAttachments = images.users[index]?.attachments ?? []
      return imageAttachments.length ? { ...user, attachments: [...(user.attachments ?? []), ...imageAttachments] } : user
    })
    return page
  } finally {
    chat.close()
  }
}

async function showSessionInRenderer(sessionID: string) {
  const encodedDirectory = Buffer.from(directory, "utf8").toString("base64url")
  const sessionPath = `/${encodedDirectory}/session/${sessionID}`
  const deepLink = `opencode://open-project?directory=${encodeURIComponent(directory)}`
  await client.evaluate(`window.dispatchEvent(new CustomEvent('opencode:deep-link',{detail:{urls:[${JSON.stringify(deepLink)}]}}))`)
  const deadline = Date.now() + 30_000
  let selected = false
  while (Date.now() < deadline) {
    try {
      const state = await client.evaluate<{ selected: boolean; sessionPage: boolean; statusRows: number; tableRows: number }>(`(() => {
        const path=${JSON.stringify(sessionPath)}
        const anchor=[...document.querySelectorAll('a[href]')].find(link=>{
          try { return new URL(link.href,location.href).pathname===path && !!link.getClientRects().length }
          catch { return false }
        })
        if(!window.__gptProShowSessionSelected&&anchor){
          window.__gptProShowSessionSelected=true
          anchor.click()
        }
        return {
          selected:window.__gptProShowSessionSelected===true,
          sessionPage:location.pathname===path&&!!document.querySelector('[data-component="session-page"]'),
          statusRows:document.querySelectorAll('[data-testid="gpt-pro-attachment"]').length,
          tableRows:[...document.querySelectorAll('table')].reduce((count,table)=>count+Math.max(0,table.querySelectorAll('tr').length-1),0)
        }
      })()`)
      selected ||= state.selected
      if (state.sessionPage) {
        log(`opened owned session via exact sidebar link selected=${selected} gptProStatusRows=${state.statusRows} renderedTableRows=${state.tableRows}`)
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Could not open the owned test session from the dev renderer's exact sidebar link")
}

async function createPngFixture(marker: string) {
  const dataURL = await client.evaluate<string>(`(() => {
    const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=220
    const context=canvas.getContext('2d');if(!context)throw Error('Canvas unavailable')
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height)
    context.fillStyle='#111';context.font='bold 32px sans-serif';context.fillText(${JSON.stringify(marker)},24,132)
    return canvas.toDataURL('image/png')
  })()`)
  if (!dataURL.startsWith("data:image/png;base64,")) throw new Error("PNG fixture generation failed")
  await writeFile(fixtures[marker === markers.png ? "png" : "pasted"], Buffer.from(dataURL.split(",")[1], "base64"), {
    mode: 0o600,
  })
  return dataURL
}

async function verifyFileInputTransport() {
  const png = await createPngFixture(markers.png)
  const pasted = await createPngFixture(markers.pasted)
  const html = `<!doctype html><title>GPT-Pro file input transport fixture</title><input id="files" type="file" multiple accept=".md,.txt,.pdf,.png"><pre id="state">empty</pre><script>files.addEventListener('change',()=>state.textContent=JSON.stringify([...files.files].map(f=>f.name)))</script>`
  const url = `data:text/html,${encodeURIComponent(html)}`
  const partition = `agent-browser-gpt-pro-fixture-${randomUUID()}`
  let fixture: CdpClient | undefined
  let opened = false
  try {
    await client.evaluate(`window.api.browser.open(${JSON.stringify(partition)}, ${JSON.stringify(url)})`)
    opened = true
    const deadline = Date.now() + 10_000
    let target: Awaited<ReturnType<typeof listTargets>>[number] | undefined
    while (Date.now() < deadline) {
      target = (await listTargets(endpoint)).find((item) => item.type === "page" && item.title === "GPT-Pro file input transport fixture")
      if (target) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!target) throw new Error("Isolated browser fixture target did not appear")
    fixture = await CdpClient.connect(target.webSocketDebuggerUrl)
    await fixture.call("DOM.enable")
    const { root } = await fixture.call<{ root: { nodeId: number } }>("DOM.getDocument")
    const { nodeId } = await fixture.call<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector: "#files" })
    await fixture.call("DOM.setFileInputFiles", { nodeId, files: Object.values(fixtures) })
    await fixture.evaluate("new Promise((resolve) => setTimeout(resolve, 0))")
    const result = await fixture.evaluate<{ files: Array<{ name: string; bytesBase64: string }>; changeObserved: boolean }>(`(async() => ({
      files:await Promise.all([...document.querySelector('#files').files].map(async file=>{
        const bytes=new Uint8Array(await file.arrayBuffer())
        let binary=''
        for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192))
        return {name:file.name,bytesBase64:btoa(binary)}
      })),
      changeObserved:document.querySelector('#state').textContent!=='empty'
    }))()`)
    const expectedHashes = await Promise.all(Object.values(fixtures).map(async (path) => {
      const bytes = await readFile(path)
      return createHash("sha256").update(bytes).digest("hex")
    }))
    const names = result.files.map((file) => file.name)
    const expected = Object.values(fixtures).map((path) => path.split("/").at(-1)!)
    if (!result.changeObserved) throw new Error("CDP file input did not dispatch its native change event")
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("CDP file input did not preserve fixture names/extensions")
    const transportedHashes = result.files.map((file) => createHash("sha256").update(Buffer.from(file.bytesBase64, "base64")).digest("hex"))
    if (JSON.stringify(transportedHashes) !== JSON.stringify(expectedHashes))
      throw new Error("CDP file-input transport changed one or more fixture byte streams")
    log(`CDP file-input transport PASS files=${names.length} extensions=${names.map((name) => name.split(".").at(-1)).join(",")} byteDigests=match`)
  } finally {
    fixture?.close()
    if (opened) await client.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`).catch(() => undefined)
  }
  return { png, pasted }
}

const activePhases = ["queued", "preparing", "sending", "generating", "paused"]
try {
  if (showOnlySession) {
    await showSessionInRenderer(showOnlySession)
    client.close()
    process.exit(0)
  }
  if (!savedRun && !watchSession) {
    await mkdir(directory, { recursive: true })
    await writeFile(fixtures.markdown, `# Controlled fixture\n\nMarker: ${markers.markdown}\n`, { mode: 0o600 })
    await writeFile(fixtures.text, `Controlled text fixture marker: ${markers.text}\n`, { mode: 0o600 })
    await writeFile(fixtures.pdf, pdf(markers.pdf), { mode: 0o600 })
  }
  let imageData: { png: string; pasted: string } | undefined
  if (savedRun || watchSession) {
    for (const path of Object.values(fixtures)) {
      try {
        await stat(path)
      } catch {
        throw new Error("Watch mode fixture is missing; no fixture was regenerated")
      }
    }
  }
  if (savedRun || watchSession) {
    log("watch mode reusing existing fixture directory and marker manifest; no files rewritten")
  } else {
    imageData = await verifyFileInputTransport()
  }
  if (fixtureOnly) {
    log("fixture-only PASS; CDP file-input protocol verified without inspecting ChatGPT or sending a request")
    client.close()
    process.exit(0)
  }
  const status = await client.evaluate<GptProProbeStatus>("window.api.gptPro.status()")
  const chatTargets = (await listTargets(endpoint)).filter((item) => item.type === "page" && item.url.startsWith("https://chatgpt.com/"))
  const jobs = await client.evaluate<GptProJob[]>("window.api.gptPro.list()")
  const active = jobs.filter((job) => activePhases.includes(job.phase))
  const cloudflare = status.phase === "blocked" || /cloudflare|challenge|verification/i.test(status.detail ?? "")
  log(`probe phase=${status.phase} model=${status.page?.model ?? "unknown"} targetModel=${status.page?.targetModel ?? false} chatTargets=${chatTargets.length} activeJobs=${active.length} draftChars=${status.page?.draft.trim().length ?? 0} existingQuestions=${status.page?.users.length ?? 0}`)
  if (cloudflare) {
    log("BLOCKED: ChatGPT reports a verification/challenge state; no browser challenge was simulated and no consultation was sent")
    if (!probeOnly && !existingSession) throw new Error("Real consultation blocked by ChatGPT validation; no question was submitted")
  }

  if (probeOnly) {
    log(`probe-only fixtures=5 cdpFileInput=passed artifacts=${output}; no prompt or sidecar request was sent`)
    client.close()
    process.exit(0)
  }
  if (!existingSession) {
    if (cloudflare) throw new Error("ChatGPT validation is active; refusing to submit")
    if (active.length) throw new Error("Another GPT-Pro consultation is active; refusing to submit")
    if (chatTargets.length !== 1) throw new Error("Expected one ChatGPT target; refusing an ambiguous browser")
    if (!status.page?.composer || !status.page.targetModel || status.page.generating)
      throw new Error("An idle GPT-6 Pro composer is required; no question was sent")
    if (status.page.draft.trim() || status.page.users.length)
      throw new Error("Existing draft or conversation detected; refusing to alter it")
  }

  const markerList = Object.values(markers)
  const fileParts = [fixtures.markdown, fixtures.text, fixtures.pdf, fixtures.png].map((path) => ({
    type: "file",
    mime: path.endsWith(".md") ? "text/markdown" : path.endsWith(".txt") ? "text/plain" : path.endsWith(".pdf") ? "application/pdf" : "image/png",
    filename: path.split("/").at(-1),
    url: pathToFileURL(path).href,
  }))
  const pastedPart = {
    type: "file",
    mime: "image/png",
    filename: "pasted-image.png",
    url: imageData?.pasted ?? pathToFileURL(fixtures.pasted).href,
  }

  await client.evaluate(`(async()=>{
    const sidecar=await window.api.awaitInitialization(()=>{})
    window.__gptProAttachmentRequest=async(path,body)=>{
      const headers={'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((sidecar.username||'opencode')+':'+sidecar.password)}
      const response=await fetch(sidecar.url+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})
      if(!response.ok)throw Error('sidecar HTTP '+response.status+' path='+path)
      return response.status===204?null:response.json()
    }
    return true
  })()`)
  const sessionID = existingSession ?? await client.evaluate<string>(`(async()=>{
    const session=await window.__gptProAttachmentRequest('/session',{title:'GPT-Pro attachment integration test',permission:[
      {permission:'gpt_pro_consult',pattern:'*',action:'allow'},
      {permission:'read',pattern:'*',action:'allow'}
    ]})
    return session.id
  })()`)
  const runManifest = { sessionID, directory, background: backgroundMode, nonce, prompt, markers, fixtures }
  if (!existingSession) await writeFile(join(output, "run.json"), JSON.stringify(runManifest, null, 2), { mode: 0o600 })
  if (!existingSession) {
    await client.evaluate(`(async()=>{
      window.__gptProAttachmentPrevious=(await window.__gptProAttachmentRequest('/session/'+${JSON.stringify(sessionID)}+'/message')).map(message=>message.info.id)
      await window.__gptProAttachmentRequest('/session/'+${JSON.stringify(sessionID)}+'/prompt_async',{agent:'build',parts:[
        {type:'text',text:${JSON.stringify(prompt)},metadata:${JSON.stringify(backgroundMode ? { gptProBackground: true } : {})}},
        ...${JSON.stringify(fileParts)},
        ${JSON.stringify(pastedPart)},
        {type:'agent',name:'gpt-pro'}
      ]})
      return true
    })()`)
  } else {
    await client.evaluate(`(async()=>{window.__gptProAttachmentPrevious=[];return true})()`)
  }
  log(`${existingSession ? "watching original session" : "submitted once to real sidecar"} session=${sessionID} attachmentParts=5 promptChars=${prompt.length}; no retry will be issued`)

  const deadline = Date.now() + 30 * 60_000
  let previous = ""
  let completionObservedAt: number | undefined
  let lastInjectionLogAt = 0
  while (Date.now() < deadline) {
    const state = await client.evaluate<{
      job?: GptProJob
      tool?: { status: string; metadata?: Record<string, unknown>; output?: unknown }
      inputFileCount: number
      inputDocumentNames: string[]
      inputImageCount: number
      inputFileIDs: string[]
      completionInjected: boolean
    }>(`(async()=>{
      const messages=await window.__gptProAttachmentRequest('/session/'+${JSON.stringify(sessionID)}+'/message')
      const fresh=messages.filter(message=>!window.__gptProAttachmentPrevious||!window.__gptProAttachmentPrevious.includes(message.info.id))
      const parts=fresh.flatMap(message=>message.parts)
      const tool=parts.filter(part=>part.type==='tool'&&part.tool==='gpt_pro_consult'&&(!${JSON.stringify(consultationID ?? null)}||part.state.metadata?.consultation_id===${JSON.stringify(consultationID ?? null)})).at(-1)
      const user=fresh.filter(message=>message.info.role==='user'&&message.parts.some(part=>part.type==='text'&&part.text===${JSON.stringify(prompt)})).at(-1)
      const files=user?.parts.filter(part=>part.type==='file')||[]
      const id=${JSON.stringify(consultationID ?? null)}||tool?.state.metadata?.consultation_id
      const job=id?await window.api.gptPro.command({action:'read',id}):undefined
      const completionInjected=!!job?.text&&fresh.some(message=>message.parts.some(part=>part.type==='text'&&part.metadata?.consultationID===id&&part.metadata?.phase==='completed'&&part.text.includes(job.text)))
      return {
        job,
        tool:tool?{status:tool.state.status,metadata:tool.state.metadata,output:tool.state.output}:undefined,
        inputFileCount:files.length,
        inputDocumentNames:files.filter(part=>!part.mime?.startsWith('image/')).map(part=>part.filename||decodeURIComponent(new URL(part.url).pathname.split('/').at(-1)||'')),
        inputImageCount:files.filter(part=>part.mime?.startsWith('image/')).length,
        inputFileIDs:files.map(part=>part.id||''),
        completionInjected
      }
    })()`)
    const attachments = Array.isArray(state.job?.attachments)
      ? state.job!.attachments!
      : Array.isArray(state.tool?.metadata?.attachments)
        ? (state.tool!.metadata!.attachments as Array<{ name?: string; status?: string; error?: string }>)
        : []
    const summary = `phase=${state.job?.phase ?? "pending"} files=${attachments.length} states=${attachments.map((item) => `${item.status ?? "unknown"}`).join(",")} answerChars=${state.job?.text?.length ?? 0} completionInjected=${state.completionInjected}`
    if (summary !== previous) {
      log(summary)
      previous = summary
    }
    if (state.job?.phase === "completed") {
      completionObservedAt ??= Date.now()
      const livePage = await inspectLiveTarget(state.job)
      const names = attachments.map((item) => item.name ?? "")
      const expectedNames = ["evidence.md", "notes.txt", "report.pdf", "chart.png", "pasted-image.png"]
      const expectedDocumentNames = ["evidence.md", "notes.txt", "report.pdf"]
      const allReady = attachments.length === 5 && attachments.every((item) => item.status === "ready")
      const allMarkers = markerList.every((marker) => state.job!.text?.includes(marker))
      const distinctNames = expectedNames.filter((name) => names.includes(name)).length
      const uniqueAttachmentIDs = new Set(attachments.map((item) => item.id)).size === 5
      const exactJobAttachments = attachments.length === 5 && JSON.stringify(names) === JSON.stringify(expectedNames)
      const exactInputAttachments = state.inputFileCount === 5 &&
        JSON.stringify(state.inputDocumentNames) === JSON.stringify(expectedDocumentNames) &&
        state.inputImageCount === 2 &&
        state.inputFileIDs.length === 5 && new Set(state.inputFileIDs.filter(Boolean)).size === 5
      const lastQuestion = livePage.users.at(-1)
      const turnAttachments = lastQuestion?.attachments ?? []
      const turnDocuments = turnAttachments.filter((item) => item.kind === "document")
      const turnImages = turnAttachments.filter((item) => item.kind === "image")
      const expectedSentDocumentNames = attachments
        .filter((item) => !item.mime.startsWith("image/"))
        .map((item) => item.uploadName ?? item.name)
      const jobImageDigests = attachments.filter((item) => item.mime.startsWith("image/")).map((item) => item.sha256).sort()
      const turnImageDigests = turnImages.map((item) => item.sha256 ?? "").sort()
      const exactTurnDocuments = turnDocuments.length === 3 &&
        JSON.stringify(turnDocuments.map((item) => item.name)) === JSON.stringify(expectedSentDocumentNames) &&
        turnDocuments.every((item) => item.status === "ready")
      const imageDigestsMatch = turnImages.length === 2 && turnImages.every((item) => item.status === "ready" && item.sha256) &&
        JSON.stringify(turnImageDigests) === JSON.stringify(jobImageDigests)
      const pageMatches = livePage.url === state.job.url &&
        lastQuestion?.id === state.job.userID &&
        lastQuestion?.text === state.job.prompt &&
        livePage.answer?.userID === state.job.userID && exactTurnDocuments && imageDigestsMatch
      const backgroundRun = state.job.background === true
      const modeMatches = backgroundRun === backgroundMode
      let toolOutput: Record<string, unknown> | undefined
      try {
        const parsed = typeof state.tool?.output === "string" ? JSON.parse(state.tool.output) : state.tool?.output
        if (parsed && typeof parsed === "object") toolOutput = parsed as Record<string, unknown>
      } catch {}
      const foregroundToolResult = !backgroundMode &&
        state.tool?.status === "completed" &&
        state.tool.metadata?.consultation_id === state.job.id &&
        state.tool.metadata?.text === state.job.text &&
        toolOutput?.consultation_id === state.job.id &&
        toolOutput?.phase === "completed" &&
        toolOutput?.model === state.job.model &&
        toolOutput?.background === false &&
        toolOutput?.text === state.job.text &&
        toolOutput?.html === state.job.html
      const backgroundInjection = backgroundMode && state.completionInjected
      const deliveredToParent = modeMatches && (backgroundMode ? backgroundInjection : foregroundToolResult)
      const pageMarkers = markerList.every((marker) => livePage.answer?.text.includes(marker))
      const contentVerified = state.job.model === "GPT-6 Pro" && state.job.submitted && !!state.job.userID && modeMatches &&
        allReady && uniqueAttachmentIDs && exactJobAttachments && distinctNames === 5 && exactInputAttachments && pageMatches &&
        allMarkers && pageMarkers
      const deliveryMode = backgroundMode ? "background" : "foreground"
      log(`completion evidence mode=${deliveryMode} model=${state.job.model ?? "unknown"} submitted=${state.job.submitted} userID=${!!state.job.userID} exactTarget=${livePage.url === state.job.url} exactJobFiles=${exactJobAttachments} exactInputFiles=${exactInputAttachments} namedDocs=${exactTurnDocuments} imageDigests=${imageDigestsMatch} pageMatches=${pageMatches} modeMatches=${modeMatches} foregroundToolResult=${foregroundToolResult} backgroundInjection=${backgroundInjection} jobMarkers=${allMarkers} pageMarkers=${pageMarkers}`)
      await writeFile(join(output, "answer.txt"), state.job.text ?? "", { mode: 0o600 })
      const evidence = {
        sessionID,
        consultationID: state.job.id,
        phase: state.job.phase,
        model: state.job.model,
        submitted: state.job.submitted,
        hasUserID: !!state.job.userID,
        attachments: attachments.map((item) => ({ name: item.name, status: item.status, hasError: !!item.error })),
        allReady,
        uniqueAttachmentIDs,
        exactJobAttachments,
        distinctFixtureNames: distinctNames,
        exactInputAttachments,
        exactTurnDocuments,
        imageDigestsMatch,
        pageMatches,
        pageMarkers,
        deliveryMode,
        modeMatches,
        foregroundToolResult,
        backgroundInjection,
        backgroundRun,
        deliveredToParent,
        markersFound: markerList.map((marker) => ({ marker, found: state.job!.text?.includes(marker) ?? false })),
        contentVerified,
      }
      if (!contentVerified) {
        await writeFile(join(output, "result.json"), JSON.stringify({ ...evidence, verified: false }, null, 2), { mode: 0o600 })
        throw new Error(`Completed consultation did not verify every fixture; artifacts=${output}`)
      }
      if (!deliveredToParent) {
        const waitedMs = Date.now() - completionObservedAt
        if (Date.now() - lastInjectionLogAt >= 10_000) {
          log(`all job and live-page evidence passed; waiting for actual ${deliveryMode} delivery evidence elapsedSeconds=${Math.floor(waitedMs / 1000)} limitSeconds=60`)
          lastInjectionLogAt = Date.now()
        }
        await writeFile(join(output, "result.json"), JSON.stringify({
          ...evidence,
          deliveryPending: true,
          waitedForInjectionMs: waitedMs,
          verified: false,
        }, null, 2), { mode: 0o600 })
        if (waitedMs >= 60_000) throw new Error(`Parent completion injection did not arrive within 60 seconds; artifacts=${output}`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      await writeFile(join(output, "result.json"), JSON.stringify({ ...evidence, verified: deliveredToParent }, null, 2), { mode: 0o600 })
      if (showSession) await showSessionInRenderer(sessionID)
      log(`PASS five ready attachment states, exact input parts, matching answer, and foreground/background delivery verified; artifacts=${output}`)
      break
    }
    if (state.job?.phase === "paused") {
      const recovery = state.job.recovery?.stage ?? "none"
      const safeError = (state.job.error ?? "no error detail").replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+|\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g, "[local path]").slice(0, 240)
      log(`consultation paused recovery=${recovery} error=${safeError}; no automated resume or send was attempted`)
      if (showSession) await showSessionInRenderer(sessionID)
      throw new Error("Consultation is paused for explicit recovery; use --watch-run after recovery to continue observation")
    }
    if (state.job && ["failed", "cancelled", "interrupted", "send_uncertain"].includes(state.job.phase)) {
      const safeError = (state.job.error ?? "unknown error").replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+|\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g, "[local path]").slice(0, 240)
      if (showSession) await showSessionInRenderer(sessionID)
      throw new Error(`Consultation stopped phase=${state.job.phase}: ${safeError}; never resent`)
    }
    if (Date.now() + 2000 >= deadline) throw new Error(`Timed out while preserving the original consultation; artifacts=${output}`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
} finally {
  client.close()
}
