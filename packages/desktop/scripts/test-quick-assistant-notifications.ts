import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Sends a real sidecar prompt, then seeds historical bell notifications because
// new quick-assistant completion notifications are intentionally suppressed.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const panel = `document.querySelector('[data-component="quick-assistant-panel"]:not([hidden])')`
  const initial = await cdp.evaluate<{ open: boolean; id?: string }>(
    `({open: ${panel}?.dataset.state === 'open', id: ${panel}?.dataset.windowId})`,
  )
  const selectedTabs = `JSON.stringify([...document.querySelectorAll('[data-component="session-tab"]')]
    .map(el=>({session:el.dataset.sessionId,directory:el.dataset.directory,active:el.dataset.active})))`
  const originalTabs = await cdp.evaluate<string>(selectedTabs)
  const wait = async (expression: string, timeout = 20_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const click = async (selector: string) => {
    assert.equal(
      await cdp.evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click(); return true;
    })()`),
      true,
      `Missing control: ${selector}`,
    )
  }
  const saved = () =>
    cdp.evaluate<{ windows: { id: string; session?: string }[]; active: string }>(
      `(async()=>JSON.parse(await window.api.storeGet('opencode.global.dat','quick-assistant')))()`,
    )
  const reload = async () => {
    const origin = await cdp.evaluate<number>("performance.timeOrigin")
    await cdp.call("Page.reload")
    await wait(`performance.timeOrigin!==${origin} && !!document.querySelector('[data-action="notification-bell"]')`)
  }
  let session: string | undefined
  const windows = new Set<string>()
  try {
    if (!initial.open) await click('[data-component="quick-assistant-launcher"]')
    await wait(`${panel}?.dataset.state === 'open'`)
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-add-window"]')
    const id = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    windows.add(id)
    await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", {
      text: "Reply with exactly QUICK_NOTIFICATION_OK. Do not use tools. This is a notification routing test.",
    })
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-submit"]')
    await wait(
      `${panel}.querySelector('[data-role="assistant"]')?.textContent.includes('QUICK_NOTIFICATION_OK')`,
      120_000,
    )
    await wait(`${panel}.querySelector('[data-action="quick-assistant-submit"]')?.disabled === true`, 120_000)
    session = (await saved()).windows.find((item) => item.id === id)?.session
    assert.ok(session)
    console.log(`[quick-notification-test] real sidecar reply received session=${session}`)

    const config = await cdp.evaluate<string>(`(async()=>{
      const c=await window.api.awaitInitialization();
      const r=await fetch(c.url+'/path',{headers:{Authorization:'Basic '+btoa(c.username+':'+c.password)}});
      return (await r.json()).config;
    })()`)
    const directory = `${config}/quick-assistant`
    const href = `/${Buffer.from(directory).toString("base64url")}/session/${session}`
    const clickModule = `/@fs${resolve(import.meta.dir, "../../app/src/utils/notification-click.ts")}`
    const seed = async () => {
      await cdp.evaluate(`(async()=>{
        const key='notification';
        const value=JSON.parse(await window.api.storeGet('opencode.global.dat',key)) || {byDomain:{}};
        const list=value.byDomain.opencode || [];
        value.byDomain.opencode=[...list.filter(n=>n.session!==${JSON.stringify(session)}),
          {type:'turn-complete',time:Date.now(),viewed:false,directory:${JSON.stringify(directory)},session:${JSON.stringify(session)}}];
        await window.api.storeSet('opencode.global.dat',key,JSON.stringify(value));
      })()`)
      await reload()
    }
    const openFromBell = async () => {
      await click('[data-action="notification-bell"]')
      const selector = `[data-component="notification-bell-item"][data-session="${session}"]`
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
      await click(selector)
      await wait(
        `${panel}?.dataset.state === 'open' && ${panel}.querySelector('[data-role="assistant"]')?.textContent.includes('QUICK_NOTIFICATION_OK')`,
      )
      assert.equal(await cdp.evaluate(selectedTabs), originalTabs, "Project tabs must remain unchanged")
      await wait(`!document.querySelector('[data-component="notification-bell-item"][data-session="${session}"]')`)
    }

    if (initial.id) await click(`#quick-assistant-tab-${initial.id}`)
    await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-hide"]')
    await seed()
    await openFromBell()
    assert.equal(await cdp.evaluate(`${panel}.dataset.windowId`), id)
    console.log(
      "[quick-notification-test] bell click reopens the existing assistant tab, marks read, preserves project tabs",
    )

    // The system-notification callback uses this same entry point.
    const before = (await saved()).windows.length
    await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", { text: "DRAFT_PRESERVED" })
    await cdp.evaluate(`(async()=>{
      const {handleNotificationClick}=await import(${JSON.stringify(clickModule)});
      handleNotificationClick(${JSON.stringify(href)});
    })()`)
    assert.equal((await saved()).windows.length, before)
    assert.equal(
      await cdp.evaluate(`${panel}.querySelector('[contenteditable="true"]').textContent`),
      "DRAFT_PRESERVED",
    )
    console.log(
      "[quick-notification-test] repeated/system notification click preserves drafts and does not duplicate tabs",
    )

    await click(`#quick-assistant-tab-${id} ~ [data-action="quick-assistant-close-window"]`)
    await wait(`!document.getElementById('quick-assistant-window-${id}')`)
    await seed()
    await openFromBell()
    const restored = await cdp.evaluate<string>(`${panel}.dataset.windowId`)
    windows.add(restored)
    assert.notEqual(restored, id)
    assert.equal((await saved()).windows.filter((item) => item.session === session).length, 1)
    console.log("[quick-notification-test] closed assistant session restored with its messages in a new assistant tab")
    await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" }).then(async (shot) => {
      await Bun.write("/tmp/opencode-quick-notification.png", Buffer.from(shot.data, "base64"))
    })
  } finally {
    for (const id of windows) {
      if (!(await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${id}')`))) continue
      await click(`#quick-assistant-tab-${id} ~ [data-action="quick-assistant-close-window"]`)
      await wait(`!document.getElementById('quick-assistant-window-${id}')`)
    }
    if (initial.id && (await cdp.evaluate(`!!document.getElementById('quick-assistant-tab-${initial.id}')`)))
      await click(`#quick-assistant-tab-${initial.id}`)
    if (!initial.open && (await cdp.evaluate(`!!${panel}`)))
      await click('[data-component="quick-assistant-panel"]:not([hidden]) [data-action="quick-assistant-hide"]')
    if (session) {
      await cdp.evaluate(`(async()=>{
        const value=JSON.parse(await window.api.storeGet('opencode.global.dat','notification'));
        value.byDomain.opencode=(value.byDomain.opencode || []).filter(n=>n.session!==${JSON.stringify(session)});
        await window.api.storeSet('opencode.global.dat','notification',JSON.stringify(value));
        const c=await window.api.awaitInitialization();
        await fetch(c.url+'/session/'+${JSON.stringify(session)},{method:'DELETE',headers:{Authorization:'Basic '+btoa(c.username+':'+c.password)}});
      })()`)
      await reload()
    }
  }
})
