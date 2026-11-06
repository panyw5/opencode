import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { CdpClient, listTargets, pickPageTarget } from "../../../desktop/scripts/cdp"

const root = resolve(import.meta.dir, "../../../..")
await mkdir(join(root, ".artifacts"), { recursive: true })
const dir = await mkdtemp(join(root, ".artifacts/nb-self-preview-"))
const file = join(dir, "preview.nb")
const notebook = (value: string) => `Notebook[{Cell["${value}","Text"],Cell[BoxData["2+2"],"Input"]}]`
await writeFile(file, notebook("original"))
const logDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/log")
const logs = (await readdir(logDir))
  .filter((name) => /^\d{4}-\d{2}-\d{2}T\d{6}\.log$/.test(name))
  .sort()
  .reverse()
assert.ok(logs[0], "Backend log is required")
const logPath = join(logDir, logs[0])
const beforeLog = await readFile(logPath, "utf8")
const sourceReads = async () =>
  (await readFile(logPath, "utf8"))
    .slice(beforeLog.length)
    .split("\n")
    .filter(
      (line) =>
        line.includes("service=file ") &&
        line.includes("status=started") &&
        line.includes("nb-self-preview-") &&
        line.includes("preview.nb read"),
    ).length
const before = await listTargets()
const original = pickPageTarget(before)
assert.ok(original?.url.includes("localhost:5173"), "Development Electron on 9222 is required")
const main = await CdpClient.connect(original.webSocketDebuggerUrl)
await main.evaluate('window.api.runDesktopMenuAction("window.new")')
main.close()
const deadline = Date.now() + 30_000
let target: (typeof before)[number] | undefined
while (!target) {
  target = (await listTargets()).find((item) => item.type === "page" && !before.some((old) => old.id === item.id))
  if (Date.now() > deadline) throw new Error("Self-preview window did not open")
  if (!target) await Bun.sleep(100)
}
const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
const wait = async (expression: string, timeout = 60_000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Self-preview timeout: ${expression}`)
}
try {
  await wait(
    "document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.evaluate("window.api.showWindow()")
  await cdp.evaluate(
    `(()=>{const a=document.createElement('a');a.href='/'+btoa(${JSON.stringify(root)}).replace(/=/g,'')+'/session';document.body.append(a);a.click();a.remove();return true})()`,
  )
  await wait("!!document.querySelector('[data-component=session-page]')")
  await cdp.evaluate(
    `(()=>{const p=document.querySelector('[data-component=session-page]');const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(file)};a.href='#';p.append(a);a.click();a.remove();return true})()`,
  )
  await wait(
    `[...document.querySelectorAll('.oc-nb')].some(r=>r.dataset.notebookPath===${JSON.stringify(file)} && r.querySelector('textarea')?.value==='original')`,
  )
  await cdp.evaluate(
    `window.__nbSelf=[...document.querySelectorAll('.oc-nb')].find(r=>r.dataset.notebookPath===${JSON.stringify(file)});window.__nbSelfToolbar=window.__nbSelf.closest('[data-extension]').querySelector('.oc-nb-toolbar');true`,
  )
  assert.equal(await sourceReads(), 0, "Opening self viewer must not preload source")
  await cdp.evaluate(
    "window.__nbSelfFirst=window.__nbSelf.querySelector('textarea');[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Reload').click();true",
  )
  await cdp.evaluate("new Promise(resolve=>setTimeout(resolve,250))")
  assert.equal(
    await cdp.evaluate("window.__nbSelf.querySelector('textarea')===window.__nbSelfFirst"),
    true,
    "Unchanged reload must preserve the editor DOM",
  )
  await cdp.evaluate(
    "(()=>{const f=window.__nbSelf.querySelector('textarea');f.value='discard this draft';f.dispatchEvent(new Event('input',{bubbles:true}));[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Discard & reload').click();return true})()",
  )
  await wait("window.__nbSelf.querySelector('textarea')?.value==='original'")
  await writeFile(file, notebook("external"))
  await wait("window.__nbSelf.querySelector('textarea')?.value==='external'")
  assert.equal(await cdp.evaluate("window.__nbSelf.isConnected"), true, "External change must not remount viewer")
  assert.equal(await sourceReads(), 0, "External change must notify without ordinary source read")
  await cdp.evaluate(
    "(()=>{const f=window.__nbSelf.querySelector('textarea');f.value='unsaved draft';f.dispatchEvent(new Event('input',{bubbles:true}));return true})()",
  )
  await cdp.evaluate(
    "[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Source').click();true",
  )
  assert.equal(
    await cdp.evaluate(
      "window.__nbSelf.isConnected && window.__nbSelf.querySelector('textarea').value==='unsaved draft'",
    ),
    true,
    "Dirty Source switch must keep draft",
  )
  await writeFile(file, notebook("changed again"))
  await wait("window.__nbSelf.querySelector('[role=status]')?.textContent.includes('draft')")
  assert.equal(await cdp.evaluate("window.__nbSelf.querySelector('textarea').value"), "unsaved draft")
  await cdp.evaluate(
    "[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save *').click();true",
  )
  await wait("window.__nbSelf.querySelector('[role=alert]')?.textContent.includes('changed on disk')")
  assert.equal(await readFile(file, "utf8"), notebook("changed again"), "Conflict must not overwrite external edits")
  await cdp.evaluate(
    "[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Discard & reload').click();true",
  )
  await wait("window.__nbSelf.querySelector('textarea')?.value==='changed again'")
  assert.equal(await sourceReads(), 0, "Reload/save conflict must still avoid host source loading")
  await cdp.evaluate(
    "[...window.__nbSelfToolbar.querySelectorAll('button')].find(x=>x.textContent.trim()==='Source').click();true",
  )
  await wait("!window.__nbSelf.isConnected")
  await wait("!!document.querySelector('[data-component=file]')")
  assert.equal(await sourceReads(), 1, "Source must lazily perform one ordinary read")
  console.info(
    "[notebook-self-preview] PASS zero source preload, external change, stable viewer, dirty guard, conflict protection, Source lazy read=1",
  )
} finally {
  await cdp.evaluate('window.api.runDesktopMenuAction("window.close")').catch(() => {})
  cdp.close()
  await rm(dir, { recursive: true, force: true })
}
