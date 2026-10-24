import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

type Tracking = {
  samples: Array<{ residual: number; message: string; line: string; scrollTop: number }>
  writes: number
  stageChanges: number
  heightChanges: number
  glyphSamples: number
  longTasks: number[]
  environment?: unknown
  maxResidual: number
}

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  await cdp.call("Page.reload")
  await Bun.sleep(2000)
  await cdp.call("Page.enable")
  await cdp.call("Page.bringToFront")
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  const socket = (cdp as unknown as { socket: WebSocket }).socket
  let navigationCount = 0
  const onProtocol = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data))
    if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) navigationCount++
  }
  socket.addEventListener("message", onProtocol)
  const fixture = `/@fs${resolve(import.meta.dir, "quick-assistant-scroll-fixture.tsx")}`
  const report: { readiness: unknown[]; phases: Array<{ name: string } & Tracking>; error?: string } = {
    readiness: [],
    phases: [],
  }
  const inspect = () =>
    cdp.evaluate<{
      top: number
      height: number
      client: number
      stages: string[]
      math: number
      nodes: number
      headings: number
      x: number
      y: number
    }>(`(() => {
    const host = document.querySelector('[data-quick-scroll-fixture]');
    const view = host.querySelector('[data-component="quick-assistant-viewport"]');
    const box = view.getBoundingClientRect();
    return { top: view.scrollTop, height: view.scrollHeight, client: view.clientHeight,
      x: box.x+box.width/2, y: box.y+box.height/2, nodes: host.querySelectorAll('*').length,headings:host.querySelectorAll('h2').length,
      stages: [...host.querySelectorAll('[data-component="markdown"]')].map(e=>e.dataset.markdownRenderedStage),
      math: host.querySelectorAll('.katex-display').length };
  })()`)
  const mount = async () => {
    report.readiness.push(
      await cdp.evaluate(`(async () => {
      window.__quickScrollFixture?.dispose();
      window.__quickScrollModule = await import(${JSON.stringify(fixture)});
      const started = performance.now();
      const longTasks=[];
      const observer=new PerformanceObserver(entries=>{for(const entry of entries.getEntries())longTasks.push(entry.duration)});
      observer.observe({type:'longtask'});
      window.__quickScrollFixture = window.__quickScrollModule.mountQuickAssistantScrollFixture();
      let firstContentMs;
      let visibleMathMs;
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
        const host = document.querySelector('[data-quick-scroll-fixture]');
        if (firstContentMs === undefined && host.querySelector('[data-source-line]')) firstContentMs = performance.now()-started;
        const view = host.querySelector('[data-component="quick-assistant-viewport"]');
        const box = view.getBoundingClientRect();
        const visible = [...host.querySelectorAll('[data-component="markdown"]')].filter(e => {
          const r=e.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom;
        });
        if (visible.length && visible.every(e=>e.dataset.markdownRenderedStage==='full') && host.querySelector('.katex-display')) {
          visibleMathMs = performance.now()-started;break;
        }
      }
      for(const entry of observer.takeRecords())longTasks.push(entry.duration);
      observer.disconnect();
      const host=document.querySelector('[data-quick-scroll-fixture]');
      return { firstContentMs, visibleMathMs, longTasks,nodesAtVisibleReady:host.querySelectorAll('*').length };
    })()`),
    )
    await Bun.sleep(350)
    const initial = await inspect()
    assert.ok(initial.height > initial.client * 5, "fixture must overflow several screens")
    assert.ok(
      initial.stages.includes("lite") || initial.stages.includes("structure"),
      "offscreen replies must remain lazy",
    )
    assert.ok(initial.math < 120, "initial mount must not typeset all offscreen formulas")
    assert.equal(initial.headings, 60, "fixture must contain actual Markdown headings, not literal escaped newlines")
    assert.equal(
      await cdp.evaluate(
        "getComputedStyle(document.querySelector('[data-quick-scroll-fixture] [data-component=quick-assistant-viewport]')).overflowAnchor",
      ),
      "none",
    )
    console.log(
      `[quick-scroll-test] mounted math=${initial.math} nodes=${initial.nodes} stages=${initial.stages.join(",")}`,
    )
  }
  const begin = (wheel = false) =>
    cdp.evaluate(
      `window.__quickScrollTrack = window.__quickScrollModule.trackQuickAssistantScrollFixture({wheel:${wheel}}); true`,
    )
  const end = async (name: string, requiresResize = false) => {
    await Bun.sleep(300)
    const tracked = await cdp.evaluate<Tracking>("window.__quickScrollTrack()")
    tracked.environment = await cdp.evaluate(`(() => {
      const host=document.querySelector('[data-quick-scroll-fixture]');const view=host?.querySelector('[data-component=quick-assistant-viewport]');
      return {visibility:document.visibilityState,focused:document.hasFocus(),innerWidth,innerHeight,hostConnected:host?.isConnected,hostWidth:host?.getBoundingClientRect().width,viewportWidth:view?.getBoundingClientRect().width};
    })()`)
    report.phases.push({ name, ...tracked })
    assert.equal(navigationCount, 0, "renderer navigation/HMR invalidated the run")
    console.log(
      `[quick-scroll-test] phase=${name} frames=${tracked.samples.length} maxResidual=${tracked.maxResidual.toFixed(3)} writes=${tracked.writes} stages=${tracked.stageChanges} heights=${tracked.heightChanges} env=${JSON.stringify(tracked.environment)}`,
    )
    assert.ok(tracked.samples.length >= 10, `not enough anchor frames for ${name}`)
    if (requiresResize) assert.ok(tracked.heightChanges > 0, `phase ${name} did not actually change layout`)
    assert.ok(tracked.maxResidual <= 2, `semantic content jumped in ${name}: ${tracked.maxResidual}px`)
  }
  const seek = async (index: number) => {
    await cdp.evaluate(`(() => {
      const host=document.querySelector('[data-quick-scroll-fixture]');
      const view=host.querySelector('[data-component="quick-assistant-viewport"]');
      view.dispatchEvent(new WheelEvent('wheel',{deltaY:-1}));
      const message=host.querySelector('[data-message-id="scroll_fixture_${index}"]');
      const block=[...message.querySelectorAll('[data-source-line]')].find(e=>e.textContent.startsWith('The paired vectors')&&e.textContent.includes('Read marker ${index}.6'));
      if(!block) throw Error('reading source block missing');
      view.scrollTop += block.getBoundingClientRect().top-view.getBoundingClientRect().top-80;
      return true;
    })()`)
    await Bun.sleep(600)
  }
  const wheel = async (deltaY: number) => {
    const geometry = await inspect()
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: geometry.x, y: geometry.y, deltaX: 0, deltaY })
  }
  try {
    await mount()
    await seek(3)
    await seek(5)
    await begin()
    await cdp.evaluate("window.__quickScrollFixture.formula(5,true); true")
    await Bun.sleep(500)
    await end("inside-message-grow", true)
    await begin()
    await cdp.evaluate("window.__quickScrollFixture.formula(5,false); true")
    await Bun.sleep(500)
    await end("inside-message-shrink", true)
    await begin()
    await cdp.evaluate("window.__quickScrollFixture.formula(3,true); true")
    await Bun.sleep(500)
    await end("above-message-grow", true)
    await begin()
    await cdp.evaluate("window.__quickScrollFixture.append(11); true")
    await Bun.sleep(500)
    await end("below-message-append", true)
    for (const width of [520, 1040, 520, 1040]) {
      await begin()
      await cdp.evaluate(`window.__quickScrollFixture.resize(${width}); true`)
      await Bun.sleep(600)
      await end(`width-${width}`, true)
    }
    for (let cycle = 0; cycle < Number(Bun.env.OPENCODE_QUICK_SCROLL_CYCLES ?? 3); cycle++) {
      await mount()
      await begin(true)
      for (let step = 0; step < 34; step++) {
        await wheel(-450)
        await Bun.sleep(55)
      }
      for (let step = 0; step < 18; step++) {
        await wheel(step % 2 ? 500 : -500)
        await Bun.sleep(30)
      }
      for (let step = 0; step < 34; step++) {
        await wheel(450)
        await Bun.sleep(55)
      }
      await end(`wheel-cycle-${cycle}`, true)
    }
    for (let step = 0; step < 60; step++) {
      const geometry = await inspect()
      if (geometry.height - geometry.client - geometry.top <= 1) break
      await wheel(1000)
      await Bun.sleep(35)
    }
    await cdp.evaluate("window.__quickScrollFixture.append(11); true")
    await Bun.sleep(500)
    const followed = await inspect()
    assert.ok(
      Math.abs(followed.height - followed.client - followed.top) <= 1,
      "bottom follow must remain pinned after new output",
    )
    console.log("[quick-scroll-test] PASS bottom following after append")
    await seek(7)
    for (const open of [true, false, true, false]) {
      await begin()
      await cdp.evaluate(`(() => {
        const details=document.querySelector('[data-quick-scroll-fixture] [data-message-id=scroll_fixture_6] details');
        if(!details)throw Error('context disclosure missing');
        if(details.open!==${open})details.querySelector('summary').click();
        return true;
      })()`)
      await Bun.sleep(500)
      await end(`context-${open ? "expand" : "collapse"}`, true)
    }
    await begin()
    await cdp.evaluate("window.__quickScrollFixture.busy(true); window.__quickScrollFixture.append(11); true")
    await Bun.sleep(500)
    await end("stream-tail-while-reading", true)
    await cdp.evaluate("window.__quickScrollFixture.busy(false); true")
    await cdp.evaluate("window.__quickScrollFixture.paragraph(7); true")
    await Bun.sleep(600)
    await cdp.evaluate(`(() => {
      const view=document.querySelector('[data-quick-scroll-fixture] [data-component="quick-assistant-viewport"]');
      view.dispatchEvent(new WheelEvent('wheel',{deltaY:-1}));
      const block=view.querySelector('[data-message-id="scroll_fixture_7"] [data-source-line]');
      const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode;const index=node.textContent.indexOf('INLINE_MARKER_80');
        if(index<0)continue;
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);
        view.scrollTop+=range.getBoundingClientRect().top-view.getBoundingClientRect().top-80;return true;
      }
      throw Error('inline prose marker missing');
    })()`)
    await Bun.sleep(300)
    for (const width of [520, 1040, 520, 1040]) {
      await begin()
      await cdp.evaluate(`window.__quickScrollFixture.resize(${width}); true`)
      await Bun.sleep(600)
      await end(`paragraph-character-width-${width}`, true)
      assert.ok(report.phases.at(-1)!.glyphSamples > 0, "paragraph regression must track actual text character ranges")
    }
    for (const size of [18, 15]) {
      await begin()
      await cdp.evaluate(`window.__quickScrollFixture.font(${size}); true`)
      await Bun.sleep(600)
      await end(`paragraph-font-${size}`, true)
      assert.ok(report.phases.at(-1)!.glyphSamples > 0, "font regression must track text character ranges")
    }
    for (const width of [520, 1040]) {
      const gap = await cdp.evaluate(`(() => {
        const view=document.querySelector('[data-quick-scroll-fixture] [data-component="quick-assistant-viewport"]');
        const block=view.querySelector('[data-message-id=scroll_fixture_7] [data-source-line]');
        const original=view.scrollTop;const viewport=view.getBoundingClientRect();const box=block.getBoundingClientRect();
        const y=viewport.top+view.clientTop+Math.min(80,view.clientHeight/3);const x=box.left+Math.min(24,box.width*.15);
        for(let delta=0;delta<32;delta++) {
          view.scrollTop=original+delta;
          const caret=document.caretRangeFromPoint(x,y);if(!caret||caret.startContainer.nodeType!==3)continue;
          const node=caret.startContainer;if(node.parentElement.closest('.katex')||!node.length)continue;
          const range=document.createRange();range.setStart(node,Math.min(caret.startOffset,node.length-1));range.setEnd(node,Math.min(caret.startOffset,node.length-1)+1);
          const rect=range.getBoundingClientRect();const distance=Math.max(rect.top-y,y-rect.bottom,0);
          if(distance>3)return {distance,delta};
        }
        throw Error('could not establish an interline reading gap');
      })()`)
      console.log(`[quick-scroll-test] interline gap ${JSON.stringify(gap)}`)
      await Bun.sleep(200)
      await cdp.evaluate(
        "window.__quickScrollTrack=window.__quickScrollModule.trackQuickAssistantScrollFixture({nearestText:true}); true",
      )
      await cdp.evaluate(`window.__quickScrollFixture.resize(${width}); true`)
      await Bun.sleep(600)
      await end(`paragraph-interline-gap-width-${width}`, true)
      assert.ok(
        report.phases.at(-1)!.glyphSamples > 0,
        "interline regression must independently track nearest text glyph",
      )
    }
    await cdp.evaluate(
      "window.__quickScrollFixture.dispose(); window.__quickScrollFixture=window.__quickScrollModule.mountQuickAssistantScrollFixture({paragraph:7}); true",
    )
    await Bun.sleep(400)
    assert.notEqual(
      await cdp.evaluate(
        "document.querySelector('[data-quick-scroll-fixture] [data-message-id=scroll_fixture_7] [data-component=markdown]').dataset.markdownRenderedStage",
      ),
      "full",
      "long paragraph must initially remain deferred",
    )
    await cdp.evaluate(`(() => {
      const view=document.querySelector('[data-quick-scroll-fixture] [data-component="quick-assistant-viewport"]');
      view.dispatchEvent(new WheelEvent('wheel',{deltaY:-1}));
      const block=view.querySelector('[data-message-id="scroll_fixture_7"] [data-source-line]');
      const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode;const index=node.textContent.indexOf('INLINE_MARKER_80');
        if(index<0)continue;
        const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+1);
        view.scrollTop+=range.getBoundingClientRect().top-view.getBoundingClientRect().top-80;
        window.__quickScrollTrack=window.__quickScrollModule.trackQuickAssistantScrollFixture();return true;
      }
      throw Error('deferred inline prose marker missing');
    })()`)
    await Bun.sleep(900)
    await end("paragraph-inline-lazy-upgrade", true)
    assert.ok(report.phases.at(-1)!.stageChanges > 0, "inline paragraph must actually upgrade while observed")
    assert.ok(report.phases.at(-1)!.glyphSamples > 0, "inline upgrade must track text character ranges")
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/quick-assistant-scroll-regression.png", Buffer.from(screenshot.data, "base64"))
    const receipt = await cdp.evaluate<{ sent: boolean; received: boolean }>(`(async () => {
      const server = await window.api.awaitInitialization();
      const headers = { 'Content-Type': 'application/json', 'x-opencode-directory': encodeURIComponent('/private/tmp'),
        Authorization: 'Basic ' + btoa((server.username || 'opencode') + ':' + server.password) };
      const request = async (path, method = 'GET', body) => {
        const response = await fetch(server.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!response.ok) throw Error('sidecar ' + response.status + ' ' + path);
        return response.status === 204 ? null : response.json();
      };
      const session = await request('/session', 'POST', { title: 'Quick assistant scroll regression' });
      console.debug('[quick-scroll-test] sidecar send session=' + session.id);
      try {
        await request('/session/' + session.id + '/shell', 'POST', { agent: 'build', command: 'printf QUICK_SCROLL_SIDECAR_OK' });
        const messages = await request('/session/' + session.id + '/message');
        const sent = messages.some(m => m.info.role === 'user');
        const received = messages.some(m => m.info.role === 'assistant' && m.parts.some(p => p.type === 'tool' && p.state.status === 'completed' && p.state.output.includes('QUICK_SCROLL_SIDECAR_OK')));
        console.debug('[quick-scroll-test] sidecar receipt session=' + session.id + ' sent=' + sent + ' received=' + received);
        return { sent, received };
      } finally {
        await request('/session/' + session.id, 'DELETE');
        console.debug('[quick-scroll-test] sidecar owned session removed=' + session.id);
      }
    })()`)
    assert.ok(receipt.sent && receipt.received, "sidecar must persist both the sent message and the received output")
    console.log("[quick-scroll-test] PASS sidecar message sent and received")
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    await Bun.write(
      Bun.env.OPENCODE_QUICK_SCROLL_REPORT ?? "/tmp/quick-assistant-scroll-regression.json",
      JSON.stringify(report, null, 2),
    )
    await cdp.evaluate(
      "window.__quickScrollTrack?.(); window.__quickScrollFixture?.dispose(); delete window.__quickScrollTrack; delete window.__quickScrollFixture; true",
    )
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: false })
    socket.removeEventListener("message", onProtocol)
  }
})
