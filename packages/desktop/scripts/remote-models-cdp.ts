#!/usr/bin/env bun
import { resolve } from "node:path"
import { CdpClient, connectCdp, listTargets } from "./cdp"
import { createRemoteGateway } from "../src/main/remote/gateway"

// Read-only verification against the current backend through a separate,
// temporary loopback gateway. Never starts a model request or edits a session.
const directories = process.argv.slice(2).map((path) => resolve(path))
if (!directories.length) throw new Error("Provide one or more project directories")
const { client: desktop } = await connectCdp()
const pageID = `remote-models-qa-${Date.now()}`
let browser: CdpClient | undefined
let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined

async function waitFor(read: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out: ${description}`)
}

try {
  const upstream = await desktop.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(()=>{})",
  )
  gateway = await createRemoteGateway({
    upstream: () => upstream,
    webRoot: resolve(import.meta.dir, "../resources/remote-web"),
    saveAuth: async () => {},
    log: (line) => console.log(`[remote-models-qa] ${line}`),
    allowHttpForTests: true,
  })
  gateway.setPublicOrigin(gateway.url)
  const pairing = await gateway.createPairing(gateway.url)
  const existing = new Set((await listTargets()).map((target) => target.id))
  await desktop.evaluate(`window.api.browser.open(${JSON.stringify(pageID)},${JSON.stringify(pairing.url)})`)
  let targetURL: string | undefined
  await waitFor(async () => {
    targetURL = (await listTargets()).find(
      (target) => !existing.has(target.id) && target.url.startsWith(gateway!.url),
    )?.webSocketDebuggerUrl
    return !!targetURL
  }, "temporary browser page")
  browser = await CdpClient.connect(targetURL!)
  await browser.call("Page.enable")
  await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  await browser.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 664,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await browser.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    window.__modelQaErrors=[];window.__modelQaFailures=[];
    addEventListener('error',e=>window.__modelQaErrors.push(e.message));
    addEventListener('unhandledrejection',e=>window.__modelQaErrors.push(String(e.reason)));
    const originalFetch=window.fetch;
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method??input?.method??'GET').toUpperCase();
      if(!['GET','HEAD'].includes(method)&&url.pathname!=='/remote/api/pair/redeem')throw new Error('Read-only QA blocked write: '+method+' '+url.pathname);
      const response=await originalFetch(input,init);
      if(response.status>=400)window.__modelQaFailures.push({path:url.pathname,status:response.status});
      return response;
    };
  `,
  })
  await waitFor(() => browser!.evaluate<boolean>("!!document.querySelector('#connect')"), "pairing form")
  await browser.evaluate(
    "document.querySelector('#name').value='Read-only model QA';document.querySelector('#connect').click()",
  )
  await waitFor(
    () => browser!.evaluate<boolean>(`location.href===${JSON.stringify(gateway.url + "/")}`),
    "paired browser",
  )
  for (const directory of directories) {
    const query = `?directory=${encodeURIComponent(directory)}`
    const result = await browser.evaluate<{
      status: number
      providers: number
      connected: number
      models: number
      connectedModels: number
    }>(`fetch(${JSON.stringify("/provider" + query)},{signal:AbortSignal.timeout(20000)}).then(async r=>{
      const data=await r.json();const connected=new Set(data.connected??[]);
      return {status:r.status,providers:data.all?.length??0,connected:connected.size,models:(data.all??[]).reduce((n,p)=>n+Object.keys(p.models).length,0),connectedModels:(data.all??[]).filter(p=>connected.has(p.id)).reduce((n,p)=>n+Object.keys(p.models).length,0)};
    })`)
    console.log(
      `[remote-models-qa] directory=${directory} status=${result.status} providers=${result.providers} connected=${result.connected} models=${result.models} connectedModels=${result.connectedModels}`,
    )
    if (result.status !== 200 || !result.connectedModels)
      throw new Error("Real model catalog did not survive the gateway")
  }
  const url = `${gateway.url}/${Buffer.from(directories[0]).toString("base64url")}/session`
  await browser.call("Page.navigate", { url })
  await waitFor(
    () => browser!.evaluate<boolean>("!!document.querySelector('[data-action=prompt-mobile-model]')"),
    "mobile composer",
  )
  await waitFor(
    () =>
      browser!.evaluate<boolean>(
        "(window.__modelQaFailures??[]).length>0 || !document.querySelector('[data-action=prompt-mobile-model]').innerText.includes('Select model')",
      ),
    "selected model",
  )
  await browser.evaluate("document.querySelector('[data-action=prompt-mobile-model]').click()")
  await waitFor(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelectorAll('[data-model-selector-popover-content] [data-slot=list-item]').length>0",
      ),
    "actual visible model options",
  )
  const state = await browser.evaluate<{ options: number; errors: string[]; failures: unknown[] }>(
    `({options:document.querySelectorAll('[data-model-selector-popover-content] [data-slot=list-item]').length,errors:window.__modelQaErrors??[],failures:window.__modelQaFailures??[]})`,
  )
  console.log(
    `[remote-models-qa] mobile-picker options=${state.options} errors=${state.errors.length} failedRequests=${state.failures.length}`,
  )
  if (state.errors.length || state.failures.length)
    throw new Error(`Browser bootstrap failed: ${JSON.stringify(state)}`)
  console.log("[remote-models-qa] PASS; no message sent and no existing session modified")
} finally {
  browser?.close()
  await desktop.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
  desktop.close()
  await gateway?.close()
}
