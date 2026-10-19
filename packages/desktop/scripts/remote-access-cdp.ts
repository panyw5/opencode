#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises"
import { CdpClient, connectCdp, listTargets } from "./cdp"

const path = process.argv[2]
if (!path) throw new Error("Usage: bun packages/desktop/scripts/remote-access-cdp.ts <browser-invite.json>")
const invite = JSON.parse(await readFile(path, "utf8")) as {
  url: string
  directory: string
  sessionId: string
  permission?: boolean
}
const origin = new URL(invite.url).origin
const pageId = `remote-access-qa-${Date.now()}`
const keepPage = process.argv.includes("--keep")
const responsive = process.argv.includes("--responsive")
const skipScreenshots = process.argv.includes("--no-screenshots")
const permissionTest = invite.permission || process.argv.includes("--permission")
const locale = process.argv.find((arg) => arg.startsWith("--locale="))?.slice("--locale=".length)
const { client: desktop } = await connectCdp()
let browser: CdpClient | undefined

async function waitFor<T>(read: () => Promise<T | undefined>, description: string, milliseconds = 45_000): Promise<T> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(250)
  }
  throw new Error(`Timed out: ${description}`)
}

async function captureScreenshot() {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      browser!.call<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Hidden Electron view did not paint; rerun with --no-screenshots for layout and interaction checks",
              ),
            ),
          15_000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resizeViewport(width: number, height: number) {
  await browser!.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true })
  if (!skipScreenshots) return
  // Hidden native views may suspend rendering-event delivery too. Exercise the
  // app's listeners against the browser's actual CSS/media/visual viewport values.
  await browser!.evaluate(`(() => {
    for(const query of window.__remoteQaMedia??[])query.dispatchEvent(new MediaQueryListEvent('change',{matches:query.matches,media:query.media}));
    dispatchEvent(new Event('resize'));
    visualViewport?.dispatchEvent(new Event('resize'));
  })()`)
}

