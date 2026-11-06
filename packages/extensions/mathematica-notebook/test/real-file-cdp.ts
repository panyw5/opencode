import { strict as assert } from "node:assert"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { CdpClient, listTargets, pickPageTarget } from "../../../desktop/scripts/cdp"
import { parseNotebook } from "../src/notebook"

// Read-only real-file verification: never calls save/run/stop or edits the source.
const file = process.argv[2]
assert.ok(file && file.startsWith("/") && /\.nb$/i.test(file), "Pass an absolute .nb file path")
const info = await stat(file)
assert.ok(info.size <= 20 * 1024 * 1024, "Notebook exceeds the preview limit")
const initial = await readFile(file)
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const expected = hash(initial)
const source = initial.toString("utf8")
const times: number[] = []
let parsed = parseNotebook(source)
for (let i = 0; i < 5; i++) {
  const started = performance.now()
  parsed = parseNotebook(source)
  times.push(performance.now() - started)
}
const sorted = times.toSorted((a, b) => a - b)
const model = {
  bytes: initial.length,
  cells: parsed.cells.length,
  editable: parsed.cells.filter((cell) => cell.editable).length,
  opaque: parsed.cells.filter((cell) => !cell.editable).length,
  maxCellCharacters: Math.max(0, ...parsed.cells.map((cell) => cell.text.length)),
  parseMedianMs: sorted[2],
  parseMinMs: sorted[0],
  parseMaxMs: sorted[4],
  legacyCellBytes: Buffer.byteLength(JSON.stringify(parsed.cells)),
  viewCellBytes: Buffer.byteLength(JSON.stringify(parsed.cells.map(({ raw, start, end, ...cell }) => cell))),
}
console.info(`[notebook-real] model ${JSON.stringify(model)}`)
const before = await listTargets()
const original = pickPageTarget(before)
assert.ok(original?.url.includes("localhost:5173"), "Development Electron on 9222 is required")
const main = await CdpClient.connect(original.webSocketDebuggerUrl)
await main.evaluate('window.api.runDesktopMenuAction("window.new")')
main.close()
let target: (typeof before)[number] | undefined
const deadline = Date.now() + 30_000
while (!target) {
  target = (await listTargets()).find((item) => item.type === "page" && !before.some((old) => old.id === item.id))
  if (Date.now() > deadline) throw new Error("Real-file test window did not open")
  if (!target) await Bun.sleep(100)
}
const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
// Count backend file.read starts: desktop IPC requests are not renderer Network events.
const logDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/log")
const logNames = (await readdir(logDir))
  .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}\.log$/.test(name))
  .sort()
  .reverse()
