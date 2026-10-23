import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (text: string) => console.log(`[new-session-submit-test] ${text}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`
const directory = resolve(import.meta.dir, "../../..")
const marker = "NEW_SESSION_UI_QA_OK"
const prompt = `Reply with only ${marker}. Do not call tools or modify files.`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  await cdp.call("Runtime.enable")
  const previous =
    new URL(target.url).pathname === "/index.html" ? "/" : new URL(target.url).pathname + new URL(target.url).search
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.__newSessionConnection = window.api.awaitInitialization(() => {}).then(s=>({url:s.url,username:s.username,password:s.password}))",
  )
  log("connected to the development renderer and sidecar")
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, expression: string, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(50)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigate = (route: string) =>
    cdp.evaluate(`(() => {
    window.__newSessionNavigation = import(${JSON.stringify(`${source}/utils/notification-click.ts`)}).then(({handleNotificationClick}) => {
      handleNotificationClick(${JSON.stringify(route)});return true;
    });return window.__newSessionNavigation;
  })()`)
  const created: string[] = []
  try {
    await cdp.evaluate(`(() => {
      const tab=[...document.querySelectorAll('[data-component="session-tab"]')].find(e=>e.dataset.directory===${JSON.stringify(directory)});
      if (!tab) throw Error('open a project tab for the repository before running this test');tab.click();
    })()`)
    await wait("project session header", `!!document.querySelector('[data-action="session-new-button"]')`)
    await cdp.evaluate(`(() => {
      const state = window.__newSessionQA = {
        originalFetch: window.fetch, originalDebug: console.debug, logs: [],
        creates: 0, prompts: 0, ids: [], delay: 1400, fail: false, active: false, frames: [],
      };
      console.debug = (...args) => { state.logs.push(args.map(String).join(' ')); state.originalDebug(...args); };
      window.fetch = async (...args) => {
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = (args[1]?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (state.active && method === 'POST' && url.pathname === '/session') {
          state.creates++;
          await new Promise(resolve => setTimeout(resolve, state.delay));
          if (state.fail) { state.fail = false; return new Response(JSON.stringify({message:'QA create unavailable'}), {status:503,headers:{'Content-Type':'application/json'}}); }
          const response = await state.originalFetch.apply(window,args);
          if (response.ok) state.ids.push((await response.clone().json()).id);
          return response;
        }
        if (state.active && method === 'POST' && url.pathname.startsWith('/session/') && url.pathname.endsWith('/prompt_async')) state.prompts++;
        return state.originalFetch.apply(window,args);
      };
    })()`)
    for (const fail of [false, true]) {
      await cdp.evaluate(`document.querySelector('[data-action="session-new-button"]').click()`)
      await wait(
        "new draft composer",
        `!!document.querySelector('[data-prompt-kind="main"]') && !document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id')`,
      )
      await cdp.evaluate(`(() => {
        const state=window.__newSessionQA;
        state.creates=0;state.prompts=0;state.frames=[];state.fail=${fail};state.active=true;
        const editor=document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]');
        if (!editor) throw Error('editable composer missing');editor.focus();
      })()`)
      await cdp.call("Input.insertText", { text: prompt })
      await wait("prompt ready", `!document.querySelector('[data-action="prompt-submit"]').disabled`)
      await cdp.evaluate(`(() => {
        const state=window.__newSessionQA;
        state.started=performance.now();state.sampling=true;
        const sample=()=>{
          if(!state.sampling)return;
          const pending=document.querySelector('[data-component="pending-session"]');
          const real=document.querySelector('[data-component="message-timeline"]');
          const owner=pending||real;
          const bubbles=owner?[...owner.querySelectorAll('[data-component="user-message"]')].filter(e=>e.textContent.includes(${JSON.stringify(prompt)})):[];
          const r=bubbles[0]?.getBoundingClientRect();
          state.frames.push({at:performance.now()-state.started,pending:!!pending,count:bubbles.length,y:r?.y});
          requestAnimationFrame(sample);
        };
        document.querySelector('[data-action="prompt-submit"]').click();
        document.querySelector('[data-prompt-kind="main"] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        requestAnimationFrame(sample);
      })()`)
      await wait(
        "immediate message preview",
        `document.querySelector('[data-component="pending-session"] [data-slot="user-message-text"]')?.textContent.includes(${JSON.stringify(marker)})`,
      )
      const early = await cdp.evaluate<{
        creates: number
        prompts: number
        session: string | null
        elapsed: number
        empty: boolean
      }>(`({
        creates:window.__newSessionQA.creates,prompts:window.__newSessionQA.prompts,
        session:document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id'),
        elapsed:performance.now()-window.__newSessionQA.started,
        empty:!document.querySelector('[data-component="prompt-input"]').textContent.trim()
      })`)
      assert.equal(early.creates, 1)
      assert.equal(early.prompts, 0)
      assert.equal(early.session, null)
      assert.equal(early.empty, true)
      assert.ok(early.elapsed < 1000, `preview took ${early.elapsed}ms`)
      log(`PASS preview visible after ${Math.round(early.elapsed)}ms, before delayed session creation`)
      if (fail) {
        await wait(
          "create failure retained",
          `document.querySelector('[data-component="pending-session"]')?.getAttribute('data-phase')==='failed'`,
        )
        assert.equal(await cdp.evaluate("window.__newSessionQA.prompts"), 0)
        await cdp.evaluate(`(() => {
          const button=[...document.querySelectorAll('[data-component="pending-session"] button')].find(e=>e.textContent.trim()==='重试'||e.textContent.trim()==='Retry');
          if(!button)throw Error('retry button missing');button.click();button.click();
        })()`)
      }
      await wait(
        "preview handed to real timeline",
        `!!document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id') && !document.querySelector('[data-component="pending-session"]')`,
      )
      await Bun.sleep(200)
      const result = await cdp.evaluate<{
        id: string
        creates: number
        prompts: number
        frames: { count: number; y: number; at: number; pending: boolean }[]
      }>(`(() => {
        const state=window.__newSessionQA;state.sampling=false;
        return {id:document.querySelector('[data-component="session-page"]').getAttribute('data-session-id'),creates:state.creates,prompts:state.prompts,frames:state.frames};
      })()`)
      created.push(result.id)
      assert.equal(result.creates, fail ? 2 : 1)
      assert.equal(result.prompts, 1)
      const visible = result.frames.filter((frame) => frame.at > early.elapsed)
      assert.ok(visible.length > 10)
      assert.ok(
        visible.every((frame) => frame.count === 1),
        "each rendered frame must have exactly one visible user message",
      )
      assert.equal(visible.at(-1)?.pending, false, "sample the real timeline after handoff")
      const positions = visible.map((frame) => frame.y)
      const shift = Math.max(...positions) - Math.min(...positions)
      assert.ok(shift <= 2, `message must not jump during handoff: ${shift}px`)
      log(
        `PASS ${fail ? "failed-create retry" : "slow create"}: one session, one prompt, no blank/duplicate frames; bubble shift=${Math.round(shift)}px`,
      )
      let received = false
      for (let attempt = 0; attempt < 900; attempt++) {
        const messages = await request(`/session/${result.id}/message`)
        assert.ok(messages.filter((row: any) => row.info.role === "user").length <= 1)
        received = messages.some(
          (row: any) =>
            row.info.role === "assistant" &&
            typeof row.info.time.completed === "number" &&
            row.parts.some((part: any) => part.type === "text" && part.text.includes(marker)),
        )
        if (received) break
        await Bun.sleep(100)
      }
      assert.equal(received, true, "real sidecar must return the assistant's reply")
      const delivered = await request(`/session/${result.id}/message`)
      assert.equal(delivered.filter((row: any) => row.info.role === "user").length, 1)
      log(`PASS real sidecar sent and received marker; database contains one user message session=${result.id}`)
      await cdp.evaluate("window.__newSessionQA.active=false")
    }
    const response = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-new-session-verified.png", Buffer.from(response.data, "base64"))
    const logs = await cdp.evaluate<string[]>(
      "window.__newSessionQA.logs.filter(line=>line.includes('[new-session-submit]'))",
    )
    for (const line of logs) log(line)
  } catch (err) {
    log(`FAIL ${String(err)}`)
    throw err
  } finally {
    const ids = await cdp.evaluate<string[]>("window.__newSessionQA?.ids??[]")
    await cdp.evaluate(`(() => {
      const state=window.__newSessionQA;if(!state)return;
      state.sampling=false;window.fetch=state.originalFetch;console.debug=state.originalDebug;
      delete window.__newSessionQA;
      delete window.__newSessionConnection;
    })()`)
    await navigate(previous).catch((err) => log(`restore navigation failed: ${String(err)}`))
    await cdp.evaluate("delete window.__newSessionNavigation")
    for (const id of new Set([...created, ...ids])) {
      await request(`/session/${id}/abort`, "POST").catch(() => undefined)
      await request(`/session/${id}`, "PATCH", { time: { archived: Date.now() } })
    }
  }
})
