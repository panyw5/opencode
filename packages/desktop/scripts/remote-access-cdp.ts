#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { RemoteDevice, RemotePage } from "@opencode-ai/app/remote/types"
import { CdpClient, connectCdp, listTargets } from "./cdp"

const path = process.argv[2]
if (!path) throw new Error("Usage: bun packages/desktop/scripts/remote-access-cdp.ts <browser-invite.json>")
const invite = JSON.parse(await readFile(path, "utf8")) as {
  url: string
  directory: string
  sessionId: string
  permission?: boolean
  presence?: boolean
}
const origin = new URL(invite.url).origin
const pageId = `remote-access-qa-${Date.now()}`
const keepPage = process.argv.includes("--keep")
const responsive = process.argv.includes("--responsive")
const skipScreenshots = process.argv.includes("--no-screenshots")
const permissionTest = invite.permission || process.argv.includes("--permission")
const taskCardsTest = process.argv.includes("--task-cards")
const sidebarActionsTest = process.argv.includes("--sidebar-actions") || taskCardsTest
const modelOnlyTest = process.argv.includes("--model-only")
const toolbarSizingTest = process.argv.includes("--toolbar-sizing")
const generalOnlyTest = process.argv.includes("--general-only")
const fontsTest = process.argv.includes("--fonts")
const presenceTest = invite.presence || process.argv.includes("--presence")
const locale = process.argv.find((arg) => arg.startsWith("--locale="))?.slice("--locale=".length)
const { client: desktop } = await connectCdp()
let browser: CdpClient | undefined
let presenceDeviceID: string | undefined

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

