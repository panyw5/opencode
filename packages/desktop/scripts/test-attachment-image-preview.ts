import { strict as assert } from "node:assert"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withCdp } from "./cdp"

const directory = process.env.OPENCODE_IMAGE_TEST_DIRECTORY
assert.ok(directory, "Set OPENCODE_IMAGE_TEST_DIRECTORY to a project with a working image-capable model")
const output = await mkdtemp(join(tmpdir(), "opencode-attachment-preview-"))
const filename = `unified-preview-${Date.now()}.png`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/(localhost|127\.0\.0\.1):\d+\//)
  assert.equal(await cdp.evaluate("!!window.api"), true)
  const preview = `document.querySelector('[data-component="image-preview"]')`
  const action = (name: string) => `${preview}.querySelector('[data-action="image-preview-${name}"]')`
  const wait = async (expression: string, timeout = 15_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await cdp.evaluate(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const click = async (expression: string) => {
    assert.equal(
      await cdp.evaluate(`(() => {const el=${expression}; if(!el) return false; el.click(); return true})()`),
      true,
    )
  }
  const sessionID = await cdp.evaluate<string>(`(async () => {
    const directory=${JSON.stringify(directory)};
    const server=await window.api.awaitInitialization(()=>{});
    const response=await fetch(server.url+'/session?directory='+encodeURIComponent(directory), {
      method:'POST', headers:{'content-type':'application/json',authorization:'Basic '+btoa(server.username+':'+server.password)},
      body:JSON.stringify({title:'Unified image preview verification'})
    });
    if(!response.ok) throw new Error('Session creation failed: '+response.status);
    const session=await response.json();
    return session.id;
  })()`)
  await cdp.evaluate(`(() => {
    const link=document.createElement('a');
    link.href='/'+btoa(${JSON.stringify(directory)}).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')+'/session/${sessionID}';
    document.body.append(link); link.click(); link.remove();
  })()`)
  console.log(`[attachment-preview-test] created isolated session=${sessionID}`)
  try {
    await wait(`!!document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]')`)
    const model = process.env.OPENCODE_IMAGE_TEST_MODEL
    if (model) {
      await click(`document.querySelector('[data-prompt-kind="main"] .prompt-pick[aria-haspopup="dialog"]')`)
      const option = `document.querySelector('[data-key="${model}"]')`
      await wait(`!!${option}`)
      await click(option)
    }
    const original = await cdp.evaluate<string>(`(() => {
      const canvas=document.createElement('canvas'); canvas.width=1200; canvas.height=800;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='#dce5ec'; ctx.fillRect(0,0,1200,800);
      ctx.fillStyle='#23475b'; ctx.font='64px serif'; ctx.fillText('Unified image preview',100,200);
      const src=canvas.toDataURL('image/png');
      const bytes=Uint8Array.from(atob(src.split(',')[1]),c=>c.charCodeAt(0));
      const data=new DataTransfer(); data.items.add(new File([bytes],${JSON.stringify(filename)},{type:'image/png'}));
      document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
      return src;
    })()`)
    const thumbnail = `document.querySelector('[data-action="preview-attachment"]:has(img[alt="${filename}"])')`
    await wait(`!!${thumbnail}`)
    await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: output })
    const verify = async (phase: string) => {
      await wait(`!!${preview}?.querySelector('img')?.naturalWidth`)
      assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1")
      await click(action("zoom-in"))
      assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1.25")
      await cdp.evaluate(`(() => {for(let i=0;i<30;i++) ${action("zoom-in")}.click()})()`)
      assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "4")
      assert.equal(await cdp.evaluate(`${action("zoom-in")}.disabled`), true)
      await wait(
        `${preview}.querySelector('[data-slot="image-preview-body"]').scrollWidth > ${preview}.querySelector('[data-slot="image-preview-body"]').clientWidth`,
      )
      await cdp.evaluate(`(() => {for(let i=0;i<30;i++) ${action("zoom-out")}.click()})()`)
      assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "0.25")
      assert.equal(await cdp.evaluate(`${action("zoom-out")}.disabled`), true)
      await click(action("reset"))
      await cdp.evaluate(
        `${preview}.querySelector('[data-slot="image-preview-body"]').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}))`,
      )
      assert.equal(await cdp.evaluate(`${preview}.dataset.zoom`), "1.25")
      await click(action("reset"))
      const destination = join(output, phase)
      await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: destination })
      await click(action("save"))
      const path = join(destination, filename)
      const deadline = Date.now() + 10_000
      while (!(await Bun.file(path).exists()) && Date.now() < deadline) await Bun.sleep(100)
      const file = Bun.file(path)
      assert.equal(await file.exists(), true, `${phase}: save must create a real image file`)
      assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), original.split(",")[1])
      for (const width of [1728, 430]) {
        await cdp.call("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await wait(
          `(() => {const r=${action("save")}.getBoundingClientRect();return r.width>0 && r.right<=innerWidth})()`,
        )
        const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
        await Bun.write(join(output, `${phase}-${width}.png`), Buffer.from(shot.data, "base64"))
      }
      await cdp.call("Emulation.clearDeviceMetricsOverride")
      await click(`${preview}.querySelector('[data-slot="image-preview-close"]')`)
      await wait(`!${preview}`)
      console.log(
        `[attachment-preview-test] ${phase}: zoom limits, wheel, reset, original download bytes and desktop/mobile layout passed`,
      )
    }
    await click(`${thumbnail}.querySelector('span')`)
    await verify("before-send")
    assert.equal(await cdp.evaluate(`!!${thumbnail}`), true)
    await cdp.evaluate(`document.querySelector('[data-prompt-kind="main"] [contenteditable="true"]').focus()`)
    await cdp.call("Input.insertText", { text: "Image preview verification. Reply briefly without using tools." })
    await wait(`document.querySelector('[data-prompt-kind="main"] [data-action="prompt-submit"]')?.disabled === false`)
    await click(`document.querySelector('[data-prompt-kind="main"] [data-action="prompt-submit"]')`)
    const sent = `document.querySelector('[data-slot="user-message-attachment"]:has(img[alt="${filename}"])')`
    await wait(`!!${sent}`)
    await wait(`!${thumbnail}`)
    await click(sent)
    await verify("after-send")
    await wait(
      `!!document.querySelector('[data-component="text-part"] [data-component="markdown"]')?.textContent?.trim()`,
      90_000,
    )
    const persisted = await cdp.evaluate<{ user: boolean; assistant: boolean }>(`(async()=>{
      const s=await window.api.awaitInitialization(()=>{});
      const r=await fetch(s.url+'/session/${sessionID}/message?directory='+encodeURIComponent(${JSON.stringify(directory)}),{headers:{authorization:'Basic '+btoa(s.username+':'+s.password)}});
      const messages=await r.json();
      return {user:messages.some(m=>m.info.role==='user' && m.parts.some(p=>p.type==='file' && p.filename===${JSON.stringify(filename)})),assistant:messages.some(m=>m.info.role==='assistant' && m.parts.some(p=>p.type==='text' && p.text.trim()))};
    })()`)
    assert.deepEqual(persisted, { user: true, assistant: true })
    console.log(`[attachment-preview-test] sidecar persisted image message and assistant reply; artifacts=${output}`)
  } finally {
    if (await cdp.evaluate(`!!${preview}`)) await click(`${preview}.querySelector('[data-slot="image-preview-close"]')`)
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await cdp.call("Browser.setDownloadBehavior", { behavior: "default" })
  }
})
