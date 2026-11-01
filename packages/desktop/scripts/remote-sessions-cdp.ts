#!/usr/bin/env bun
import { resolve } from "node:path"
import { CdpClient, connectCdp, listTargets } from "./cdp"
import { createRemoteGateway } from "../src/main/remote/gateway"

// Read existing sessions through an isolated loopback gateway. No public tunnel,
// model requests, project registration, or changes to the host's sessions.
const directory = process.argv[2]
if (!directory) throw new Error("Provide a project directory (quote ~/... to test legacy browser paths)")
const { client: desktop } = await connectCdp()
const pageID = `remote-sessions-qa-${Date.now()}`
let browser: CdpClient | undefined
let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined

async function waitFor(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out: ${label}`)
}

try {
  const upstream = await desktop.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(()=>{})",
  )
  gateway = await createRemoteGateway({
    upstream: () => upstream,
    webRoot: resolve(import.meta.dir, "../resources/remote-web"),
    saveAuth: async () => {},
    log: (line) => console.log(`[remote-sessions-qa] ${line}`),
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
  }, "temporary browser")
  browser = await CdpClient.connect(targetURL!)
  await browser.call("Page.enable")
  await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  await browser.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await browser.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    window.__sessionQaErrors=[];window.__sessionQaRequests=[];window.__sessionQaLogs=[];
    addEventListener('error',e=>window.__sessionQaErrors.push(e.message));
    addEventListener('unhandledrejection',e=>window.__sessionQaErrors.push(String(e.reason)));
    const debug=console.debug;
    console.debug=(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('[remote-fetch]'))window.__sessionQaLogs.push(args[0]);debug(...args)};
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      const u=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method??input?.method??'GET').toUpperCase();
      if(!['GET','HEAD'].includes(method)&&!['/remote/api/pair/redeem','/remote/api/presence'].includes(u.pathname))throw new Error('Read-only QA blocked write: '+method+' '+u.pathname);
      const r=await original(input,init);
      window.__sessionQaRequests.push({path:u.pathname,status:r.status,tilde:u.searchParams.get('directory')?.startsWith('~')??false});
      return r;
    };
  `,
  })
  await waitFor(() => browser!.evaluate<boolean>("!!document.querySelector('#connect')"), "pairing form")
  await browser.evaluate(
    "document.querySelector('#name').value='Read-only session QA';document.querySelector('#connect').click()",
  )
  await waitFor(
    () => browser!.evaluate<boolean>(`location.href===${JSON.stringify(gateway.url + "/")}`),
    "paired browser",
  )
  // Reproduce an already-open project saved by an older remote browser. This
  // storage belongs only to this throwaway origin, not the desktop profile.
  await browser.evaluate(
    `localStorage.setItem('opencode.global.dat:server',JSON.stringify({list:[],projects:{local:[{worktree:${JSON.stringify(directory)},expanded:true}]},lastProject:{}}));localStorage.setItem('opencode.global.dat:layout',JSON.stringify({sidebar:{opened:true,width:344},fileTree:{opened:false},rightPanel:{}}))`,
  )
  await browser.call("Page.navigate", { url: `${gateway.url}/${Buffer.from(directory).toString("base64url")}/session` })
  await waitFor(
    () => browser!.evaluate<boolean>("!!document.querySelector('[data-action=project-switch]')"),
    "project rail",
  )
  await browser.evaluate(
    "const p=document.querySelector('[data-action=project-switch]');if(p.getAttribute('data-sidebar-expanded')!=='true')p.click()",
  )
  await waitFor(
    () =>
      browser!.evaluate<boolean>(
        "document.querySelectorAll('[data-component=sidebar-session]').length>0 || window.__sessionQaRequests.some(r=>r.path==='/session'&&r.status>=400)",
      ),
    "session rows",
  )
  const state = await browser.evaluate<{
    rows: number
    errors: string[]
    failed: unknown[]
    unresolved: number
    logs: string[]
  }>(`({
    rows:document.querySelectorAll('[data-component=sidebar-session]').length,
    errors:window.__sessionQaErrors,
    failed:window.__sessionQaRequests.filter(r=>['/session','/path','/config','/remote/api/directory'].includes(r.path)&&r.status>=400),
    unresolved:window.__sessionQaRequests.filter(r=>r.tilde).length,
    logs:window.__sessionQaLogs
  })`)
  console.log(`[remote-sessions-qa] result=${JSON.stringify(state)}`)
  if (!state.rows || state.errors.length || state.failed.length || state.unresolved)
    throw new Error("Remote session list regression")
  if (directory.startsWith("~") && !state.logs.some((line) => line.includes("directory request normalized"))) {
    throw new Error("Legacy directory normalization was not exercised")
  }
  console.log("[remote-sessions-qa] PASS; session rows rendered without modifying host sessions")
} finally {
  browser?.close()
  await desktop.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
  desktop.close()
  await gateway?.close()
}
