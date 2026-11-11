import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { CdpClient, listTargets, pickPageTarget } from "../../../desktop/scripts/cdp"

// Only disposable notebooks/windows; no kernel execution or real-file writes.
const root = resolve(import.meta.dir, "../../../..")
await mkdir(join(root, ".artifacts"), { recursive: true })
const dir = await mkdtemp(join(root, ".artifacts/nb-rich-cdp-"))
const before = await listTargets()
const original = pickPageTarget(before)
assert.ok(original?.url.includes("localhost:5173"), "Development Electron on CDP 9222 is required")
const main = await CdpClient.connect(original.webSocketDebuggerUrl)
await main.evaluate('window.api.runDesktopMenuAction("window.new")')
main.close()
let target: (typeof before)[number] | undefined
const deadline = Date.now() + 30_000
while (!target) {
  target = (await listTargets()).find((item) => item.type === "page" && !before.some((old) => old.id === item.id))
  if (Date.now() > deadline) throw Error("Test window did not open")
  if (!target) await Bun.sleep(100)
}
const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
const wait = async (expression: string, timeout = 30_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return
    await Bun.sleep(50)
  }
  throw Error(
    `Rich preview timed out: ${expression}; ${await cdp.evaluate("document.querySelector('.oc-nb')?.innerText.slice(0,700)")}`,
  )
}
const hash = (source: string) => createHash("sha256").update(source).digest("hex")
const open = async (path: string) => {
  await cdp.evaluate(
    `(()=>{const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(path)};a.href='#';document.querySelector('[data-component=session-page]').append(a);a.click();a.remove();return true})()`,
  )
  await wait(`[...document.querySelectorAll('.oc-nb')].some(r=>r.dataset.notebookPath===${JSON.stringify(path)})`)
  await cdp.evaluate(
    `window.__richRoot=[...document.querySelectorAll('.oc-nb')].find(r=>r.dataset.notebookPath===${JSON.stringify(path)});true`,
  )
}
try {
  await wait(
    "document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.evaluate("window.api.showWindow()")
  const project = Buffer.from(root).toString("base64url")
  await cdp.evaluate(
    `(()=>{const a=document.createElement('a');a.href='/${project}/session';document.body.append(a);a.click();a.remove();return true})()`,
  )
  await wait("!!document.querySelector('[data-component=session-page]')")
  for (const count of process.argv.includes("--small") ? [1000] : [1000, 10000]) {
    const path = join(dir, `rich-${count}.nb`)
    const source = `Notebook[{${Array.from({ length: count }, (_, index) => `Cell[BoxData[RowBox[{SubscriptBox["f","${index}"],"=",FractionBox[RowBox[{"1","+",SuperscriptBox["x","2"]}],SqrtBox["y"]]}]],"Output"]`).join(",\n")}}]`
    await writeFile(path, source)
    const start = performance.now()
    await open(path)
    await wait(
      "window.__richRoot.querySelector('[data-cell-index=\"0\"] [data-preview-status=complete] math mfrac')!==null",
    )
    const firstFormulaMs = performance.now() - start
    const layout = await cdp.evaluate(`(()=>{
      const r=window.__richRoot,f=r.querySelector('mfrac'),n=f.children[0].getBoundingClientRect(),d=f.children[1].getBoundingClientRect();
      return {namespace:f.namespaceURI,numeratorAboveDenominator:n.y<d.y,dom:r.querySelectorAll('*').length,mounted:r.querySelectorAll('.oc-nb-cell').length,math:r.querySelectorAll('math').length,source:r.querySelectorAll('details pre').length};
    })()`)
    assert.equal((layout as { namespace: string }).namespace, "http://www.w3.org/1998/Math/MathML")
    assert.equal((layout as { numeratorAboveDenominator: boolean }).numeratorAboveDenominator, true)
    assert.equal((layout as { source: number }).source, 0)
    const scroll = await cdp.evaluate(`(async()=>{
      const r=window.__richRoot,frames=[],tasks=[];let id,last=performance.now(),maxDom=0,maxMounted=0,maxRendered=0;
      const tick=now=>{frames.push(now-last);last=now;id=requestAnimationFrame(tick)};id=requestAnimationFrame(tick);
      const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(x=>x.duration)));observer.observe({type:'longtask'});
      try{
        for(let i=1;i<=90;i++){r.scrollTop+=80;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));maxDom=Math.max(maxDom,r.querySelectorAll('*').length);maxMounted=Math.max(maxMounted,r.querySelectorAll('.oc-nb-cell').length);maxRendered=Math.max(maxRendered,r.querySelectorAll('math').length)}
        for(let i=1;i<=30;i++){r.scrollTop=(r.scrollHeight-r.clientHeight)*i/30;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
        for(let i=0;i<12;i++){r.scrollTop=r.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
        frames.sort((a,b)=>a-b);return {frameP95:frames[Math.floor(frames.length*.95)],maxFrame:Math.max(...frames),longTasks:tasks.length,longTaskMs:tasks.reduce((a,b)=>a+b,0),maxDom,maxMounted,maxRendered};
      }finally{cancelAnimationFrame(id);observer.disconnect()}
    })()`)
    await wait(`!!window.__richRoot.querySelector('[data-cell-index="${count - 1}"] [data-preview-status="complete"]')`)
    assert.ok((scroll as { maxMounted: number }).maxMounted < 100)
    assert.ok(
      (scroll as { maxRendered: number }).maxRendered >= 4,
      "Scroll benchmark must include real rendered formulas, not just placeholders",
    )
    assert.ok((scroll as { maxDom: number }).maxDom < 10000, "DOM must stay viewport-bounded")
    assert.ok((scroll as { frameP95: number }).frameP95 < 50, "Rich scroll must not continuously miss frames")
    assert.equal(hash(await readFile(path, "utf8")), hash(source))
    console.info(
      `[notebook-rich] ${JSON.stringify({ count, bytes: Buffer.byteLength(source), firstFormulaMs, layout, scroll })}`,
    )
    await cdp.evaluate("window.__richRoot.scrollTop=0;true")
    await wait("!!window.__richRoot.querySelector('[data-cell-index=\"0\"] [data-preview-status=complete]')")
  }
  const path = join(dir, "bounded.nb")
  const hidden = "z".repeat(2_000_000)
  const source = `Notebook[{Cell[BoxData[InterpretationBox[FractionBox["1","2"],CompressedData["${hidden}"]]],"Output"],Cell[BoxData[RowBox[{"x",UnknownBox["secret"],"y"}]],"Output"],Cell[BoxData[RowBox[{${Array(10000).fill('FractionBox["1","2"]').join(",")}}]],"Output"],Cell[BoxData[{RowBox[{"a","=","1"}],"\\[IndentingNewLine]",RowBox[{"b","=","2"}]}],"Input"]}]`
  await writeFile(path, source)
  await open(path)
  await wait(
    "!!window.__richRoot.querySelector('[data-cell-index=\"0\"] [data-preview-status=complete]') && !!window.__richRoot.querySelector('[data-cell-index=\"1\"] [data-preview-status=partial]') && !!window.__richRoot.querySelector('[data-cell-index=\"2\"] [data-preview-status=limited]')",
  )
  const bounded = await cdp.evaluate(
    `(()=>{const r=window.__richRoot;return {dom:r.querySelectorAll('*').length,huge:r.querySelector('[data-cell-index="2"]').querySelectorAll('*').length,text:r.innerText.length,unknown:r.querySelector('[data-cell-index="1"] math').textContent,pre:r.querySelectorAll('details pre').length}})()`,
  )
  assert.ok((bounded as { huge: number }).huge < 2100)
  assert.ok((bounded as { text: number }).text < 10000)
  assert.equal((bounded as { pre: number }).pre, 0)
  assert.ok((bounded as { unknown: string }).unknown.includes("UnknownBox"))
  await wait("!!window.__richRoot.querySelector('[data-cell-index=\"3\"] [data-preview-status=complete] mtable')")
  assert.equal(
    await cdp.evaluate(
      `(()=>{const rows=window.__richRoot.querySelectorAll('[data-cell-index="3"] mtable>mtr');return rows.length===2 && rows[0].textContent==='a=1' && rows[1].textContent==='b=2' && rows[0].getBoundingClientRect().y<rows[1].getBoundingClientRect().y})()`,
    ),
    true,
    "Explicit newlines must create distinct layout rows",
  )
  await cdp.evaluate("window.__richRoot.querySelector('[data-cell-index=\"0\"] summary').click();true")
  await wait("!!window.__richRoot.querySelector('[data-cell-index=\"0\"] details pre')")
  assert.equal(
    await cdp.evaluate("window.__richRoot.querySelector('[data-cell-index=\"0\"] details pre').textContent.length"),
    16000,
  )
  await cdp.evaluate("window.__richRoot.querySelector('[data-cell-index=\"0\"] summary').click();true")
  await wait("!window.__richRoot.querySelector('details pre')")
  const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await writeFile("/tmp/notebook-rich-preview.png", Buffer.from(shot.data, "base64"))
  console.info(`[notebook-rich] bounded ${JSON.stringify(bounded)}`)
  console.info(
    "[notebook-rich] PASS MathML layout, viewport-only mounting, large hidden payload, local unknown/limit fallback, lazy bounded source, unchanged files",
  )
} finally {
  await cdp.evaluate('window.api.runDesktopMenuAction("window.close")').catch(() => {})
  cdp.close()
  await rm(dir, { recursive: true, force: true })
}
