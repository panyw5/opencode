import { strict as assert } from "node:assert"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Run with this repository open in the dev Electron renderer on CDP :9222.
const directory = resolve(import.meta.dir, "../../..")
const folder = `node_modules/.cache/preview-tabs-${Date.now()}`
const files = ["first", "second"].map((name) => ({ path: `${folder}/${name}.md`, heading: `Preview tabs ${name}` }))
const log = (message: string) => console.log(`[preview-tabs-test] ${message}`)

await mkdir(resolve(directory, folder), { recursive: true })
try {
  for (const file of files)
    await Bun.write(resolve(directory, file.path), `# ${file.heading}\n\nDistinct ${file.heading} content.\n`)
  await withCdp(async (cdp, target) => {
    assert.match(target.url, /^http:\/\/localhost:5173\//)
    const selector = (path: string) => `.session-file-tab-trigger[data-value=${JSON.stringify(`file://${path}`)}]`
    const tab = (path: string) => `${selector(path)} [role="tab"]`
    const wait = async (expression: string, label: string) => {
      const deadline = Date.now() + 10_000
      while (!(await cdp.evaluate<boolean>(expression))) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
        await Bun.sleep(100)
      }
    }
    const click = async (query: string, button = "left") => {
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(query)})?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`,
      )
      await Bun.sleep(150)
      const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const element = document.querySelector(${JSON.stringify(query)});
        if (!element) throw Error('Missing click target');
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) throw Error('Hidden click target');
        if (!element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))) throw Error('Click target is clipped or covered');
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      })()`)
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount: 1 })
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount: 1 })
    }
    const press = async (key: string) => {
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code: key })
    }
    const selected = async (file: (typeof files)[number]) => {
      await wait(
        `document.querySelector(${JSON.stringify(tab(file.path))})?.getAttribute('aria-selected') === 'true'
          && [...document.querySelectorAll('#session-side-panel [role="tabpanel"] h1')].some(el => el.textContent === ${JSON.stringify(file.heading)})`,
        `selected tab and sidecar-rendered content match ${file.path}`,
      )
      assert.notEqual(
        await cdp.evaluate(`document.querySelector(${JSON.stringify(tab(file.path))}).getAttribute('tabindex')`),
        null,
        "tab is registered in the tabs collection, not the context-menu collection",
      )
      log(`PASS selected and rendered path=${file.path}`)
    }
    try {
      await cdp.evaluate(`(() => {
        window.__previewTabsLogs = [];
        window.__previewTabsDebug = console.debug;
        console.debug = (...args) => {
          const line = args.map(String).join(' ');
          if (line.startsWith('[file-preview]') || line.startsWith('[file-content]')) window.__previewTabsLogs.push(line);
          window.__previewTabsDebug(...args);
        };
      })()`)
      for (const file of files) {
        log(`open fixture path=${file.path}`)
        await cdp.evaluate(
          `window.dispatchEvent(new CustomEvent('opencode:presentation-source', {detail:{sessionID:document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id') ?? undefined,path:${JSON.stringify(file.path)}}}))`,
        )
        await selected(file)
      }
      for (let round = 0; round < 2; round++) {
        for (const file of files) {
          await click(tab(file.path))
          await selected(file)
        }
      }
      log("PASS real mouse switches both Markdown previews repeatedly")

      await click(tab(files[0].path))
      await press("ArrowRight")
      await selected(files[1])
      await press("ArrowLeft")
      await selected(files[0])
      log("PASS keyboard navigation uses the surrounding tabs collection")

      const drag = async (from: (typeof files)[number], to: (typeof files)[number]) => {
        await cdp.evaluate(
          `document.querySelector(${JSON.stringify(tab(from.path))}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`,
        )
        await Bun.sleep(150)
        const points = await cdp.evaluate<{ start: { x: number; y: number }; end: { x: number; y: number } }>(`(() => {
          const center = query => {
            const el = document.querySelector(query);
            const rect = el.getBoundingClientRect();
            const point = {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
            if (!el.contains(document.elementFromPoint(point.x,point.y))) throw Error('Drag target is clipped or covered');
            return point;
          };
          return {start:center(${JSON.stringify(tab(from.path))}),end:center(${JSON.stringify(tab(to.path))})};
        })()`)
        log(`drag start path=${from.path} target=${to.path}`)
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...points.start })
        await cdp.call("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...points.start,
          button: "left",
          clickCount: 1,
        })
        try {
          await Bun.sleep(350)
          await cdp.call("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: points.start.x + 12,
            y: points.start.y,
            button: "left",
            buttons: 1,
          })
          await wait(`!!document.querySelector('[data-component="tabs-drag-preview"]')`, "drag preview mounted")
          const preview = await cdp.evaluate<{
            text: string
            z: number
            pointer: string
            width: number
            height: number
          }>(`(() => {
            const el = document.querySelector('[data-component="tabs-drag-preview"]');
            const label = el.querySelector('span');
            const style = getComputedStyle(el.parentElement);
            const rect = label.getBoundingClientRect();
            return {text:label.textContent,z:Number(style.zIndex),pointer:style.pointerEvents,width:rect.width,height:rect.height};
          })()`)
          assert.equal(preview.text, from.path.split("/").at(-1))
          assert.ok(preview.z > 0 && preview.z < 50, "drag label paints above the composited page but below dialogs")
          assert.equal(preview.pointer, "none", "drag overlay must not intercept pointer input")
          assert.ok(preview.width > 0 && preview.height > 0, "drag label retains visible dimensions")
          const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
          await Bun.write("/tmp/opencode-file-tab-drag.png", Buffer.from(shot.data, "base64"))
          for (let step = 1; step <= 8; step++) {
            await cdp.call("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: points.start.x + ((points.end.x - points.start.x) * step) / 8,
              y: points.end.y,
              button: "left",
              buttons: 1,
            })
          }
        } finally {
          await cdp.call("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...points.end,
            button: "left",
            clickCount: 1,
          })
        }
        await wait(
          `!document.querySelector('[data-component="tabs-drag-preview"]')`,
          "drag preview removed after release",
        )
        assert.equal(await cdp.evaluate(`document.querySelectorAll('#session-side-panel .opacity-0').length`), 0)
        const order = await cdp.evaluate<string[]>(
          `[...document.querySelectorAll('.session-file-tab-trigger')].map(el=>el.getAttribute('data-value')).filter(value=>value.includes(${JSON.stringify(folder)}))`,
        )
        assert.deepEqual(
          order,
          (points.start.x < points.end.x ? [to, from] : [from, to]).map((file) => `file://${file.path}`),
        )
        log("PASS drag label remains visible, tab reorders and release restores the source label")
      }
      await drag(files[0], files[1])
      await drag(files[0], files[1])

      log("open file context menu")
      // Avoid the macOS native context-menu input acknowledgement blocking CDP.
      await cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(tab(files[0].path))});
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2,clientX:rect.x+20,clientY:rect.y+20}));
        return true;
      })()`)
      await wait(
        `!!document.querySelector('[data-component="context-menu-content"] [role="menuitem"]')`,
        "file context menu",
      )
      assert.equal(
        await cdp.evaluate(
          `document.querySelectorAll('[data-component="context-menu-content"] [role="menuitem"]').length`,
        ),
        3,
      )
      await press("Escape")
      await click(tab(files[1].path))
      await selected(files[1])
      log("PASS context menu still works and does not break subsequent selection")

      const lines = await cdp.evaluate<string[]>("window.__previewTabsLogs")
      for (const file of files) {
        assert.ok(lines.some((line) => line.includes(`[file-content] load-start`) && line.includes(file.path)))
        assert.ok(lines.some((line) => line.includes(`[file-preview] tab select activated tab=file://${file.path}`)))
      }
      log("PASS file load and tab activation diagnostics recorded for both files")

      await click(`${selector(files[1].path)} [data-slot="tabs-trigger-close-button"] button`)
      await wait(`!document.querySelector(${JSON.stringify(tab(files[1].path))})`, "close button removes second tab")
      await selected(files[0])
      await click(tab(files[0].path), "middle")
      await wait(`!document.querySelector(${JSON.stringify(tab(files[0].path))})`, "middle click removes first tab")
      log("PASS close button, adjacent-tab fallback and middle-click close")

      log("send sidecar shell test message")
      const messages = await cdp.evaluate<{ sent: boolean; received: boolean }>(`(async () => {
        const server = await window.api.awaitInitialization();
        const headers = {'Content-Type':'application/json', 'x-opencode-directory':encodeURIComponent(${JSON.stringify(directory)}), Authorization:'Basic '+btoa((server.username || 'opencode')+':'+server.password)};
        const request = async (path, method='GET', body) => {
          const response = await fetch(server.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
          if (!response.ok) throw Error('sidecar '+response.status+' '+path);
          return response.status===204?null:response.json();
        };
        const session = await request('/session','POST',{title:'File preview tab switching regression'});
        console.debug('[file-preview] sidecar test created session='+session.id);
        try {
          await request('/session/'+session.id+'/shell','POST',{agent:'build',command:'printf PREVIEW_TABS_SIDECAR_OK'});
          const messages = await request('/session/'+session.id+'/message');
          console.debug('[file-preview] sidecar test messages received count='+messages.length);
          return {sent:messages.some(m=>m.info.role==='user'),received:messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.type==='tool'&&p.state.status==='completed'&&p.state.output.includes('PREVIEW_TABS_SIDECAR_OK')))};
        } finally { await request('/session/'+session.id,'PATCH',{time:{archived:Date.now()}}); }
      })()`)
      assert.equal(messages.sent, true)
      assert.equal(messages.received, true)
      log("PASS sidecar message sent and response received")
    } finally {
      await cdp.evaluate(`(() => {
        for (const path of ${JSON.stringify(files.map((file) => file.path))}) {
          const wrapper = [...document.querySelectorAll('.session-file-tab-trigger')].find(el => el.getAttribute('data-value') === 'file://'+path);
          wrapper?.querySelector('[data-slot="tabs-trigger-close-button"] button')?.click();
        }
        if (window.__previewTabsDebug) console.debug = window.__previewTabsDebug;
        delete window.__previewTabsDebug;
        delete window.__previewTabsLogs;
      })()`)
    }
  })
} finally {
  await rm(resolve(directory, folder), { recursive: true, force: true })
}
