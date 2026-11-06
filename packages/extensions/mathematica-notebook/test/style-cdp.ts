import { strict as assert } from "node:assert"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { CdpClient, listTargets, pickPageTarget } from "../../../desktop/scripts/cdp"
import { editNotebook } from "../src/notebook"

const root = resolve(import.meta.dir, "../../../..")
const fixture = root + "/.artifacts/opencode-notebook-ui-test.nb"
await mkdir(root + "/.artifacts", { recursive: true })
await writeFile(
  fixture,
  editNotebook(await readFile(root + "/packages/extensions/mathematica-notebook/examples/demo.nb", "utf8"), [
    { index: 0, text: "Notebook CSS recovery fixture" },
  ]),
)
const before = await listTargets()
const original = pickPageTarget(before)!
const main = await CdpClient.connect(original.webSocketDebuggerUrl)
await main.evaluate('window.api.runDesktopMenuAction("window.new")')
main.close()
const until = Date.now() + 30_000
let target: (typeof before)[number] | undefined
while (!target) {
  target = (await listTargets()).find((entry) => entry.type === "page" && !before.some((old) => old.id === entry.id))
  if (Date.now() > until) throw new Error("Test window did not open")
  if (!target) await Bun.sleep(100)
}
const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
const wait = async (expression: string, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`CDP condition timed out: ${expression}`)
}
const openFixture = () =>
  cdp.evaluate(`(() => {
  const page=document.querySelector('[data-component=session-page]');if(!page)return false;
  const a=document.createElement('a');a.dataset.fileLink='';a.dataset.path=${JSON.stringify(fixture)};a.href='#';page.append(a);a.click();a.remove();return true;
})()`)
try {
  await wait(
    "document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.call("Network.enable")
  await cdp.call("Network.setCacheDisabled", { cacheDisabled: true })
  await cdp.call("Network.setBlockedURLs", { urls: ["*extension-asset*local.mathematica-notebook*index.css*"] })
  await cdp.call("Page.navigate", { url: "http://localhost:5173/index.html?styleRegression=" + Date.now() })
  await wait(
    "location.search.includes('styleRegression=') && document.readyState==='complete' && !!window.api && !!document.querySelector('[data-component=app-root]')",
  )
  await cdp.evaluate("window.api.showWindow()")
  await cdp.evaluate(
    `(() => {const a=document.createElement('a');a.href='/'+btoa(${JSON.stringify(root)}).replace(/=/g,'')+'/session';document.body.append(a);a.click();a.remove();return true})()`,
  )
  await wait("!!document.querySelector('[data-component=session-page]')")
  await openFixture()
  await wait("[...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='Retry extension')")
  assert.equal(await cdp.evaluate("document.querySelectorAll('.oc-nb').length"), 0, "Unstyled notebook must not mount")
  assert.equal(
    await cdp.evaluate("document.querySelectorAll('link[data-extension=\"local.mathematica-notebook\"]').length"),
    0,
    "Failed stylesheet links must be removed",
  )
  console.log("[notebook-style-cdp] PASS: blocked CSS stops activation; no duplicated code layers")
  await cdp.call("Network.setBlockedURLs", { urls: [] })
  await cdp.evaluate(
    "[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Retry extension').click();true",
  )
  await wait(
    "document.querySelector('.oc-nb [data-cell-index=\"0\"] textarea')?.value==='Notebook CSS recovery fixture'",
  )
  const recovered = await cdp.evaluate<{ toolbar: string; mirror: string; links: number; cells: number }>(`(() => {
    const root=document.querySelector('.oc-nb');return {toolbar:getComputedStyle(root.closest('[data-extension]').querySelector('.oc-nb-toolbar')).display,mirror:getComputedStyle(root.querySelector('.oc-nb-highlight')).position,links:[...document.querySelectorAll('link[data-extension="local.mathematica-notebook"]')].filter(x=>!!x.sheet).length,cells:root.querySelectorAll('.oc-nb-cell').length};
  })()`)
  assert.equal(recovered.toolbar, "flex")
  assert.equal(recovered.mirror, "absolute")
  assert.equal(recovered.links, 1)
  assert.equal(recovered.cells, 5)
  console.log("[notebook-style-cdp] PASS: retry reloads stylesheet and restores notebook layout")
  const stale = await cdp.evaluate(`(async()=>{
    const href=document.querySelector('link[data-extension="local.mathematica-notebook"]').href;
    const parts=new URL(href);const path=parts.pathname.split('/');path[path.length-2]='0.0.0-missing';parts.pathname=path.join('/');
    const {addExtensionStyle}=await import(${JSON.stringify("/@fs" + root + "/packages/app/src/extensions/activation.ts")});
    try {const remove=await addExtensionStyle(parts.href,'local.mathematica-notebook',{timeoutMs:1000});remove();return {rejected:false}}
    catch(error){return {rejected:error.name==='ExtensionStyleLoadError',links:document.querySelectorAll('link[data-extension="local.mathematica-notebook"]').length}}
  })()`)
  assert.deepEqual(stale, { rejected: true, links: 1 })
  console.log("[notebook-style-cdp] PASS: stale fingerprint returns 404 and is rejected without removing healthy CSS")
  process.env.OPENCODE_CDP_TARGET_ID = target.id
  await import(root + "/packages/extensions/mathematica-notebook/test/cdp.ts")
  const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
  await writeFile("/tmp/notebook-style-recovered.png", Buffer.from(shot.data, "base64"))
} finally {
  await cdp.call("Network.setBlockedURLs", { urls: [] }).catch(() => {})
  await cdp
    .evaluate(
      `(async()=>{
    const c=await window.api.awaitInitialization();
    await window.api.fetchExternal(c.url+'/extension/local.mathematica-notebook/rpc/kernel.stop',{
      method:'POST',headers:{Authorization:'Basic '+btoa(c.username+':'+c.password),'Content-Type':'application/json'},
      body:JSON.stringify({input:{path:${JSON.stringify(fixture)}}})
    });return true;
  })()`,
    )
    .catch(() => {})
  await cdp.evaluate('window.api.runDesktopMenuAction("window.close")').catch(() => {})
  cdp.close()
  await rm(fixture, { force: true })
}