async function checkResponsiveLayouts() {
  const fits = (selector: string) =>
    browser!.evaluate<boolean>(
      `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=visualViewport.height+1})()`,
    )
  const waitForFit = (selector: string, description: string) =>
    waitFor(async () => ((await fits(selector)) ? true : undefined), description, 5_000)
  for (const [width, height] of [
    [320, 640],
    [390, 664],
    [390, 360],
    [768, 1024],
    [820, 1180],
    [1024, 768],
    [1194, 834],
    [1366, 1024],
    [1440, 900],
  ]) {
    await resizeViewport(width, height)
    await Bun.sleep(350)
    const failures = await browser!.evaluate<string[]>(`(() => {
      const failures=[];
      const visible=e=>!!e&&e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none';
      const inView=(e,name)=>{
        if(!visible(e)){failures.push(name+' missing');return;}
        const r=e.getBoundingClientRect();
        if(r.left < -1 || r.right > innerWidth+1 || r.top < -1 || r.bottom > visualViewport.height+1)failures.push(name+' outside viewport '+[r.left,r.top,r.right,r.bottom].join(','));
      };
      inView(document.querySelector('[data-action="prompt-submit"]'),'send');
      inView(document.querySelector('[data-component="prompt-input"][contenteditable]'),'editor');
      if(document.documentElement.scrollWidth>innerWidth+1)failures.push('document overflow');
      const workspace=document.querySelector('[data-slot="session-main-panel"]')?.getBoundingClientRect();
      const dock=document.querySelector('[data-component="session-prompt-dock"]')?.getBoundingClientRect();
      if(!workspace||!dock||dock.top-workspace.top<100)failures.push('conversation has no reading space');
      if(innerWidth<1440){
        for(const [selector,name] of [['[data-action="prompt-mobile-attach"]','attach'],['[data-action="prompt-mobile-model"]','model'],['[data-action="prompt-mobile-options"]','options'],['[data-action="notification-bell"]','notifications']])inView(document.querySelector(selector),name);
        const title=document.querySelector('[data-action="compact-session-switch"]')?.getBoundingClientRect();
        const bell=document.querySelector('[data-action="notification-bell"]')?.getBoundingClientRect();
        if(innerWidth<1280&&(!title||!bell||title.right>bell.left+1))failures.push('title overlaps notification button');
        const toolbar=document.querySelector('[data-slot="prompt-toolbar"]');
        if(toolbar.scrollWidth>toolbar.clientWidth+1)failures.push('toolbar overflow');
        const send=document.querySelector('[data-action="prompt-submit"]').getBoundingClientRect();
        if(send.width<44||send.height<44)failures.push('send touch target too small');
      }
      return failures;
    })()`)
    console.log(`[remote-responsive] viewport=${width}x${height} failures=${failures.length}`)
    if (failures.length) throw new Error(failures.join("; "))
    if (width === 1024 || width === 1366) {
      await browser!.evaluate(
        `(() => {const b=document.querySelector('[data-action="session-review-toggle"]');if(b.getAttribute('aria-expanded')!=='true')b.click()})()`,
      )
      await waitFor(
        async () =>
          (await browser!.evaluate<boolean>(`(() => {
        const main=document.querySelector('[data-slot="session-main-panel"]').getBoundingClientRect();
        const panel=document.querySelector('#session-side-panel').getBoundingClientRect();
        const review=document.querySelector('[data-slot="session-wide-panel"]').getBoundingClientRect();
        return main.width>=320&&review.width>=280&&panel.right<=innerWidth+1&&main.right<=panel.left+1;
      })()`))
            ? true
            : undefined,
        "tablet review split view fits",
        10_000,
      )
      console.log("[remote-responsive] tablet review split view verified")
    }
    if (!skipScreenshots && ((width === 390 && height === 664) || width === 820 || width === 1024)) {
      const shot = await captureScreenshot()
      await writeFile(`/private/tmp/opencode-responsive-${width}.png`, Buffer.from(shot.data, "base64"))
    }
    if (width === 1024 || width === 1366)
      await browser!.evaluate(`document.querySelector('[data-action="session-review-toggle"]').click()`)
  }
  await resizeViewport(390, 664)
  await Bun.sleep(350)
  await browser!.evaluate(`document.querySelector('[data-action="prompt-mobile-options"]').click()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(`!!document.querySelector('.mobile-composer-options')`)) ? true : undefined,
    "mobile message options sheet",
  )
  await waitForFit(".mobile-composer-options", "message options sheet fits")
  await resizeViewport(390, 360)
  await Bun.sleep(250)
  await waitForFit(".mobile-composer-options", "message options sheet follows the reduced viewport")
  await resizeViewport(390, 664)
  await Bun.sleep(250)
  await browser!.evaluate(`document.querySelector('[data-slot="dialog-close-button"]').click()`)
  await browser!.evaluate(`document.querySelector('[data-action="prompt-mobile-model"]').click()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(`!!document.querySelector('[data-model-selector-popover-content]')`))
        ? true
        : undefined,
    "mobile model picker",
  )
  await waitForFit("[data-model-selector-popover-content]", "mobile model picker fits")
  await browser!.evaluate(`document.querySelector('[data-action="prompt-mobile-model"]').click()`)
  await browser!.evaluate(
    `document.querySelector('[data-slot="session-mobile-tabs"] [data-value="changes"] button').click()`,
  )
  await Bun.sleep(250)
  if (
    !(await browser!.evaluate<boolean>(
      `getComputedStyle(document.querySelector('[data-component="session-prompt-dock"]')).display==='none'`,
    ))
  )
    throw new Error("Mobile changes view retained its composer")
  await browser!.evaluate(
    `document.querySelector('[data-slot="session-mobile-tabs"] [data-value="session"] button').click()`,
  )
  await browser!.evaluate(`document.querySelector('[data-action="notification-bell"]').click()`)
  await Bun.sleep(250)
  await waitForFit('[data-component="notification-bell-popover"]', "mobile notifications fit below the header")
  await browser!.evaluate(`document.querySelector('[data-action="notification-bell"]').click()`)
  await browser!.evaluate(`document.querySelector('[data-component="titlebar"] button[aria-expanded]').click()`)
  await waitForFit('[data-component="sidebar-nav-mobile"]', "mobile projects drawer fits")
  await browser!.evaluate(`document.querySelector('[data-component="titlebar"] button[aria-expanded]').click()`)
  console.log("[remote-responsive] message options, model picker, changes navigation and notifications verified")
}