async function checkSidebarSessionActions() {
  await browser!.evaluate(`document.querySelector('[data-component="titlebar"] button[aria-expanded]').click()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `!!document.querySelector('[data-component="sidebar-nav-mobile"] [data-component="sidebar-session"] [data-slot="session-trailing"]')`,
      ))
        ? true
        : undefined,
    "real sidebar session row",
  )
  for (const width of [320, 390, 767, 768, 1024]) {
    await resizeViewport(width, 844)
    await Bun.sleep(200)
    const railActions = await browser!.evaluate<{
      config: number
      settings: number
      help: number
      emptyIm: number
    }>(`(() => {
      const rail=document.querySelector('[data-component="sidebar-nav-mobile"] [data-component="sidebar-rail"]');
      return {config:rail.querySelectorAll('[data-action="config-open"]').length,settings:rail.querySelectorAll('[data-icon="settings-gear"]').length,help:rail.querySelectorAll('[data-icon="help"]').length,emptyIm:rail.querySelectorAll('[data-icon="speech-bubble"]').length};
    })()`)
    if (railActions.config !== 0 || railActions.settings !== 1 || railActions.help !== 1 || railActions.emptyIm !== 0)
      throw new Error(`Remote rail actions mismatch at ${width}: ${JSON.stringify(railActions)}`)
    console.log(`[remote-rail-qa] width=${width} actions=${JSON.stringify(railActions)}`)
    const result = await browser!.evaluate<{ hidden: boolean; visibleButtons: number; titleGain: number }>(`(() => {
      const row=document.querySelector('[data-component="sidebar-nav-mobile"] [data-component="sidebar-session"]');
      const trailing=row.querySelector('[data-slot="session-trailing"]');
      const title=row.querySelector('[data-slot="session-title"]');
      const hidden=getComputedStyle(trailing).display==='none';
      const visibleButtons=[...trailing.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).length;
      let titleGain=0;
      if(innerWidth===390){
        const before=title.getBoundingClientRect().width;
        const previous=trailing.getAttribute('style');
        trailing.style.setProperty('display','block','important');
        titleGain=before-title.getBoundingClientRect().width;
        if(previous===null)trailing.removeAttribute('style');else trailing.setAttribute('style',previous);
      }
      return {hidden,visibleButtons,titleGain};
    })()`)
    if (result.hidden !== width < 768 || result.visibleButtons !== (width < 768 ? 0 : 4))
      throw new Error(`Sidebar action visibility mismatch at ${width}: ${JSON.stringify(result)}`)
    if (width === 390 && result.titleGain < 100)
      throw new Error(`Phone title did not reclaim action space: ${result.titleGain}`)
    console.log(
      `[sidebar-actions-qa] width=${width} hidden=${result.hidden} visibleButtons=${result.visibleButtons} titleGain=${result.titleGain}`,
    )
    const rail = await browser!.evaluate<{
      width: number
      projectSize: number
      avatarSize: number
      panelGain: number
      fits: boolean
    }>(`(() => {
      const nav=document.querySelector('[data-component="sidebar-nav-mobile"]');
      const rail=nav.querySelector('[data-component="sidebar-rail"]');
      const project=rail.querySelector('[data-action="project-switch"]');
      const avatar=project.querySelector('[data-slot="project-icon"]');
      const panel=nav.querySelector('[data-slot="sidebar-panel"]');
      const rect=rail.getBoundingClientRect();
      const buttons=[...rail.querySelectorAll('button')];
      const fits=buttons.every(e=>{const r=e.getBoundingClientRect();return r.left>=rect.left&&r.right<=rect.right})&&rail.scrollWidth<=rail.clientWidth;
      let panelGain=0;
      if(innerWidth===390){
        const before=panel.getBoundingClientRect().width;
        const previous=rail.getAttribute('style');
        rail.style.width='64px';
        panelGain=before-panel.getBoundingClientRect().width;
        if(previous===null)rail.removeAttribute('style');else rail.setAttribute('style',previous);
      }
      return {width:rect.width,projectSize:parseFloat(getComputedStyle(project).width),avatarSize:parseFloat(getComputedStyle(avatar).width),panelGain,fits};
    })()`)
    if (
      rail.width !== (width < 768 ? 48 : 64) ||
      rail.projectSize !== (width < 768 ? 36 : 40) ||
      rail.avatarSize !== (width < 768 ? 28 : 32) ||
      !rail.fits ||
      (width === 390 && rail.panelGain !== 16)
    )
      throw new Error(`Sidebar rail sizing mismatch at ${width}: ${JSON.stringify(rail)}`)
    console.log(`[sidebar-rail-qa] viewport=${width} sizes=${JSON.stringify(rail)}`)
    await checkListSpacing("sidebar-session", width)
  }
  await resizeViewport(390, 664)
  for (const [icon, name] of [
    ["checklist", "project-tasks"],
    ["clock", "scheduled-tasks"],
  ]) {
    await browser!.evaluate(
      `document.querySelector('[data-component="sidebar-nav-mobile"] .sidebar-actions [data-icon="${icon}"]').click()`,
    )
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(
          `!!document.querySelector('[data-component="sidebar-nav-mobile"] [data-panel="${name}"]')`,
        ))
          ? true
          : undefined,
      `${name} panel opens`,
    )
    const fits = await browser!.evaluate<boolean>(`(() => {
      const nav=document.querySelector('[data-component="sidebar-nav-mobile"]');
      const slot=nav.querySelector('[data-slot="sidebar-panel"]').getBoundingClientRect();
      const panel=nav.querySelector('[data-panel="${name}"]').getBoundingClientRect();
      return Math.abs(panel.width-slot.width)<1&&Math.abs(panel.left-slot.left)<1;
    })()`)
    if (!fits) throw new Error(`${name} panel did not fill reclaimed rail space`)
    console.log(`[sidebar-rail-qa] panel=${name} fillsAvailableWidth=true`)
    if (presenceTest) await checkPresencePage(name === "project-tasks" ? "project-tasks" : "scheduled-tasks")
    if (taskCardsTest) await checkTaskCardIcons(name === "project-tasks" ? "project-task-item" : "scheduled-task-card")
    await browser!.evaluate(
      `document.querySelector('[data-component="sidebar-nav-mobile"] [data-panel="${name}"] [data-icon="arrow-left"]').click()`,
    )
  }
  await browser!.evaluate(`document.querySelector('[data-component="titlebar"] button[aria-expanded]').click()`)
}

async function presenceDevices(): Promise<RemoteDevice[]> {
  return JSON.parse(await readFile(join(dirname(path), "browser-devices.json"), "utf8"))
}

async function checkPresencePage(kind: RemotePage["kind"]) {
  await waitFor(
    async () => {
      const device = (await presenceDevices()).find((d) => d.id === presenceDeviceID)
      return device?.connection?.pages.some(
        (p) => p.kind === kind && (kind !== "session" || p.sessionID === invite.sessionId),
      )
        ? true
        : undefined
    },
    `authenticated browser presence reports ${kind}`,
    20_000,
  )
  console.log(`[remote-presence-qa] browser page=${kind} heartbeat verified`)
}

async function checkRemoteGeneralDialog() {
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `!!document.querySelector('[data-component="remote-settings"] [data-settings-general]')`,
      ))
        ? true
        : undefined,
    "single-page remote General settings",
  )
  for (const [width, height] of [
    [320, 640],
    [390, 664],
    [390, 360],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ]) {
    await resizeViewport(width, height)
    await Bun.sleep(200)
    const result = await browser!.evaluate<{
      fullWidth: boolean
      navigation: number
      heading: boolean
      fits: boolean
      scrolls: boolean
      sizes: number[]
    }>(`(() => {
      const root=document.querySelector('[data-component="remote-settings"]');
      const dialog=root.closest('[data-slot="dialog-content"]');
      const body=dialog.querySelector('[data-slot="dialog-body"]');
      const general=root.querySelector('[data-settings-general]');
      const logout=root.querySelector('[data-action="remote-settings-logout"]');
      const r=general.getBoundingClientRect(),b=body.getBoundingClientRect(),d=dialog.getBoundingClientRect(),l=logout.getBoundingClientRect();
      const previous=general.scrollTop;general.scrollTop=general.scrollHeight;const scrolls=general.scrollTop>0;general.scrollTop=previous;
      return {fullWidth:Math.abs(r.width-b.width)<1&&Math.abs(r.left-b.left)<1,navigation:dialog.querySelectorAll('[data-component="tabs"][data-variant="settings"],[data-slot="tabs-list"]').length,heading:!!dialog.querySelector('[data-slot="dialog-title"]')&&!general.querySelector('h2'),fits:d.left>=-1&&d.right<=innerWidth+1&&d.top>=-1&&d.bottom<=visualViewport.height+1&&l.bottom<=d.bottom&&l.top>=d.top&&general.scrollWidth<=general.clientWidth,scrolls,sizes:[r.height,b.height,d.height,general.clientHeight,general.scrollHeight]};
    })()`)
    if (!result.fullWidth || result.navigation || !result.heading || !result.fits || !result.scrolls)
      throw new Error(`Remote General dialog layout mismatch at ${width}x${height}: ${JSON.stringify(result)}`)
    console.log(`[remote-general-qa] viewport=${width}x${height} result=${JSON.stringify(result)}`)
  }
  await resizeViewport(390, 664)
  const toggled = await browser!.evaluate<boolean>(`(() => {
    const input=document.querySelector('[data-component="remote-settings"] [data-action="settings-feed-reasoning-summaries"] input[type="checkbox"]');
    if(!input)return false;const before=input.checked;input.click();const changed=input.checked!==before;input.click();return changed&&input.checked===before;
  })()`)
  if (!toggled) throw new Error("General preferences no longer toggle or restore correctly")
  console.log("[remote-general-qa] local preference toggled and restored; logout retained")
}

async function checkRemoteFonts() {
  await resizeViewport(1440, 900)
  const original = await browser!.evaluate<string>(
    `document.querySelector('[data-action="settings-font"] [data-slot="select-select-trigger-value"]').textContent.trim()`,
  )
  const trigger = `document.querySelector('[data-action="settings-font"] [data-slot="select-select-trigger"]')`
  const openPicker = () =>
    browser!.evaluate(`(() => {
    const trigger=${trigger};trigger.scrollIntoView({block:'center'});trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
  })()`)
  await openPicker()
  await waitFor(async () => {
    const count = await browser!.evaluate<number>(
      `document.querySelectorAll('[data-slot="select-select-item"]').length`,
    )
    return count === 13 ? count : undefined
  }, "all thirteen remote font options")
  const options = await browser!.evaluate<Array<{ label: string; family: string }>>(`
    [...document.querySelectorAll('[data-slot="select-select-item"]')].map(item=>{
      const label=item.querySelector('[data-slot="select-select-item-label"]');
      const span=label.querySelector('span');
      return {label:label.textContent.trim(),family:getComputedStyle(span??label).fontFamily.split(',')[0].trim().replaceAll('"','')};
    })
  `)
  for (const [index, option] of options.entries()) {
    if (index) await openPicker()
    await waitFor(
      async () =>
        (await browser!.evaluate<number>(`document.querySelectorAll('[data-slot="select-select-item"]').length`)) === 13
          ? true
          : undefined,
      "font picker options",
    )
    await browser!.evaluate(`(() => {
      const option=[...document.querySelectorAll('[data-slot="select-select-item"]')].find(e=>e.querySelector('[data-slot="select-select-item-label"]').textContent.trim()===${JSON.stringify(option.label)});
      option.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',button:0}));
      option.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse',button:0}));
      option.click();
    })()`)
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(
          `document.querySelector('[data-action="settings-font"] [data-slot="select-select-trigger-value"]').textContent.trim()===${JSON.stringify(option.label)} && document.documentElement.style.getPropertyValue('--font-family-mono').startsWith(${JSON.stringify(`"${option.family}"`)})`,
        ))
          ? true
          : undefined,
      `selected font ${option.label}`,
    )
    await waitFor(async () => {
      const loaded = await browser!.evaluate<boolean>(`(async()=>{
        const family=${JSON.stringify(option.family)};
        const faces=await document.fonts.load('16px "'+family+'"','ABC 0123 -> !=');
        const bold=await document.fonts.load('700 16px "'+family+'"','ABC 0123');
        const icons=await document.fonts.load('16px "IBM Plex Mono"',String.fromCodePoint(0xf120));
        return faces.length>0&&bold.length>0&&icons.length>0&&[...faces,...bold,...icons].every(f=>f.status==='loaded');
      })()`)
      return loaded ? true : undefined
    }, `regular, bold and shared icon font ${option.family}`)
    console.log(`[remote-fonts-cdp] font=${option.family} regular=true bold=true sharedIcons=true`)
  }
  await browser!.call("Page.reload")
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `!!document.getElementById('oc-font-geist-mono') && document.documentElement.style.getPropertyValue('--font-family-mono').startsWith('"GeistMono Nerd Font"')`,
      ))
        ? true
        : undefined,
    "saved non-default font restored after reload",
  )
  console.log("[remote-fonts-cdp] saved non-default font restored after page reload")
  await resizeViewport(390, 664)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `!!document.querySelector('[data-component="sidebar-nav-mobile"] [data-icon="settings-gear"]')`,
      ))
        ? true
        : undefined,
    "mobile settings entry ready after reload",
  )
  await browser!.evaluate(
    `document.querySelector('[data-component="sidebar-nav-mobile"] [data-icon="settings-gear"]').click()`,
  )
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(`!!document.querySelector('[data-action="settings-font"]')`))
        ? true
        : undefined,
    "font settings reopened after reload",
  )
  await openPicker()
  await waitFor(
    async () =>
      (await browser!.evaluate<number>(`document.querySelectorAll('[data-slot="select-select-item"]').length`)) === 13
        ? true
        : undefined,
    "restore font picker",
  )
  await browser!.evaluate(`(() => {
    const option=[...document.querySelectorAll('[data-slot="select-select-item"]')].find(e=>e.querySelector('[data-slot="select-select-item-label"]').textContent.trim()===${JSON.stringify(original)});
    option.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',button:0}));
    option.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse',button:0}));option.click();
  })()`)
  console.log("[remote-fonts-cdp] all 13 font options verified; original selection restored")
}

async function checkTaskCardIcons(component: string) {
  const selector = `[data-component="sidebar-nav-mobile"] [data-component="${component}"]`
  try {
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) ? true : undefined,
      `${component} fixture rendered`,
    )
  } catch (error) {
    console.log(
      `[task-card-qa] missing component=${component} diagnostics=${await browser!.evaluate<string>(`JSON.stringify({text:document.querySelector('[data-component="sidebar-nav-mobile"]')?.innerText,logs:window.__remoteQaLogs,errors:window.__remoteQaErrors})`)}`,
    )
    throw error
  }
  for (const width of [320, 390, 767, 768, 1024]) {
    await resizeViewport(width, 844)
    await Bun.sleep(200)
    const result = await browser!.evaluate<{ hidden: boolean; gain: number; fits: boolean }>(`(() => {
      const card=document.querySelector(${JSON.stringify(selector)});
      const icon=card.querySelector('[data-slot="task-card-icon"]');
      const content=card.querySelector('[data-slot="task-card-content"]');
      const hidden=getComputedStyle(icon).display==='none';
      const rect=content.getBoundingClientRect();
      const previous=icon.getAttribute('style');
      icon.style.display=hidden?'flex':'none';
      const gain=Math.abs(rect.width-content.getBoundingClientRect().width);
      if(previous===null)icon.removeAttribute('style');else icon.setAttribute('style',previous);
      return {hidden,gain,fits:card.scrollWidth<=card.clientWidth&&rect.left>=card.getBoundingClientRect().left&&rect.right<=card.getBoundingClientRect().right};
    })()`)
    if (result.hidden !== width < 768 || result.gain < 20 || !result.fits)
      throw new Error(`Task card layout mismatch component=${component} width=${width}: ${JSON.stringify(result)}`)
    console.log(`[task-card-qa] component=${component} width=${width} result=${JSON.stringify(result)}`)
    await checkListSpacing(component, width)
  }
  await resizeViewport(390, 664)
}

async function checkListSpacing(component: string, width: number) {
  const result = await browser!.evaluate<{ left: number; right: number; padding: number[]; fits: boolean }>(`(() => {
    const item=document.querySelector('[data-component="sidebar-nav-mobile"] [data-component="${component}"]');
    const panel=item.closest('[data-component="sidebar-panel"]');
    const r=item.getBoundingClientRect(),p=panel.getBoundingClientRect();
    const style=getComputedStyle(panel),itemStyle=getComputedStyle(item);
    return {left:r.left-p.left-parseFloat(style.borderLeftWidth),right:p.right-r.right-parseFloat(style.borderRightWidth),padding:[parseFloat(itemStyle.paddingLeft),parseFloat(itemStyle.paddingRight)],fits:item.scrollWidth<=item.clientWidth};
  })()`)
  const expected = width < 768 ? 6 : component === "sidebar-session" ? 24 : 16
  if (Math.abs(result.left - expected) > 0.5 || Math.abs(result.right - expected) > 0.5 || !result.fits)
    throw new Error(`List spacing mismatch component=${component} width=${width}: ${JSON.stringify(result)}`)
  if (
    component === "sidebar-session" &&
    result.padding.some((value, i) => value !== (width < 768 ? [10, 8] : [16, 12])[i])
  )
    throw new Error(`Session content spacing mismatch at ${width}: ${JSON.stringify(result)}`)
  console.log(`[list-spacing-qa] component=${component} width=${width} result=${JSON.stringify(result)}`)
}

async function checkModelOnlyTrigger() {
  const singleLine = await browser!.evaluate<boolean>(`(() => {
    const trigger=document.querySelector('[data-action="prompt-mobile-model"]');
    const name=trigger?.querySelector('[data-slot="prompt-mobile-model-name"]');
    return !!name&&!!name.textContent.trim()&&trigger.innerText.trim()===name.textContent.trim()&&name.getBoundingClientRect().height<=24;
  })()`)
  if (!singleLine) throw new Error("Compact model trigger contains extra text or wraps")
  await browser!.evaluate(`document.querySelector('[data-action="prompt-mobile-options"]').click()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `document.querySelectorAll('.mobile-composer-options [data-slot="select-select-trigger"]').length>=2`,
      ))
        ? true
        : undefined,
    "agent and thinking variant remain in settings",
  )
  const settingsPopulated = await browser!.evaluate<boolean>(
    `[...document.querySelectorAll('.mobile-composer-options [data-slot="select-select-trigger"]')].every(e=>e.innerText.trim().length>0)`,
  )
  if (!settingsPopulated) throw new Error("Agent or variant settings lost its selected value")
  await browser!.evaluate(`document.querySelector('[data-slot="dialog-close-button"]').click()`)
  await browser!.evaluate(`document.querySelector('[data-action="prompt-mobile-model"]').click()`)
  await waitFor(
    async () =>
      (await browser!.evaluate<boolean>(
        `document.querySelectorAll('[data-model-selector-popover-content] [data-slot="list-item"]').length>0`,
      ))
        ? true
        : undefined,
    "model picker still has models",
  )
  await browser!.evaluate(
    `document.querySelector('[data-model-selector-popover-content] [data-slot="list-item"]').click()`,
  )
  console.log("[model-only-qa] single model label, agent/variant settings and model selection verified")
}