const logPath = logNames[0] ? join(logDir, logNames[0]) : undefined
assert.ok(logPath, "Backend log is required to verify zero source preloads")
const logBefore = await readFile(logPath, "utf8")
const wait = async (expression: string, timeout = 90_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Real-file verification timed out: ${expression}`)
}
try {
  await wait(
    "document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.evaluate("window.api.showWindow()")
  const project = Buffer.from(dirname(file)).toString("base64url")
  await cdp.evaluate(
    `(()=>{const a=document.createElement('a');a.href='/${project}/session';document.body.append(a);a.click();a.remove();return true})()`,
  )
  await wait("!!document.querySelector('[data-component=session-page]')")
  const started = performance.now()
  await cdp.evaluate(
    `(()=>{const p=document.querySelector('[data-component=session-page]');const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(file)};a.href='#';p.append(a);a.click();a.remove();return true})()`,
  )
  await wait(
    `[...document.querySelectorAll('.oc-nb')].some(r=>r.dataset.notebookPath===${JSON.stringify(file)} && !!r.querySelector('[data-cell-index="0"]'))`,
  )
  const firstVisibleMs = performance.now() - started
  await cdp.evaluate(
    `window.__nbRealRoot=[...document.querySelectorAll('.oc-nb')].find(r=>r.dataset.notebookPath===${JSON.stringify(file)});true`,
  )
  await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
  const view = await cdp.evaluate(
    `(()=>{const r=window.__nbRealRoot,s=r.closest('[data-extension]'),row=s.querySelector('[data-slot="file-viewer-toolbar"]');return {firstVisibleMs:${firstVisibleMs},mountedCells:r.querySelectorAll('.oc-nb-cell').length,editors:r.querySelectorAll('textarea').length,tokens:r.querySelectorAll('[data-token]').length,dom:s.querySelectorAll('*').length,viewport:r.clientHeight,scrollHeight:r.scrollHeight,heap:performance.memory?.usedJSHeapSize,toolbarButtons:[...row.querySelectorAll('.oc-nb-toolbar button')].map(x=>x.textContent.trim()),heading:!!s.querySelector('.oc-nb-heading'),defaultsHidden:s.querySelector('[data-slot="file-viewer-default-toolbar"]')?.hidden,toolbarGap:r.getBoundingClientRect().top-row.getBoundingClientRect().bottom,error:r.querySelector('[role=alert]')?.textContent??''}})()`,
  )
  console.info(`[notebook-real] initial ${JSON.stringify(view)}`)
  const scroll = await cdp.evaluate(`(async()=>{
    const r=window.__nbRealRoot;const frames=[],tasks=[];let last=performance.now(),id;
    const tick=now=>{frames.push(now-last);last=now;id=requestAnimationFrame(tick)};id=requestAnimationFrame(tick);
    let observer;try{observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(x=>x.duration)));observer.observe({type:'longtask'})}catch{}
    let maxMounted=0,maxEditors=0;
    try{for(let i=1;i<=60;i++){r.scrollTop=(r.scrollHeight-r.clientHeight)*i/60;await new Promise(resolve=>requestAnimationFrame(resolve));maxMounted=Math.max(maxMounted,r.querySelectorAll('.oc-nb-cell').length);maxEditors=Math.max(maxEditors,r.querySelectorAll('textarea').length)}
      for(let i=0;i<12;i++){r.scrollTop=r.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
      frames.sort((a,b)=>a-b);return {frameP50:frames[Math.floor(frames.length*.5)]??0,frameP95:frames[Math.floor(frames.length*.95)]??0,maxFrame:Math.max(0,...frames),longTasks:tasks.length,longTaskMs:tasks.reduce((a,b)=>a+b,0),maxMounted,maxEditors,lastCell:!!r.querySelector('[data-cell-index="${parsed.cells.length - 1}"]'),finalMounted:r.querySelectorAll('.oc-nb-cell').length};
    }finally{cancelAnimationFrame(id);observer?.disconnect()}
  })()`)
  console.info(`[notebook-real] scroll ${JSON.stringify(scroll)}`)
  assert.equal((scroll as { lastCell: boolean }).lastCell, true, "Last real notebook cell must be reachable")
  const reads = await cdp.evaluate(`(async()=>{
    const config=await window.api.awaitInitialization();const results=[];
    for(let i=0;i<4;i++){
      const started=performance.now();const res=await window.api.fetchExternal(config.url+'/extension/local.mathematica-notebook/rpc/notebook.read',{method:'POST',headers:{Authorization:'Basic '+btoa(config.username+':'+config.password),'Content-Type':'application/json','x-opencode-directory':${JSON.stringify(dirname(file))}},body:JSON.stringify({input:{path:${JSON.stringify(file)},view:true}})});
      if(!res.ok)throw Error('Read benchmark failed '+res.status);const raw=res.body,body=JSON.parse(raw);const doc=body.result;
      results.push({ms:performance.now()-started,characters:raw.length,cells:doc.cells.length,revision:doc.revision});
    }return results;
  })()`)
  assert.ok(
    (reads as { revision: string }[]).every((item) => item.revision === expected),
    "Read responses must match the actual source hash",
  )
  console.info(
    `[notebook-real] repeatedReads ${JSON.stringify((reads as { ms: number; characters: number; cells: number }[]).map(({ ms, characters, cells }) => ({ ms, characters, cells })))}`,
  )
  await cdp.evaluate(
    "(async()=>{const r=window.__nbRealRoot;for(let i=0;i<8;i++){r.scrollTop=0;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}return true})()",
  )
  const clip = await cdp.evaluate<{ x: number; y: number; width: number; height: number; scale: number }>(
    "(()=>{const b=window.__nbRealRoot.closest('[data-extension]').getBoundingClientRect();return {x:Math.max(0,b.x),y:Math.max(0,b.y),width:Math.min(innerWidth,b.right)-Math.max(0,b.x),height:Math.min(innerHeight,b.bottom)-Math.max(0,b.y),scale:1}})()",
  )
  const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png", clip })
  await writeFile("/tmp/notebook-real-file.png", Buffer.from(screenshot.data, "base64"))
  const afterLog = (await readFile(logPath, "utf8")).slice(logBefore.length)
  const sourceReads = afterLog
    .split("\n")
    .filter(
      (line) =>
        line.includes("service=file ") &&
        line.includes("status=started") &&
        line.includes(" read") &&
        (line.includes(file) || line.includes(file.split("/").at(-1)!)),
    ).length
  console.info(`[notebook-real] hostSourceReads=${sourceReads}`)
  assert.equal(sourceReads, 0, "Self-reading notebook display must not invoke host file.read")
  console.info("[notebook-real] PASS read-only display, zero source preload, scroll, toolbar and unchanged SHA-256")
} finally {
  await cdp.evaluate('window.api.runDesktopMenuAction("window.close")').catch(() => {})
  cdp.close()
  assert.equal(hash(await readFile(file)), expected, "Real notebook content changed during verification")
}