try {
  const existingTargets = new Set((await listTargets()).map((target) => target.id))
  await desktop.evaluate(`window.api.browser.open(${JSON.stringify(pageId)}, ${JSON.stringify(invite.url)})`)
  const target = await waitFor(async () => {
    const targets = await listTargets()
    return targets.find((item) => !existingTargets.has(item.id) && item.type === "page" && item.url.startsWith(origin))
  }, "isolated remote browser page")
  browser = await CdpClient.connect(target.webSocketDebuggerUrl)
  await browser.call("Page.enable")
  await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  if (locale) {
    await browser.call("Network.setUserAgentOverride", {
      userAgent: await browser.evaluate<string>("navigator.userAgent"),
      acceptLanguage: locale,
    })
  }
  await browser.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  await browser.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await browser.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__remoteQaErrors=[];
      window.__remoteQaRequests=[];
      window.__remoteQaLogs=[];
      if (${JSON.stringify(skipScreenshots)}) {
        window.__remoteQaMedia=[];
        const nativeMatchMedia=window.matchMedia.bind(window);
        window.matchMedia=(...args)=>{const query=nativeMatchMedia(...args);window.__remoteQaMedia.push(query);return query};
      }
      if (${JSON.stringify(skipScreenshots)}) addEventListener('DOMContentLoaded',()=>{
        const style=document.createElement('style');
        style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.append(style);
      });
      addEventListener('error',e=>window.__remoteQaErrors.push(String(e.message)));
      addEventListener('unhandledrejection',e=>window.__remoteQaErrors.push(String(e.reason)));
      const originalInfo=console.info;
      console.info=(...args)=>{
        if(typeof args[0]==='string'&&args[0].startsWith('[remote-readiness]'))window.__remoteQaLogs.push(args[0]);
        originalInfo(...args);
      };
      const originalFetch=window.fetch;
      window.fetch=async(...args)=>{
        const r=await originalFetch(...args);
        const u=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);
        window.__remoteQaRequests.push({path:u.pathname,status:r.status});
        return r;
      };
    `,
  })
  await waitFor(
    async () => ((await browser!.evaluate<boolean>(`!!document.querySelector('#connect')`)) ? true : undefined),
    "pairing page",
  )
  const paired = await browser.evaluate<boolean>(`fetch('/remote/api/session').then(r=>r.ok).catch(()=>false)`)
  if (paired) await browser.call("Page.navigate", { url: `${origin}/` })
  else
    await browser.evaluate(
      `document.querySelector('#name').value='CDP mobile browser';document.querySelector('#connect').click()`,
    )
  await waitFor(async () => {
    const href = await browser!.evaluate<string>("location.href")
    return href === `${origin}/` ? true : undefined
  }, "redeem and navigate")
  const authenticated = await browser.evaluate<boolean>(
    `fetch('/remote/api/session').then(r=>r.json()).then(v=>v.authenticated===true)`,
  )
  if (!authenticated) throw new Error("Browser did not retain its HttpOnly session cookie")
  await waitFor(async () => {
    const text = await browser!.evaluate<string>("document.body.innerText")
    return text.length > 100 && !text.includes("Remote session expired") ? text : undefined
  }, "remote web shell")
  await Bun.sleep(2_000)
  const state = await browser.evaluate<{
    text: string
    errors: string[]
    failed: Array<{ path: string; status: number }>
  }>(
    `({text:document.body.innerText.slice(0,1800),errors:window.__remoteQaErrors??[],failed:(window.__remoteQaRequests??[]).filter(x=>x.status>=400)})`,
  )
  console.log(
    `[remote-cdp] mobile viewport authenticated=true errors=${state.errors.length} failedRequests=${state.failed.length}`,
  )
  console.log(JSON.stringify(state))
  if (!skipScreenshots) {
    const screenshot = await captureScreenshot()
    await writeFile("/private/tmp/opencode-remote-mobile-qa.png", Buffer.from(screenshot.data, "base64"))
  }
  // Match the real Home links: macOS tmpdir can be a /var alias while the
  // sidecar reports /private/var as the session's canonical directory.
  const info = await browser.evaluate<{ directory?: string }>(
    `fetch(${JSON.stringify(`/session/${invite.sessionId}?directory=${encodeURIComponent(invite.directory)}`)}).then(r=>r.json())`,
  )
  const directory = Buffer.from(info.directory ?? invite.directory).toString("base64url")
  await browser.call("Page.navigate", { url: `${origin}/${directory}/session/${invite.sessionId}` })
  let historyVisible = true
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(`document.body.innerText.includes('REMOTE_ACCESS_SIDECAR_OK')`))
        ? true
        : undefined,
    "remote session history",
  ).catch(() => {
    historyVisible = false
  })
  await Bun.sleep(2_000)
  const sessionState = await browser.evaluate<{
    text: string
    errors: string[]
    failed: Array<{ path: string; status: number }>
  }>(
    `({text:document.body.innerText.slice(0,2200),errors:window.__remoteQaErrors??[],failed:(window.__remoteQaRequests??[]).filter(x=>x.status>=400),readiness:window.__remoteQaLogs??[]})`,
  )
  console.log(
    `[remote-cdp] session history rendered errors=${sessionState.errors.length} failedRequests=${sessionState.failed.length}`,
  )
  console.log(JSON.stringify(sessionState))
  if (!skipScreenshots) {
    const sessionShot = await captureScreenshot()
    await writeFile("/private/tmp/opencode-remote-session-qa.png", Buffer.from(sessionShot.data, "base64"))
  }
  if (!historyVisible) throw new Error("Remote session history did not render; see diagnostic state and screenshot")
  if (responsive) await checkResponsiveLayouts()
  const historyPath = `/session/${invite.sessionId}/message?directory=${encodeURIComponent(info.directory ?? invite.directory)}`
  const previousReplies = await browser.evaluate<number>(
    `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.filter(m=>m.info?.role==='assistant'&&m.parts?.some(p=>p.text?.includes('REMOTE_ACCESS_SIDECAR_OK'))).length)`,
  )
  const previousToolCompletions = permissionTest
    ? await browser.evaluate<number>(
        `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.flatMap(m=>m.parts??[]).filter(p=>p.type==='tool'&&p.state?.status==='completed'&&p.state.output?.includes('REMOTE_PERMISSION_TOOL_OK')).length)`,
      )
    : 0
  const expanded = await browser.evaluate<boolean>(`(() => {
    const expand=document.querySelector('[data-action="prompt-expand"]');
    if(expand){expand.click();return true;}
    const editor=document.querySelector('[data-component="prompt-input"][contenteditable="true"]');
    if(!editor)throw new Error('Mobile prompt editor missing');
    editor.focus();
    return false;
  })()`)
  if (expanded) {
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(`!!document.querySelector('[role="dialog"] textarea')`)) ? true : undefined,
      "expanded mobile prompt editor",
    )
    await browser.evaluate(`document.querySelector('[role="dialog"] textarea').focus()`)
  }
  await browser.call("Input.insertText", {
    text: permissionTest
      ? "Run only the harmless printf test, then reply REMOTE_ACCESS_SIDECAR_OK."
      : `Reply with exactly REMOTE_ACCESS_SIDECAR_OK. Mobile CDP send ${Date.now()}. Do not use tools.`,
  })
  if (expanded)
    await browser.evaluate(`(() => {
    const save=[...document.querySelectorAll('[role="dialog"] button')].find(e=>['Save','保存'].includes(e.textContent.trim()));
    if(!save)throw new Error('Prompt editor Save button missing');
    save.click();
  })()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(`!!document.querySelector('[data-action="prompt-submit"]:not([disabled])')`))
        ? true
        : undefined,
    "enabled message submit",
  )
  await browser.evaluate(`document.querySelector('[data-action="prompt-submit"]').click()`)
  if (permissionTest) {
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(
          `!!document.querySelector('[data-component="dock-prompt"][data-kind="permission"]')`,
        ))
          ? true
          : undefined,
      "isolated permission approval dock",
    )
    await browser.evaluate(`(() => {
      const dock=document.querySelector('[data-component="dock-prompt"][data-kind="permission"]');
      if(!dock?.textContent.includes('printf'))throw new Error('Unexpected permission; do not approve');
      const button=[...dock.querySelectorAll('button')].find(e=>['Allow once','Allow Once','允许一次'].includes(e.textContent.trim()));
      if(!button)throw new Error('Allow once button missing');
      button.click();
    })()`)
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(
          `(window.__remoteQaRequests??[]).some(r=>r.path.startsWith(${JSON.stringify(`/session/${invite.sessionId}/permissions/`)})&&r.status===200)`,
        ))
          ? true
          : undefined,
      "actual frontend permission POST succeeds",
    )
    console.log("[remote-cdp] Allow once clicked; actual session-scoped permission route returned 200")
  }
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.filter(m=>m.info?.role==='assistant'&&m.parts?.some(p=>p.text?.includes('REMOTE_ACCESS_SIDECAR_OK'))).length>${previousReplies})`,
      ))
        ? true
        : undefined,
    "persisted mobile composer reply",
  )
  console.log(
    `[remote-cdp] editor=${expanded ? "expanded" : "inline"} typed and submitted; new persisted assistant reply verified`,
  )
  if (permissionTest) {
    const completed = await browser.evaluate<boolean>(
      `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.flatMap(m=>m.parts??[]).filter(p=>p.type==='tool'&&p.state?.status==='completed'&&p.state.output?.includes('REMOTE_PERMISSION_TOOL_OK')).length>${previousToolCompletions})`,
    )
    if (!completed) throw new Error("Permission approval did not complete the new isolated printf tool")
    console.log("[remote-cdp] approved printf output persisted and verified")
  }
  const afterSend = await browser.evaluate<{ errors: string[]; failed: Array<{ path: string; status: number }> }>(
    `({errors:window.__remoteQaErrors??[],failed:(window.__remoteQaRequests??[]).filter(x=>x.status>=400)})`,
  )
  if (afterSend.errors.length || afterSend.failed.length)
    throw new Error(`Mobile send produced errors: ${JSON.stringify(afterSend)}`)
  if (state.errors.length || sessionState.errors.length) throw new Error("Remote web UI raised browser errors")
  if (state.failed.length || sessionState.failed.length)
    throw new Error("Remote web UI issued rejected bootstrap requests")
  console.log(
    skipScreenshots
      ? "[remote-cdp] PASS layout and interaction checks; screenshots skipped"
      : "[remote-cdp] PASS screenshot=/private/tmp/opencode-remote-mobile-qa.png",
  )
} finally {
  browser?.close()
  if (keepPage) console.log(`[remote-cdp] retained diagnostic page=${pageId}`)
  else await desktop.evaluate(`window.api.browser.close(${JSON.stringify(pageId)})`).catch(() => {})
  desktop.close()
}