async function checkToolbarSizing() {
  for (const width of [320, 390, 767, 768, 1024]) {
    await resizeViewport(width, 664)
    await Bun.sleep(200)
    const result = await browser!.evaluate<{
      heights: number[]
      centers: number[]
      icons: number[]
      secondary: number[]
    }>(`(() => {
      const selectors=['prompt-mobile-attach','prompt-mobile-model','prompt-mobile-options','prompt-submit'];
      const controls=selectors.map(action=>document.querySelector('[data-action="'+action+'"]'));
      const rects=controls.map(e=>e.getBoundingClientRect());
      const icons=controls.filter(e=>e.matches('[data-component="icon-button"]')).map(e=>e.querySelector('[data-component="icon"]').getBoundingClientRect().height);
      const secondary=[...document.querySelectorAll('[data-slot="prompt-toolbar"] [data-component="icon-button"]')].map(e=>parseFloat(getComputedStyle(e).height));
      return {heights:rects.map(r=>r.height),centers:rects.map(r=>r.top+r.height/2),icons,secondary};
    })()`)
    const expected = width < 768 ? 32 : 44
    if (
      result.heights.some((height) => Math.abs(height - expected) > 0.5) ||
      Math.max(...result.centers) - Math.min(...result.centers) > 0.5
    )
      throw new Error(`Toolbar height/alignment mismatch at ${width}: ${JSON.stringify(result)}`)
    if (
      width < 768 &&
      (result.icons.some((height) => Math.abs(height - 16) > 0.5) ||
        result.secondary.some((height) => Math.abs(height - 32) > 0.5))
    )
      throw new Error(`Phone icon/action sizes mismatch: ${JSON.stringify(result)}`)
    console.log(`[toolbar-sizing-qa] width=${width} controlHeight=${expected} aligned=true`)
  }
  await resizeViewport(390, 664)
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
        const expected=innerWidth<768?32:44;
        if(Math.abs(send.width-expected)>1||Math.abs(send.height-expected)>1)failures.push('send control size mismatch');
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
      const originalDebug=console.debug;
      console.debug=(...args)=>{
        if(typeof args[0]==='string'&&args[0].startsWith('[scheduled-panel]'))window.__remoteQaLogs.push(args[0]);
        originalDebug(...args);
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
  if (sidebarActionsTest) {
    await browser.evaluate(
      `(() => {const row=document.querySelector('.home-work-row[role="button"]');if(!row)throw new Error('Fixture Home session missing');row.click()})()`,
    )
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(`location.pathname.includes(${JSON.stringify(invite.sessionId)})`))
          ? true
          : undefined,
      "open fixture project through Home",
    )
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
  if (presenceTest) {
    presenceDeviceID = await browser.evaluate<string>(
      `fetch('/remote/api/session').then(r=>r.json()).then(s=>s.device.id)`,
    )
    await checkPresencePage("session")
  }
  if (sidebarActionsTest) await checkSidebarSessionActions()
  if (toolbarSizingTest) await checkToolbarSizing()
  if (modelOnlyTest) await checkModelOnlyTrigger()
  if (responsive) await checkResponsiveLayouts()
  const historyPath = `/session/${invite.sessionId}/message?directory=${encodeURIComponent(info.directory ?? invite.directory)}`
  const previousReplies = await browser.evaluate<number>(
    `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.filter(m=>m.info?.role==='assistant'&&m.info.time?.completed&&m.parts?.some(p=>p.text?.includes('REMOTE_ACCESS_SIDECAR_OK'))).length)`,
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
  if (toolbarSizingTest) {
    await waitFor(
      async () =>
        (await browser!.evaluate<boolean>(
          `document.querySelector('[data-action="prompt-submit"]')?.getAttribute('data-icon')==='stop'`,
        ))
          ? true
          : undefined,
      "streaming stop button",
    )
    const aligned = await browser.evaluate<boolean>(`(() => {
      const controls=['prompt-mobile-attach','prompt-mobile-model','prompt-mobile-options','prompt-submit'].map(action=>document.querySelector('[data-action="'+action+'"]'));
      const rects=controls.map(e=>e.getBoundingClientRect());const centers=rects.map(r=>r.top+r.height/2);
      return rects.every(r=>Math.abs(r.height-32)<0.5)&&Math.max(...centers)-Math.min(...centers)<0.5;
    })()`)
    if (!aligned) throw new Error("Streaming stop button does not match the phone toolbar")
    console.log("[toolbar-sizing-qa] streaming stop state controlHeight=32 aligned=true")
  }
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
        `fetch(${JSON.stringify(historyPath)}).then(r=>r.json()).then(v=>v.filter(m=>m.info?.role==='assistant'&&m.info.time?.completed&&m.parts?.some(p=>p.text?.includes('REMOTE_ACCESS_SIDECAR_OK'))).length>${previousReplies})`,
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
  if (presenceTest || generalOnlyTest || fontsTest) {
    await browser.evaluate(
      `document.querySelector('[data-component="sidebar-nav-mobile"] [data-icon="settings-gear"]').click()`,
    )
    if (presenceTest) await checkPresencePage("settings")
    if (generalOnlyTest) await checkRemoteGeneralDialog()
    if (fontsTest) await checkRemoteFonts()
    const hasCloseButton = await browser.evaluate<boolean>(
      `!!document.querySelector('[data-slot="dialog-close-button"]')`,
    )
    if (hasCloseButton) await browser.evaluate(`document.querySelector('[data-slot="dialog-close-button"]').click()`)
    else {
      await browser.call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      })
      await browser.call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      })
    }
    if (presenceTest) {
      await checkPresencePage("session")
      await browser.evaluate(`dispatchEvent(new PageTransitionEvent('pagehide'))`)
      await waitFor(
        async () => {
          const device = (await presenceDevices()).find((d) => d.id === presenceDeviceID)
          return device?.connection?.state === "offline" ? true : undefined
        },
        "pagehide clears authenticated page presence",
        10_000,
      )
      await browser.evaluate(`dispatchEvent(new PageTransitionEvent('pageshow'))`)
      await checkPresencePage("session")
      console.log("[remote-presence-qa] settings navigation, pagehide disconnect and pageshow reconnect verified")
    }
  }
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
