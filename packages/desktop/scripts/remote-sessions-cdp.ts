#!/usr/bin/env bun
import { resolve } from "node:path"
import { CdpClient, connectCdp, listTargets } from "./cdp"
import { createRemoteGateway } from "../src/main/remote/gateway"

// Read existing sessions through an isolated loopback gateway, or an already
// online public host with --public. Never enable a tunnel or modify sessions.
const directory = process.argv[2]
if (!directory) throw new Error("Provide a project directory (quote ~/... to test legacy browser paths)")
const routeDirectory = process.argv[3] ?? directory
const publicHost = process.argv.includes("--public")
const projectIndex = process.argv.includes("--project-index")
const delayProjectMetadata = process.argv.includes("--delay-project-metadata")
const { client: desktop } = await connectCdp()
const pageID = `remote-sessions-qa-${Date.now()}`
let browser: CdpClient | undefined
let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined
let deviceID: string | undefined

async function waitFor(read: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await read()) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out: ${label}`)
}

try {
  let origin: string
  let pairing: { url: string }
  if (publicHost) {
    const status = await desktop.evaluate<{ phase: string; url?: string }>("window.api.remoteAccess.status()")
    if (status.phase !== "online" || !status.url) throw new Error("Public remote host must already be online")
    origin = status.url
    pairing = await desktop.evaluate("window.api.remoteAccess.pair()")
  } else {
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
    origin = gateway.url
    pairing = await gateway.createPairing(origin)
  }
  const existing = new Set((await listTargets()).map((target) => target.id))
  await desktop.evaluate(`window.api.browser.open(${JSON.stringify(pageID)},${JSON.stringify(pairing.url)})`)
  let targetURL: string | undefined
  await waitFor(async () => {
    targetURL = (await listTargets()).find(
      (target) => !existing.has(target.id) && target.url.startsWith(origin),
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
    const metadataGate=${delayProjectMetadata} ? new Promise(resolve=>{window.__sessionQaReleaseMetadata=resolve}) : Promise.resolve();
    addEventListener('error',e=>window.__sessionQaErrors.push(e.message));
    addEventListener('unhandledrejection',e=>window.__sessionQaErrors.push(String(e.reason)));
    const debug=console.debug;
    console.debug=(...args)=>{if(typeof args[0]==='string'&&['[remote-fetch]','[global-sync]'].some(p=>args[0].startsWith(p)))window.__sessionQaLogs.push(args[0]);debug(...args)};
    const original=window.fetch;
    window.fetch=async(input,init)=>{
      const u=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method??input?.method??'GET').toUpperCase();
      if(!['GET','HEAD'].includes(method)&&!['/remote/api/pair/redeem','/remote/api/presence'].includes(u.pathname))throw new Error('Read-only QA blocked write: '+method+' '+u.pathname);
      const r=await original(input,init);
      if(u.pathname==='/project')await metadataGate;
      window.__sessionQaRequests.push({path:u.pathname,status:r.status,tilde:u.searchParams.get('directory')?.startsWith('~')??false});
      return r;
    };
  `,
  })
  await waitFor(() => browser!.evaluate<boolean>("!!document.querySelector('#connect')"), "pairing form")
  await browser.evaluate(
    "document.querySelector('#name').value='Read-only session QA';document.querySelector('#connect').click()",
  )
  await waitFor(() => browser!.evaluate<boolean>(`location.href===${JSON.stringify(origin + "/")}`), "paired browser")
  if (publicHost)
    deviceID = await browser.evaluate("fetch('/remote/api/session').then(r=>r.json()).then(s=>s.device.id)")
  const expectedIDs = await browser.evaluate<string[]>(`(async()=>{
    const d=await fetch('/remote/api/directory?'+new URLSearchParams({path:${JSON.stringify(directory)},mode:'validate'})).then(r=>r.json());
    const sessions=await fetch('/session?'+new URLSearchParams({directory:d.path,roots:'true'})).then(r=>r.json());
    return sessions.map(s=>s.id);
  })()`)
  if (!expectedIDs.length) throw new Error("The target project must have existing root sessions")
  // Reproduce an already-open project saved by an older remote browser. This
  // storage belongs only to this throwaway origin, not the desktop profile.
  await browser.evaluate(
    `localStorage.setItem('opencode.global.dat:server',JSON.stringify({list:[],projects:{[${JSON.stringify(publicHost ? origin : "local")}]:${JSON.stringify([...new Set([directory, routeDirectory])].map((worktree) => ({ worktree, expanded: true })))}},lastProject:{}}));localStorage.setItem('opencode.global.dat:layout',JSON.stringify({sidebar:{opened:true,width:344},fileTree:{opened:false},rightPanel:{}}))`,
  )
  await browser.call("Page.navigate", {
    url: `${origin}/${Buffer.from(routeDirectory).toString("base64url")}${projectIndex ? "" : "/session"}`,
  })
  await waitFor(
    () =>
      browser!.evaluate<boolean>(
        projectIndex
          ? "!!document.querySelector('[data-action=project-switch][data-session-current=true]')"
          : "location.pathname.includes('/session/new/') && !!document.querySelector('[data-component=prompt-input]') && !!document.querySelector('[data-action=project-switch][data-session-current=true]')",
      ),
    "resolved route project and stable draft page",
  )
  const targetSelector = `[data-action=project-switch][data-project="${Buffer.from(directory).toString("base64url")}"]`
  const selectTarget = `(() => {const p=document.querySelector(${JSON.stringify(targetSelector)});if(!p)throw new Error('Expected project missing');if(p.getAttribute('data-sidebar-expanded')!=='true')p.click()})()`
  const routeBeforeSelection = await browser.evaluate<string>("location.pathname")
  await browser.evaluate(selectTarget)
  if (delayProjectMetadata) {
    console.log("[remote-sessions-qa] releasing delayed project metadata after first explicit selection")
    await browser.evaluate("window.__sessionQaReleaseMetadata?.()")
  }
  await waitFor(
    () =>
      browser!.evaluate<boolean>(
        `window.__sessionQaRequests.some(r=>r.path==='/session'&&r.status>=400) || window.__sessionQaLogs.some(l=>l.startsWith(${JSON.stringify(`[global-sync] load sessions success directory=${directory} `)}))`,
      ),
    "session rows",
  )
  // Never compensate for initialization overwriting the first explicit selection.
  const selected = await browser.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(targetSelector)})?.getAttribute('data-sidebar-expanded')==='true'`,
  )
  if (selected) {
    await waitFor(
      () =>
        browser!.evaluate<boolean>(
          `!!document.querySelector('[data-action=project-switch][data-project="${Buffer.from(directory).toString("base64url")}"][data-sidebar-expanded=true]')`,
        ),
      "selected target project",
    )
  }
  const state = await browser.evaluate<{
    rows: number
    matching: number
    errors: string[]
    failed: unknown[]
    unresolved: number
    logs: string[]
    route: string
    visibleIDs: string[]
    selected: string[]
  }>(`({
    rows:document.querySelectorAll('[data-component=sidebar-session]').length,
    matching:[...document.querySelectorAll('[data-component=sidebar-session]')].filter(e=>${JSON.stringify(expectedIDs)}.includes(e.dataset.sessionId)).length,
    selected:[...document.querySelectorAll('[data-action=project-switch][data-sidebar-expanded=true]')].map(e=>e.dataset.project),
    route:location.pathname,
    visibleIDs:[...document.querySelectorAll('[data-component=sidebar-session]')].map(e=>e.dataset.sessionId),
    errors:window.__sessionQaErrors,
    failed:window.__sessionQaRequests.filter(r=>['/session','/path','/config','/remote/api/directory'].includes(r.path)&&r.status>=400),
    unresolved:window.__sessionQaRequests.filter(r=>r.tilde).length,
    logs:window.__sessionQaLogs
  })`)
  console.log(
    `[remote-sessions-qa] result=${JSON.stringify({ ...state, expectedIDs, routeBeforeSelection, firstSelectionPreserved: selected })}`,
  )
  if (!selected) throw new Error("P3 regression: initialization overwrote explicit sidebar selection")
  // A bare index may finish its existing same-project initial-draft redirect.
  // Preview must never navigate to the selected project or another conversation.
  const initialDraftRedirect =
    projectIndex &&
    routeBeforeSelection === `/${Buffer.from(routeDirectory).toString("base64url")}` &&
    state.route.startsWith(`${routeBeforeSelection}/session/new/`)
  if (
    !state.matching ||
    state.visibleIDs.some((id) => !expectedIDs.includes(id)) ||
    (state.route !== routeBeforeSelection && !initialDraftRedirect) ||
    !state.selected.includes(Buffer.from(directory).toString("base64url")) ||
    state.errors.length ||
    state.failed.length ||
    state.unresolved
  )
    throw new Error("Remote session list regression")
  if (directory.startsWith("~") && !state.logs.some((line) => line.includes("directory request normalized"))) {
    throw new Error("Legacy directory normalization was not exercised")
  }
  if (process.argv.includes("--open-session")) {
    const sessionID = state.visibleIDs[0]
    await browser.evaluate(`(() => {
      const row=document.querySelector('[data-component="sidebar-session"][data-session-id="${sessionID}"]');
      const link=row?.querySelector('a');
      if(!link)throw new Error('Session link missing');
      link.click();
    })()`)
    await waitFor(
      () =>
        browser!.evaluate<boolean>(
          `location.pathname.endsWith('/session/${sessionID}') && !!document.querySelector('[data-component="session-page"][data-session-id="${sessionID}"]') && !!document.querySelector('[data-component="prompt-input"]')`,
        ),
      "existing conversation and composer",
    )
    const opened = await browser.evaluate(
      `({route:location.pathname,errors:window.__sessionQaErrors,failed:window.__sessionQaRequests.filter(r=>r.status>=400)})`,
    )
    console.log(`[remote-sessions-qa] opened-session id=${sessionID} result=${JSON.stringify(opened)}`)
  }
  console.log("[remote-sessions-qa] PASS; session rows rendered without modifying host sessions")
} finally {
  if (publicHost && !deviceID && browser)
    deviceID = await browser
      .evaluate<string>("fetch('/remote/api/session').then(r=>r.json()).then(s=>s.device?.id)")
      .catch(() => undefined)
  if (publicHost && deviceID) await desktop.evaluate(`window.api.remoteAccess.revoke(${JSON.stringify(deviceID)})`)
  browser?.close()
  await desktop.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
  desktop.close()
  await gateway?.close()
}
