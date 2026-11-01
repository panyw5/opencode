#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CdpClient, connectCdp, listTargets } from "./cdp"

// Inspect an already-online dev host. Never enable a tunnel, send a message,
// select a menu action, or modify host projects; revoke only this QA device.
const directory = resolve(process.argv[2] ?? process.cwd())
const { client: desktop } = await connectCdp()
const pageID = `remote-menu-qa-${Date.now()}`
let browser: CdpClient | undefined
let deviceID: string | undefined

async function wait(read: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await read().catch(() => false)) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out: ${description}`)
}

try {
  const status = await desktop.evaluate<{ phase: string; url?: string }>("window.api.remoteAccess.status()")
  if (status.phase !== "online" || !status.url) throw new Error("The dev remote host must already be online")
  const pairing = await desktop.evaluate<{ url: string }>("window.api.remoteAccess.pair()")
  const existing = new Set((await listTargets()).map((target) => target.id))
  await desktop.evaluate(`window.api.browser.open(${JSON.stringify(pageID)},${JSON.stringify(pairing.url)})`)
  let targetURL = ""
  await wait(async () => {
    targetURL =
      (await listTargets()).find((target) => !existing.has(target.id) && target.url.startsWith(status.url!))
        ?.webSocketDebuggerUrl ?? ""
    return !!targetURL
  }, "public QA browser")
  browser = await CdpClient.connect(targetURL)
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
      const nativeFetch=window.fetch;
      window.fetch=(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        const method=(init?.method??input?.method??'GET').toUpperCase();
        if(!['GET','HEAD'].includes(method)&&!['/remote/api/pair/redeem','/remote/api/presence'].includes(url.pathname))throw new Error('Read-only menu QA blocked write');
        return nativeFetch(input,init);
      };
    `,
  })
  await wait(() => browser!.evaluate("!!document.querySelector('#connect')"), "pairing form")
  await browser.evaluate(
    "document.querySelector('#name').value='Temporary menu QA';document.querySelector('#connect').click()",
  )
  await wait(() => browser!.evaluate("!!document.querySelector('[data-component=home-path-input]')"), "public Home")
  deviceID = await browser.evaluate<string>("fetch('/remote/api/session').then(r=>r.json()).then(s=>s.device.id)")
  // Project rail preferences belong only to this throwaway browser partition.
  await browser.evaluate(
    `localStorage.setItem('opencode.global.dat:server',JSON.stringify({list:[],projects:{[location.origin]:[{worktree:${JSON.stringify(directory)},expanded:true}]},lastProject:{}}))`,
  )
  await browser.call("Page.reload")
  await wait(
    () => browser!.evaluate("!!document.querySelector('[data-action=project-switch]')"),
    "actual project menu trigger",
  )
  const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const r=document.querySelector('[data-action=project-switch]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`)
  await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", clickCount: 1 })
  await browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", clickCount: 1 })
  await wait(
    () => browser!.evaluate("!!document.querySelector('[data-component=context-menu-content][data-expanded]')"),
    "actual project context menu",
  )
  await wait(
    () =>
      browser!.evaluate(
        "getComputedStyle(document.querySelector('[data-component=context-menu-content]')).opacity==='1'",
      ),
    "menu opening animation",
  )
  const actual = await browser.evaluate(`(() => {
    const menu=document.querySelector('[data-component=context-menu-content]');const s=getComputedStyle(menu);
    return {background:s.backgroundColor,blur:s.backdropFilter,items:menu.querySelectorAll('[role=menuitem]').length,styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(link=>link.href)};
  })()`)
  console.log(`[remote-menu-qa] actual-context-menu=${JSON.stringify(actual)}`)
  const screenshot = await browser.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await writeFile("/private/tmp/opencode-remote-context-menu.png", Buffer.from(screenshot.data, "base64"))

  // Probe all shared floating surfaces and arrows against the published CSS.
  const checks = await browser.evaluate<
    Array<{ name: string; theme: string; scheme: string; alpha: number; blur: string; arrowAlpha: number }>
  >(`(() => {
    const results=[];const html=document.documentElement;const previous=html.style.colorScheme;const previousTheme=html.dataset.theme;
    const context=document.createElement('canvas').getContext('2d');
    const alpha=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return context.getImageData(0,0,1,1).data[3]};
    for(const theme of ['claude','arc','aether','chatgpt']) for(const scheme of ['light','dark']) {
      html.dataset.theme=theme;
      html.style.colorScheme=scheme;
      for(const name of ['dialog','context-menu','context-menu-sub','dropdown-menu','dropdown-menu-sub','popover','hover-card','select']) {
        const panel=document.createElement('div');
        if(name==='dialog')panel.dataset.slot='dialog-content';else panel.dataset.component=name+'-content';
        const arrow=document.createElementNS('http://www.w3.org/2000/svg','svg');arrow.dataset.slot=name.replace(/-sub$/,'')+'-arrow';panel.append(arrow);document.body.append(panel);
        const style=getComputedStyle(panel);const fill=getComputedStyle(arrow).fill;
        results.push({name,theme,scheme,alpha:alpha(style.backgroundColor),blur:style.backdropFilter,arrowAlpha:alpha(fill)});
        panel.remove();
      }
    }
    html.style.colorScheme=previous;if(previousTheme===undefined)delete html.dataset.theme;else html.dataset.theme=previousTheme;return results;
  })()`)
  for (const check of checks) {
    if (check.alpha !== 255 || check.blur !== "none" || check.arrowAlpha !== 255)
      throw new Error(`Transparent floating surface: ${JSON.stringify(check)}`)
  }
  console.log(
    `[remote-menu-qa] surfaces=${checks.length} themes=claude,arc,aether,chatgpt schemes=light,dark alpha=255 blur=none`,
  )
  console.log(
    "[remote-menu-qa] PASS actual public project menu and 64 floating-surface checks; no menu action selected",
  )
} finally {
  if (!deviceID && browser)
    deviceID = await browser
      .evaluate<string>("fetch('/remote/api/session').then(r=>r.json()).then(s=>s.device?.id)")
      .catch(() => undefined)
  if (deviceID) await desktop.evaluate(`window.api.remoteAccess.revoke(${JSON.stringify(deviceID)})`)
  browser?.close()
  await desktop.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
  desktop.close()
}
