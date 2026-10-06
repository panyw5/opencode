import { strict as assert } from "node:assert"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withCdp } from "./cdp"
import type { BrowserDisplayState } from "@opencode-ai/app/browser/types"

const directory = await mkdtemp(join(tmpdir(), "opencode-right-panel-"))
await withCdp(async (cdp, target) => {
  assert.match(target.url, /localhost:5173/)
  const labels = ["审查", "文件预览", "浏览器"]
  const background = `agent-browser-right-panel-smoke-${Date.now()}`
  const created: string[] = []
  const state = () =>
    cdp.evaluate<Record<string, boolean>>(
      `Object.fromEntries(${JSON.stringify([...labels, "文件树"])}.map(label => [label, document.querySelector('button[aria-label="'+label+'"]')?.getAttribute('aria-expanded') === 'true']))`,
    )
  const display = () => cdp.evaluate<BrowserDisplayState>("window.api.browser.getDisplayState()")
  const wait = async (condition: () => Promise<boolean>, reason: string) => {
    const deadline = Date.now() + 8_000
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timeout: ${reason}`)
      await Bun.sleep(50)
    }
  }
  const click = async (selector: string) => {
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('missing '+${JSON.stringify(selector)});
      const r=e.getBoundingClientRect(); if(!r.width||!r.height) throw Error('hidden click target');
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.call("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 })
    console.log(`[right-panel-test] mouse click selector=${selector}`)
  }
  const select = async (label: string) => {
    if (!(await state())[label]) await click(`button[aria-label="${label}"]`)
    await wait(async () => (await state())[label], `select ${label}`)
    const selected = await state()
    assert.deepEqual(
      labels.filter((name) => selected[name]),
      [label],
      "exactly one wide panel selected",
    )
  }
  const dismissModal = async () => {
    if (!(await cdp.evaluate<boolean>("!!document.querySelector('[role=dialog]')"))) return
    assert.equal(
      await cdp.evaluate("!!document.elementFromPoint(30,200)?.closest('[data-component=dialog-overlay]')"),
      true,
    )
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await cdp.call("Input.dispatchMouseEvent", {
        type,
        x: 30,
        y: 200,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: 1,
      })
    await wait(
      async () => !(await cdp.evaluate<boolean>("!!document.querySelector('[role=dialog]')")),
      "modal dismissed by backdrop mouse click",
    )
  }
  const initial = await state()
  try {
    for (const label of [...labels, ...labels.toReversed(), ...labels]) await select(label)
    await click('button[aria-label="文件树"]')
    assert.equal((await state())["浏览器"], true, "file tree does not replace the browser")
    await click('button[aria-label="文件树"]')
    console.log("[right-panel-test] rapid mutual exclusion and independent file tree: PASS")

    await select("文件预览")
    await cdp.evaluate(`window.api.browser.open(${JSON.stringify(background)}, 'about:blank')`)
    created.push(background)
    await wait(
      async () => (await display()).views.some((view) => view.partition === background),
      "background view created",
    )
    assert.equal((await state())["文件预览"], true, "agent background update must not steal the dock")
    assert.ok(
      (await display()).views.every((view) => !view.visible),
      "background views stay hidden",
    )
    console.log("[right-panel-test] real background agent view does not reveal or intercept: PASS")

    await select("浏览器")
    await click('#browser-panel button[aria-label="新建标签页"]')
    let user = ""
    await wait(async () => {
      user = await cdp.evaluate<string>(
        "document.querySelector('[data-browser-placeholder]')?.getAttribute('data-browser-placeholder')",
      )
      return (
        !!user && user !== background && (await display()).views.some((view) => view.partition === user && view.visible)
      )
    }, "new user browser view shown")
    created.push(user)
    assert.equal((await display()).views.filter((view) => view.visible).length, 1)

    const slowServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(900)
        return new Response("<html><title>Right panel delayed navigation</title>delayed test page</html>", {
          headers: { "Content-Type": "text/html" },
        })
      },
    })
    try {
      await cdp.evaluate('window.api.storeGet("default.dat", "settings.v3").then(value => JSON.parse(value).keybinds)')
      await click("#browser-panel input")
      await cdp.call("Input.insertText", { text: `http://127.0.0.1:${slowServer.port}/slow` })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" })
      await click('#browser-panel button[aria-label="新建标签页"]')
      const second = await cdp.evaluate<string>(
        "document.querySelector('[data-browser-placeholder]').getAttribute('data-browser-placeholder')",
      )
      assert.notEqual(second, user)
      created.push(second)
      await wait(
        async () => (await display()).views.some((view) => view.partition === second && view.visible),
        "second browser tab displayed",
      )
      await wait(
        async () =>
          await cdp.evaluate<boolean>(
            `window.api.browser.getState().then(views=>views.some(view=>view.partition===${JSON.stringify(user)}&&!view.loading&&view.title==='Right panel delayed navigation'))`,
          ),
        "first navigation completed late",
      )
      const shown = (await display()).views.filter((view) => view.visible)
      assert.deepEqual(
        shown.map((view) => view.partition),
        [second],
        "late navigation must not cover the newer active tab",
      )
      user = second
      console.log("[right-panel-test] real delayed navigation cannot reshow an inactive native tab: PASS")
    } finally {
      slowServer.stop(true)
    }

    await click('button[aria-label="设置"]')
    await wait(
      async () => await cdp.evaluate<boolean>("!!document.querySelector('[role=dialog]')"),
      "settings modal opens",
    )
    await wait(async () => (await display()).views.every((view) => !view.visible), "modal blocks native browser")
    assert.ok(
      (await display()).views.every((view) => view.bounds.x < 0),
      "blocked views have no onscreen hit region",
    )
    console.log("[right-panel-test] real settings modal hides every native view: PASS")
    await dismissModal()
    await wait(
      async () => (await display()).views.some((view) => view.partition === user && view.visible),
      "closing modal restores current browser only",
    )

    const sessions = await cdp.evaluate<{ id: string; active: boolean }[]>(
      "[...document.querySelectorAll('[data-component=session-tab][data-session-id]')].map(e=>({id:e.dataset.sessionId,active:e.dataset.active==='true'}))",
    )
    const originalSession = sessions.find((session) => session.active)
    const otherSession = sessions.find((session) => !session.active)
    if (originalSession && otherSession) {
      try {
        await click(`[data-component="session-tab"][data-session-id="${otherSession.id}"]`)
        await wait(
          async () =>
            await cdp.evaluate<boolean>(
              `document.querySelector('[data-component=session-tab][data-active=true]')?.dataset.sessionId===${JSON.stringify(otherSession.id)}`,
            ),
          "other session activated",
        )
        await wait(
          async () => (await display()).views.some((view) => view.partition === user && view.visible),
          "browser selection survives session switch",
        )
        assert.equal((await display()).views.filter((view) => view.visible).length, 1)
      } finally {
        await click(`[data-component="session-tab"][data-session-id="${originalSession.id}"]`)
        await wait(
          async () =>
            await cdp.evaluate<boolean>(
              `document.querySelector('[data-component=session-tab][data-active=true]')?.dataset.sessionId===${JSON.stringify(originalSession.id)}`,
            ),
          "original session restored",
        )
      }
      console.log("[right-panel-test] real session switching preserves shared browser state: PASS")
    }

    try {
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: 700,
        height: 900,
        deviceScaleFactor: 2,
        mobile: false,
      })
      await wait(
        async () => (await display()).lease === 0 && (await display()).views.every((view) => !view.visible),
        "narrow layout releases native display",
      )
    } finally {
      await cdp.call("Emulation.clearDeviceMetricsOverride")
    }
    await wait(
      async () => (await display()).views.some((view) => view.partition === user && view.visible),
      "remount restores current tab without resurrecting old display",
    )
    console.log("[right-panel-test] native display release/remount preserves tabs: PASS")

    await select("文件预览")
    await wait(
      async () => (await display()).views.every((view) => !view.visible),
      "switch to DOM preview hides native views",
    )
    assert.ok((await display()).views.every((view) => view.bounds.x < 0))
    await select("审查")
    assert.ok((await display()).views.every((view) => !view.visible))
    console.log("[right-panel-test] preview/review switch parks all native hit regions: PASS")

    const marker = "RIGHT_PANEL_SIDECAR_OK"
    const result = await cdp.evaluate<{ id: string; sent: boolean; received: boolean }>(`(async () => {
      const server=await window.api.awaitInitialization(()=>{});
      const headers={'Content-Type':'application/json','x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}),Authorization:'Basic '+btoa((server.username||'opencode')+':'+server.password)};
      const request=async(path,method='GET',body)=>{
        const r=await fetch(server.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
        if(!r.ok) throw Error('sidecar '+r.status+' '+path); return r.status===204?null:r.json();
      };
      const session=await request('/session','POST',{title:'Right panel sidecar regression'});
      await request('/session/'+session.id+'/shell','POST',{agent:'build',command:'printf ${marker}'});
      const messages=await request('/session/'+session.id+'/message');
      const sent=messages.some(m=>m.info.role==='user');
      const received=messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.type==='tool'&&p.state.status==='completed'&&p.state.output.includes('${marker}')));
      await request('/session/'+session.id,'PATCH',{time:{archived:Date.now()}});
      return {id:session.id,sent,received};
    })()`)
    assert.equal(result.sent, true)
    assert.equal(result.received, true)
    console.log(`[right-panel-test] real sidecar sent and received shell messages session=${result.id}: PASS`)
  } finally {
    await dismissModal()
    for (const partition of created) await cdp.evaluate(`window.api.browser.close(${JSON.stringify(partition)})`)
    const original = labels.find((label) => initial[label])
    if (original) await select(original)
    else {
      const current = await state()
      for (const label of labels) if (current[label]) await click(`button[aria-label="${label}"]`)
    }
    if ((await state())["文件树"] !== initial["文件树"]) await click('button[aria-label="文件树"]')
  }
  console.log("[right-panel-test] PASS; original panel selection restored")
})
