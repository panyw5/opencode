import { strict as assert } from "node:assert"
import { CdpClient } from "./cdp"

// Web-app variant of record-first-message-frames.ts: drives the dev app at
// http://localhost:4444 (backend :4096) inside a plain Chrome on CDP :9223.
// Usage: bun packages/desktop/scripts/record-first-message-frames-web.ts [delayMs]
const delayMs = Number(process.argv[2] ?? 1500)
const endpoint = "http://127.0.0.1:9223"
const server = "http://localhost:4096"

const log = (text: string) => console.log(`[first-message-frames] ${text}`)
const prompt = [
  "$$\\begin{equation}",
  "(x_i - x_{i+1})(x_i + x_{i+1} + 2r + 1 - i) = 0 \\ , \\quad i = 1, \\ldots, 2r + 1",
  "\\end{equation}",
  "\\begin{equation}",
  "\\prod_{a = 1}^{r + 1} (x_{s_a} + r + 1 - a) = 0",
  "\\end{equation}$$",
  "这组方程怎么求解？",
].join("\n")

const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:4444"))
assert.ok(page, "no localhost:4444 page target on :9223")
const cdp = await CdpClient.connect(page.webSocketDebuggerUrl)
await cdp.call("Runtime.enable")
await cdp.call("Page.enable")

const directory = await cdp.evaluate<string>(`atob(location.pathname.split("/")[1] || "")`)
assert.ok(directory.startsWith("/"), `could not resolve project directory from ${page.url}`)
log(`project directory=${directory} delay=${delayMs}ms`)

const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(server + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.status === 204 ? undefined : response.json().catch(() => undefined)
}

const wait = async (label: string, expression: string, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await cdp.evaluate<boolean>(expression)) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out: ${label}`)
}

const created: string[] = []
try {
  await cdp.evaluate(`(() => {
    const state = window.__frameQA = {
      originalFetch: window.fetch, originalDebug: console.debug, logs: [],
      creates: 0, prompts: 0, ids: [], delay: ${delayMs}, active: false, frames: [],
    };
    console.debug = (...args) => { state.logs.push(args.map(String).join(' ')); state.originalDebug(...args); };
    window.fetch = async (...args) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (args[1]?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (state.active && method === 'POST' && url.pathname === '/session') {
        state.creates++;
        await new Promise(resolve => setTimeout(resolve, state.delay));
        const response = await state.originalFetch.apply(window,args);
        if (response.ok) state.ids.push((await response.clone().json()).id);
        return response;
      }
      if (state.active && method === 'POST' && url.pathname.startsWith('/session/') && url.pathname.endsWith('/prompt_async')) state.prompts++;
      return state.originalFetch.apply(window,args);
    };
    return true;
  })()`)

  // Already on a draft route — use the composer directly.
  await wait("draft composer", `!!document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]')`)
  await cdp.evaluate(`(() => {
    const state=window.__frameQA;
    state.active=true;
    const editor=document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]');
    if (!editor) throw Error('editable composer missing');editor.focus();
  })()`)
  await cdp.call("Input.insertText", { text: prompt })
  await wait("prompt ready", `!document.querySelector('[data-action="prompt-submit"]').disabled`)

  await cdp.evaluate(`(() => {
    const state=window.__frameQA;
    state.started=performance.now();state.sampling=true;
    const sample=()=>{
      if(!state.sampling)return;
      const pending=document.querySelector('[data-component="pending-session"]');
      const page=document.querySelector('[data-component="session-page"]');
      const timeline=document.querySelector('[data-component="message-timeline"]');
      const statuses=[...document.querySelectorAll('[data-component="pending-session"] [role="status"], [data-slot="session-turn-thinking"]')].map(el=>{
        const r=el.getBoundingClientRect();const cs=getComputedStyle(el);
        return {kind:el.closest('[data-component="pending-session"]')?'pending':'timeline',text:el.textContent.trim().slice(0,24),x:Math.round(r.x),y:Math.round(r.y),h:Math.round(r.height),fontSize:cs.fontSize,vis:cs.visibility};
      });
      const vcontent=document.querySelector('[data-timeline-virtual-content]');
      const texts=[...document.querySelectorAll('[data-slot="user-message-text"]')];
      const rawMath=texts.some(e=>e.textContent.includes('$$')&&!e.querySelector('.katex'));
      const hasKatex=texts.some(e=>!!e.querySelector('.katex'));
      const md=texts[0]?.querySelector('[data-component="markdown"]');
      state.frames.push({
        t:Math.round(performance.now()-state.started),
        pending:!!pending,phase:pending?.dataset.phase??null,
        sid:page?.dataset.sessionId??null,rphase:page?.dataset.renderPhase??null,
        timeline:!!timeline,rawMath,hasKatex,
        mdFallback:md?.dataset.markdownFallback??null,
        mdStage:md?.dataset.markdownStage??null,
        mdRendered:md?.dataset.markdownRenderedStage??null,
        bubbleY:Math.round(texts[0]?.getBoundingClientRect().y??-1),
        bubbleVis:texts[0]?getComputedStyle(texts[0]).visibility:null,
        vcontentVis:vcontent?getComputedStyle(vcontent).visibility:null,
        statuses,
      });
      requestAnimationFrame(sample);
    };
    document.querySelector('[data-action="prompt-submit"]').click();
    requestAnimationFrame(sample);
  })()`)

  await wait(
    "real timeline session",
    `!!document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id')`,
    20_000,
  )
  await wait(
    "handoff finished",
    `!document.querySelector('[data-component="pending-session"]')`,
    20_000,
  )
  await Bun.sleep(1200)
  const result = await cdp.evaluate<{ frames: any[]; ids: string[]; creates: number; prompts: number }>(`(() => {
    const state=window.__frameQA;state.sampling=false;
    return {frames:state.frames,ids:state.ids,creates:state.creates,prompts:state.prompts};
  })()`)
  created.push(...result.ids)
  await Bun.write("/tmp/first-message-frames-web.json", JSON.stringify(result.frames, null, 2))
  log(`recorded ${result.frames.length} frames → /tmp/first-message-frames-web.json creates=${result.creates} prompts=${result.prompts}`)
  const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await Bun.write("/tmp/first-message-final-web.png", Buffer.from(shot.data, "base64"))
  const logs = await cdp.evaluate<string[]>(
    `window.__frameQA.logs.filter(line=>line.includes('[new-session-submit]')||line.includes('[timeline]')||line.includes('[session-bar]'))`,
  )
  for (const line of logs) log(line)
} finally {
  await cdp.evaluate(`(() => {
    const state=window.__frameQA;if(!state)return;
    state.sampling=false;window.fetch=state.originalFetch;console.debug=state.originalDebug;
    delete window.__frameQA;
  })()`).catch(() => undefined)
  for (const id of new Set(created)) {
    await request(`/session/${id}/abort`, "POST").catch(() => undefined)
    await request(`/session/${id}`, "PATCH", { time: { archived: Date.now() } }).catch(() => undefined)
  }
  log("cleanup done")
}
cdp.close()
process.exit(0)
