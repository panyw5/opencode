// Open a populated Share session dialog in the dev app before running this check.
import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withCdp } from "./cdp"
import { shareImageLayouts } from "../../app/src/components/session/session-share-layout"

const folder = process.argv[2] ?? "/tmp/opencode-share-layout"
await mkdir(folder, { recursive: true })
await withCdp(async (client, target) => {
  assert.ok(target.url.includes("localhost:5173"), "development renderer only")
  assert.ok(await client.evaluate(`!!document.querySelector('.session-share-paper')`), "Open Share session first")
  const toggleMenu = async () => {
    const point = await client.evaluate<{ x: number; y: number }>(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r=document.querySelector('[data-action="share-image-export"]').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    await client.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
  }
  const closeMenu = async () => {
    if (
      !(await client.evaluate(
        `document.querySelector('[data-action="share-image-export"]')?.getAttribute('aria-expanded') === 'true'`,
      ))
    )
      return
    await client.call("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
    await client.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    })
  }
  if (await client.evaluate(`!!document.querySelector('[data-share-layout]')`)) await closeMenu()
  try {
    for (const viewport of [390, 768, 1440]) {
      await client.call("Emulation.setDeviceMetricsOverride", {
        width: viewport,
        height: 1024,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await toggleMenu()
      assert.equal(
        await client.evaluate(`document.querySelectorAll('[data-share-layout]').length`),
        shareImageLayouts.length,
      )
      assert.equal(await client.evaluate(`!!document.querySelector('.session-share-settings select')`), false)
      for (const layout of shareImageLayouts) {
        const result = await client.evaluate<{
          width: number
          font: number
          available: number
          visible: number
          overflow: number
          html: string
        }>(`(async () => {
          document.querySelectorAll('.session-share-pane-switch button')[1].click();
          document.querySelector('[data-share-layout="${layout.id}"]').focus();
          const { shareHTML, waitForShareRender } = await import('/@fs' + ${JSON.stringify(join(import.meta.dir, "../../app/src/components/session/session-share-html.ts"))});
          const paper = document.querySelector('.session-share-paper');
          await waitForShareRender(paper);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const scroll = document.querySelector('.session-share-paper-scroll');
          for (let attempt=0; attempt<30; attempt++) {
            if(paper.getBoundingClientRect().width>0 && paper.getBoundingClientRect().width<=scroll.clientWidth+1 && scroll.scrollWidth<=scroll.clientWidth+1) break;
            await new Promise(resolve=>requestAnimationFrame(resolve));
          }
          return {width:paper.offsetWidth, font:parseFloat(getComputedStyle(paper.querySelector('[data-component="markdown"]')).fontSize),
            available:scroll.clientWidth, visible:paper.getBoundingClientRect().width, overflow:scroll.scrollWidth-scroll.clientWidth,
            html:${viewport} === 1440 ? await shareHTML(paper, 'light') : ''};
        })()`)
        assert.equal(result.width, layout.width)
        assert.ok(Math.abs(result.font - (16 * layout.width) / layout.viewport) < 0.01)
        assert.ok(
          result.visible > 0 && result.visible <= result.available + 1,
          `Preview fits window: ${JSON.stringify({ viewport, layout: layout.id, visible: result.visible, available: result.available })}`,
        )
        assert.ok(result.overflow <= 1, "No horizontal preview overflow")
        if (result.html) await writeFile(join(folder, `${layout.id}.html`), result.html)
        console.log(
          `[share-layout-test] viewport=${viewport} layout=${layout.id} width=${result.width} font=${result.font} preview=${result.visible}`,
        )
      }
      await closeMenu()
    }
  } finally {
    await client.call("Emulation.clearDeviceMetricsOverride")
    if (!(await client.evaluate(`!!document.querySelector('[data-share-layout]')`))) await toggleMenu()
    await client.evaluate(`document.querySelector('[data-share-layout="phone-hd"]')?.focus()`)
    await closeMenu()
  }
})
console.log(`[share-layout-test] snapshots=${folder}`)
