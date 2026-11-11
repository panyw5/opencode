import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { CdpClient, listTargets, pickPageTarget } from "../../../desktop/scripts/cdp"

// Use only disposable fixtures and a new development Electron window.
const root = resolve(import.meta.dir, "../../../..")
const baseline = process.argv.includes("--baseline")
const counts = process.argv.includes("--small") ? [1_000] : [1_000, 10_000]
await mkdir(join(root, ".artifacts"), { recursive: true })
const dir = await mkdtemp(join(root, ".artifacts/nb-performance-"))
const before = await listTargets()
const original = pickPageTarget(before)
assert.ok(original?.url.includes("localhost:5173"), "A development Electron renderer on 9222 is required")
const main = await CdpClient.connect(original.webSocketDebuggerUrl)
await main.evaluate('window.api.runDesktopMenuAction("window.new")')
main.close()
let target: (typeof before)[number] | undefined
const deadline = Date.now() + 30_000
while (!target) {
  target = (await listTargets()).find((entry) => entry.type === "page" && !before.some((old) => old.id === entry.id))
  if (Date.now() > deadline) throw new Error("Performance test window did not open")
  if (!target) await Bun.sleep(100)
}
const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
const wait = async (expression: string, timeout = 90_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return
    await Bun.sleep(100)
  }
  const alert = await cdp.evaluate("document.querySelector('.oc-nb [role=alert]')?.textContent")
  throw new Error(`Performance condition timed out: ${expression}; alert=${alert}`)
}
const results: unknown[] = []
try {
  await wait(
    "document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.evaluate("window.api.showWindow()")
  await cdp.evaluate(
    `(() => {const a=document.createElement('a');a.href='/'+btoa(${JSON.stringify(root)}).replace(/=/g,'')+'/session';document.body.append(a);a.click();a.remove();return true})()`,
  )
  await wait("!!document.querySelector('[data-component=session-page]')")
  for (const count of counts) {
    const file = join(dir, `cells-${count}.nb`)
    const source = `Notebook[{${Array.from({ length: count }, (_, i) => `Cell[BoxData["x${i} = ${i} + Sin[Pi/2]"], "Input"]`).join(",\n")}}]`
    await writeFile(file, source)
    await cdp.evaluate(`(() => {
      window.__nbPerf={frames:[],longTasks:[],frame:0,last:performance.now()};
      const state=window.__nbPerf;
      const tick=now=>{state.frames.push(now-state.last);state.last=now;state.frame=requestAnimationFrame(tick)};
      state.frame=requestAnimationFrame(tick);
      try{state.observer=new PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(x=>x.duration)));state.observer.observe({type:'longtask',buffered:false})}catch{}
      return true;
    })()`)
    const start = performance.now()
    await cdp.evaluate(
      `(() => {const page=document.querySelector('[data-component=session-page]');const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(file)};a.href='#';page.append(a);a.click();a.remove();return true})()`,
    )
    await wait(
      `[...document.querySelectorAll('.oc-nb')].some(root=>root.dataset.notebookPath===${JSON.stringify(file)} && !!root.querySelector('[data-cell-index="0"] textarea'))`,
    )
    await cdp.evaluate(
      `window.__nbRoot=[...document.querySelectorAll('.oc-nb')].find(root=>root.dataset.notebookPath===${JSON.stringify(file)});true`,
    )
    const firstVisibleMs = Math.round(performance.now() - start)
    await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    const initial = await cdp.evaluate(
      `(() => {const r=window.__nbRoot;return {cells:r.querySelectorAll('.oc-nb-cell').length,editors:r.querySelectorAll('textarea').length,tokens:r.querySelectorAll('[data-token]').length,dom:r.querySelectorAll('*').length,scrollHeight:r.scrollHeight,viewport:r.clientHeight,heap:performance.memory?.usedJSHeapSize}})()`,
    )
    if (!baseline) assert.ok((initial as { editors: number }).editors < 100, "Editor DOM must be viewport bounded")
    const scroll = await cdp.evaluate(`(async()=>{
      const root=window.__nbRoot;const state=window.__nbPerf;state.frames=[];state.longTasks=[];
      for(let i=1;i<=40;i++){root.scrollTop=(root.scrollHeight-root.clientHeight)*i/40;await new Promise(resolve=>requestAnimationFrame(resolve))}
      for(let i=0;i<12;i++){root.scrollTop=root.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
      const frames=state.frames.slice().sort((a,b)=>a-b);
      return {frameP50:frames[Math.floor(frames.length*.5)]??0,frameP95:frames[Math.floor(frames.length*.95)]??0,maxFrame:Math.max(0,...frames),longTasks:state.longTasks.length,longTaskMs:state.longTasks.reduce((a,b)=>a+b,0),editors:root.querySelectorAll('textarea').length,lastCell:!!root.querySelector('[data-cell-index="${count - 1}"]')};
    })()`)
    const result = {
      phase: baseline ? "baseline" : "optimized",
      count,
      bytes: Buffer.byteLength(source),
      firstVisibleMs,
      initial,
      scroll,
    }
    console.info(`[notebook-performance] ${JSON.stringify(result)}`)
    if (!baseline) {
      assert.ok((scroll as { editors: number }).editors < 100)
      assert.ok((scroll as { lastCell: boolean }).lastCell, "Last cell must be reachable")
    }
    results.push(result)
    if (!baseline) {
      // Focus/IME must survive scrolling; after blur the row may unmount, but the draft must remain.
      await cdp.evaluate(
        `(async()=>{const r=window.__nbRoot;for(let i=0;i<8;i++){r.scrollTop=0;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}return true})()`,
      )
      await wait("!!window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')")
      await cdp.evaluate(
        `(()=>{const f=window.__nbRoot.querySelector('[data-cell-index="0"] textarea');f.focus();f.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));f.value='notebookPerformanceDraft = 42';f.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
      )
      await cdp.evaluate(
        `(async()=>{const r=window.__nbRoot;for(let i=0;i<8;i++){r.scrollTop=r.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}return true})()`,
      )
      assert.equal(
        await cdp.evaluate(
          "document.activeElement===window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')",
        ),
        true,
        "Focused composition editor must stay mounted",
      )
      await cdp.evaluate(
        `(()=>{const f=window.__nbRoot.querySelector('[data-cell-index="0"] textarea');f.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));f.blur();return true})()`,
      )
      await wait("!window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')")
      await cdp.evaluate(
        `(async()=>{const r=window.__nbRoot;for(let i=0;i<8;i++){r.scrollTop=0;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}return true})()`,
      )
      await wait(
        "window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')?.value==='notebookPerformanceDraft = 42'",
      )
      // Resize/hidden restore may invalidate measurements but must not lose data or grow DOM.
      await cdp.evaluate("window.__nbRoot.style.width='430px';true")
      await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
      await cdp.evaluate("window.__nbRoot.style.removeProperty('width');window.__nbRoot.style.display='none';true")
      await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(resolve))")
      await cdp.evaluate("window.__nbRoot.style.removeProperty('display');true")
      await wait(
        "window.__nbRoot.clientHeight>0 && !!window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')",
      )
      await cdp.evaluate(
        "[...window.__nbRoot.closest('[data-extension]').querySelectorAll('.oc-nb-toolbar button')].find(x=>x.textContent.trim()==='Save *').click();true",
      )
      await wait(
        "[...window.__nbRoot.closest('[data-extension]').querySelectorAll('.oc-nb-toolbar button')].some(x=>x.textContent.trim()==='Save' && x.disabled)",
      )
      assert.ok(
        (await readFile(file, "utf8")).includes('BoxData["notebookPerformanceDraft = 42"]'),
        "A virtualized draft must be saved in full",
      )
      await cdp.evaluate(
        "[...window.__nbRoot.closest('[data-extension]').querySelectorAll('.oc-nb-toolbar button')].find(x=>x.textContent.trim()==='Reload').click();true",
      )
      await wait(
        "window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')?.value==='notebookPerformanceDraft = 42'",
      )
      console.info(
        `[notebook-performance] PASS interaction count=${count} focus/IME pin, draft remount, resize, hide/restore, save/reload`,
      )
    }
    await cdp.evaluate(
      "(()=>{cancelAnimationFrame(window.__nbPerf.frame);window.__nbPerf.observer?.disconnect();delete window.__nbPerf;return true})()",
    )
  }
  if (!baseline) {
    const file = join(dir, "large-content.nb")
    const large = "a".repeat(120_000)
    const opaque = "z".repeat(2_000_000)
    const source = `Notebook[{Cell["${large}","Text"],Cell[BoxData[InterpretationBox["opaque",CompressedData["${opaque}"]]],"Output"],Cell["editable tail","Text"]}]`
    await writeFile(file, source)
    await cdp.evaluate(
      `(()=>{const p=document.querySelector('[data-component=session-page]');const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(file)};a.href='#';p.append(a);a.click();a.remove();return true})()`,
    )
    await wait(
      "[...document.querySelectorAll('.oc-nb')].some(r=>r.dataset.notebookPath?.endsWith('/large-content.nb') && !!r.querySelector('.oc-nb-preview'))",
    )
    await cdp.evaluate(
      "window.__nbRoot=[...document.querySelectorAll('.oc-nb')].find(r=>r.dataset.notebookPath?.endsWith('/large-content.nb'));true",
    )
    assert.equal(await cdp.evaluate("!!window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')"), false)
    assert.equal(await cdp.evaluate("!!window.__nbRoot.querySelector('[data-cell-index=\"1\"] details pre')"), false)
    await cdp.evaluate("window.__nbRoot.querySelector('[data-cell-index=\"1\"] summary').click();true")
    await wait("!!window.__nbRoot.querySelector('[data-cell-index=\"1\"] details pre')")
    assert.ok(
      await cdp.evaluate(
        "window.__nbRoot.querySelector('[data-cell-index=\"1\"] details pre').textContent.length<=16000",
      ),
    )
    await cdp.evaluate("window.__nbRoot.querySelector('[data-cell-index=\"1\"] summary').click();true")
    await wait("!window.__nbRoot.querySelector('[data-cell-index=\"1\"] details pre')")
    await cdp.evaluate("window.__nbRoot.scrollTop=window.__nbRoot.scrollHeight;true")
    await wait("!!window.__nbRoot.querySelector('[data-cell-index=\"2\"] textarea')")
    await cdp.evaluate(
      "(()=>{const f=window.__nbRoot.querySelector('[data-cell-index=\"2\"] textarea');f.value='changed tail';f.dispatchEvent(new Event('input',{bubbles:true}));[...window.__nbRoot.closest('[data-extension]').querySelectorAll('.oc-nb-toolbar button')].find(x=>x.textContent.trim()==='Save *').click();return true})()",
    )
    await wait(
      "[...window.__nbRoot.closest('[data-extension]').querySelectorAll('.oc-nb-toolbar button')].some(x=>x.textContent.trim()==='Save' && x.disabled)",
    )
    assert.equal(
      await readFile(file, "utf8"),
      source.replace('"editable tail"', '"changed tail"'),
      "Display previews must never replace full original text",
    )
    await cdp.evaluate("window.__nbRoot.querySelector('[data-cell-index=\"0\"] .oc-nb-preview button').click();true")
    await wait("window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')?.value.length===120000")
    assert.equal(
      await cdp.evaluate("!!window.__nbRoot.querySelector('[data-cell-index=\"0\"] .oc-nb-highlight')"),
      false,
    )
    assert.notEqual(
      await cdp.evaluate(
        "getComputedStyle(window.__nbRoot.querySelector('[data-cell-index=\"0\"] textarea')).webkitTextFillColor",
      ),
      "rgba(0, 0, 0, 0)",
    )
    console.info(
      "[notebook-performance] PASS giant cell preview/full-text separation, opaque lazy details, plain-text visibility",
    )
  }
  console.info(`[notebook-performance] PASS phase=${baseline ? "baseline" : "optimized"} cases=${results.length}`)
} finally {
  await cdp
    .evaluate(
      "(()=>{if(window.__nbPerf){cancelAnimationFrame(window.__nbPerf.frame);window.__nbPerf.observer?.disconnect();delete window.__nbPerf}return true})()",
    )
    .catch(() => {})
  await cdp.evaluate('window.api.runDesktopMenuAction("window.close")').catch(() => {})
  cdp.close()
  await rm(dir, { recursive: true, force: true })
}
