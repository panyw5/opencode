import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const commandSource = `/@fs${resolve(import.meta.dir, "../../app/src/context/command.tsx")}`
  const bindings = await cdp.evaluate<
    Record<
      string,
      Array<{
        key: string
        ctrl: boolean
        meta: boolean
        shift: boolean
        alt: boolean
      }>
    >
  >(`(async () => {
    const saved = await window.api.storeGet('default.dat','settings.v3');
    const settings = saved ? JSON.parse(saved) : {};
    const command = await import(${JSON.stringify(commandSource)});
    return Object.fromEntries(Object.entries({
      'message.previous':'mod+arrowup','message.next':'mod+arrowdown'
    }).map(([id,fallback])=>[id,command.parseKeybind(settings.keybinds?.[id] ?? fallback)]));
  })()`)
  console.log(`[message-focus-test] effective bindings=${JSON.stringify(bindings)}`)
  const press = async (id: string) => {
    const binding = bindings[id]?.[0]
    assert.ok(binding, `${id} must have an effective configured binding`)
    const named: Record<string, string> = { arrowup: "ArrowUp", arrowdown: "ArrowDown" }
    const key = named[binding.key] ?? (binding.shift ? binding.key.toUpperCase() : binding.key)
    const modifiers = (binding.alt ? 1 : 0) | (binding.ctrl ? 2 : 0) | (binding.meta ? 4 : 0) | (binding.shift ? 8 : 0)
    const event = {
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode: key === "ArrowUp" ? 38 : key === "ArrowDown" ? 40 : 0,
    }
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", ...event })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", ...event })
    await Bun.sleep(180)
  }
  const state = () =>
    cdp.evaluate<{
      navigations: number
      blocked: number
      top: number
      scope?: string
      draftUnchanged: boolean
    }>(`(() => {
    const test=window.__messageFocusTest;
    return { navigations:test.logs.filter(line=>line.includes('[session] message offset navigation:')).length,
      blocked:test.logs.filter(line=>line.includes('[command-keybind] scope blocked id=message.')).length,
      top:test.viewport.scrollTop, scope:document.activeElement?.closest('[data-command-scope]')?.dataset.commandScope,
      draftUnchanged:test.quickText===document.querySelector('[data-prompt-kind=quick] [contenteditable=true]')?.textContent };
  })()`)
  try {
    await cdp.evaluate(`(() => {
      const main=[...document.querySelectorAll('[data-command-scope=session]')].find(e=>e.getClientRects().length);
      const viewport=main?.querySelector('[data-component=message-timeline] [data-slot=scroll-view-viewport]');
      if(!main||!viewport) throw Error('Visible session timeline required');
      const test=window.__messageFocusTest={main,viewport,top:viewport.scrollTop,active:document.activeElement,
        quickOpen:!!document.querySelector('[data-component=quick-assistant-panel]'),
        ranges:[...Array(window.getSelection()?.rangeCount??0)].map((_,i)=>window.getSelection().getRangeAt(i).cloneRange()),
        logs:[],debug:console.debug};
      console.debug=(...args)=>{const line=args.map(String).join(' ');test.logs.push(line);test.debug(...args)};
      if(!test.quickOpen) {
        const launcher=document.querySelector('[data-component=quick-assistant-launcher]');
        if(!launcher)throw Error('Quick assistant launcher required');
        launcher.click();
      }
      return true;
    })()`)
    await Bun.sleep(400)
    await cdp.evaluate(`(() => {
      const editor=document.querySelector('[data-prompt-kind=quick] [contenteditable=true]');
      if(!editor)throw Error('Quick assistant editor missing');
      window.__messageFocusTest.quickText=editor.textContent;
      editor.focus({preventScroll:true});
      const range=document.createRange();range.selectNodeContents(editor);range.collapse(true);
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
      return true;
    })()`)
    const quickBefore = await state()
    for (let index = 0; index < 4; index++) {
      await press("message.previous")
      await press("message.next")
    }
    const quickAfter = await state()
    assert.equal(quickAfter.navigations, quickBefore.navigations, "quick input must not navigate the main session")
    assert.ok(quickAfter.blocked - quickBefore.blocked >= 8, "each foreign keybind must be explicitly scope-rejected")
    assert.ok(Math.abs(quickAfter.top - quickBefore.top) <= 1, "main timeline must stay at its original position")
    assert.ok(quickAfter.draftUnchanged, "modified arrows must not replace the quick draft with history")
    assert.equal(quickAfter.scope, "quick-assistant")
    console.log(
      "[message-focus-test] PASS quick editor: eight configured shortcuts blocked, draft and main position unchanged",
    )

    await cdp.evaluate("window.__messageFocusTest.main.focus({preventScroll:true}); true")
    const mainBefore = await state()
    await press("message.previous")
    await press("message.next")
    assert.equal(
      (await state()).navigations,
      mainBefore.navigations + 2,
      "both directions must work with session focus",
    )
    console.log("[message-focus-test] PASS main session: both configured directions dispatched")

    await cdp.evaluate(`(() => {
      const editor=window.__messageFocusTest.main.querySelector('[data-prompt-kind=main] [contenteditable=true]');
      if(!editor)throw Error('Main composer missing');editor.focus({preventScroll:true});return true;
    })()`)
    const composerBefore = await state()
    await press("message.previous")
    assert.equal((await state()).navigations, composerBefore.navigations + 1)
    console.log("[message-focus-test] PASS main composer remains inside session scope")

    await cdp.evaluate(`(() => {
      const button=document.createElement('button');button.dataset.messageFocusOutside='';button.tabIndex=-1;
      button.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
      document.body.append(button);button.focus({preventScroll:true});return true;
    })()`)
    const outsideBefore = await state()
    await press("message.previous")
    await press("message.next")
    assert.equal((await state()).navigations, outsideBefore.navigations, "focus outside session must not navigate")
    console.log("[message-focus-test] PASS outside session: both directions blocked")

    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const main=window.__messageFocusTest.main;const box=main.getBoundingClientRect();
      for(const dx of [32,96,160])for(const ratio of [.3,.5,.7]){
        const x=box.left+dx,y=box.top+box.height*ratio;
        const hit=document.elementFromPoint(x,y);
        if(hit?.closest('[data-command-scope]')===main&&!hit.closest('button,a,input,textarea,[contenteditable]'))return{x,y};
      }
      throw Error('No exposed main conversation click target');
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
    assert.equal((await state()).scope, "session", "clicking noneditable conversation content must acquire scope")
    const clickBefore = await state()
    await press("message.previous")
    assert.equal((await state()).navigations, clickBefore.navigations + 1)
    console.log("[message-focus-test] PASS real pointer click acquires conversation focus")

    const receipt = await cdp.evaluate<{ sent: boolean; received: boolean }>(`(async () => {
      const server=await window.api.awaitInitialization();
      const headers={'Content-Type':'application/json','x-opencode-directory':encodeURIComponent('/private/tmp'),
        Authorization:'Basic '+btoa((server.username||'opencode')+':'+server.password)};
      const request=async(path,method='GET',body)=>{
        const response=await fetch(server.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
        if(!response.ok)throw Error('sidecar '+response.status+' '+path);
        return response.status===204?null:response.json();
      };
      const session=await request('/session','POST',{title:'Message navigation focus regression'});
      console.debug('[message-focus-test] sidecar send session='+session.id);
      try{
        await request('/session/'+session.id+'/shell','POST',{agent:'build',command:'printf MESSAGE_FOCUS_SIDECAR_OK'});
        const messages=await request('/session/'+session.id+'/message');
        const sent=messages.some(m=>m.info.role==='user');
        const received=messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.type==='tool'&&p.state.status==='completed'&&p.state.output.includes('MESSAGE_FOCUS_SIDECAR_OK')));
        console.debug('[message-focus-test] sidecar receipt session='+session.id+' sent='+sent+' received='+received);
        return{sent,received};
      }finally{await request('/session/'+session.id,'DELETE');}
    })()`)
    assert.ok(receipt.sent && receipt.received)
    console.log("[message-focus-test] PASS sidecar sent and received")
  } finally {
    await cdp.evaluate(`(() => {
      const test=window.__messageFocusTest;if(!test)return true;
      document.querySelector('[data-message-focus-outside]')?.remove();
      if(!test.quickOpen)document.querySelector('[data-component=quick-assistant-panel] > button:last-of-type')?.click();
      if(test.viewport.isConnected)test.viewport.scrollTop=test.top;
      if(test.active?.isConnected)test.active.focus({preventScroll:true});
      const selection=window.getSelection();selection?.removeAllRanges();
      for(const range of test.ranges)if(range.startContainer.isConnected&&range.endContainer.isConnected)selection?.addRange(range);
      console.debug=test.debug;delete window.__messageFocusTest;return true;
    })()`)
  }
})
