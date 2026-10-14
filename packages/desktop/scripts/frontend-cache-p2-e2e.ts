import { mkdtemp, writeFile, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { withCdp, type CdpClient } from "./cdp"

const source = fileURLToPath(new URL("../../app/src/", import.meta.url))
const log = (message: string) => console.log(`[cache-p2-e2e] ${message}`)
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function wait(label: string, check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function checkModules(cdp: CdpClient) {
  const results = await cdp.evaluate<Array<{ name: string; pass: boolean }>>(`window.__cacheP2Modules=(async()=>{
    const base=${JSON.stringify(`/@fs${source}`)};
    const {deferred,createSessionControllerHarness}=await import(base+'context/global-sync/session-service-test-utils.ts');
    const {createSessionMessagesService}=await import(base+'context/global-sync/session-messages-service.ts');
    const {createFileContentLoader}=await import(base+'context/file/content-loader.ts');
    const {createFileTreeStore}=await import(base+'context/file/tree-store.ts');
    const {loadSkills}=await import(base+'utils/skills.ts');
    const code=await fetch(base+'context/global-sync/session-messages-service.ts').then(r=>r.text());
    const solid=await import(code.match(/from "([^\"]*solid-js\\.js[^\"]*)"/)[1]);
    const directory='/tmp/cache-p2-modules-'+Date.now();
    const message=id=>({id,sessionID:'session',role:'user',time:{created:1}});
    const response=(id,parts=[])=>({data:[{info:message(id),parts}],response:{headers:{get:()=>null}}});
    const results=[];
    {
      const first=deferred(),second=deferred();let calls=0;
      const harness=createSessionControllerHarness({messages:()=>++calls===1?first.promise:second.promise},directory);
      const service=createSessionMessagesService(harness.deps);
      const input={directory,sessionID:'session',limit:80};const old=service.load(input);
      service.event(directory,'session','discard');const fresh=service.load({...input,authoritative:true});
      first.resolve(response('stale'));await old;await Promise.resolve();
      second.resolve(response('fresh'));await fresh;
      results.push({name:'authoritative-refresh-not-swallowed',pass:calls===2&&service.get(directory,'session')[0].id==='fresh'});
    }
    {
      const harness=createSessionControllerHarness({messages:async()=>response('message')},directory);
      const service=createSessionMessagesService(harness.deps);
      harness.child[1]('part','message',[{id:'part',messageID:'message',sessionID:'session',type:'text',text:'deleted text'}]);
      await service.load({directory,sessionID:'session',limit:80,authoritative:true});
      results.push({name:'empty-authoritative-parts-clear-text',pass:service.parts(directory,'message').length===0});
    }
    {
      const harness=createSessionControllerHarness({},directory);const service=createSessionMessagesService(harness.deps);
      const pass=solid.createRoot(dispose=>{
        const pending=solid.createMemo(()=>service.optimistic.has(directory,'session','pending'));
        const input={sessionID:'session',message:message('pending'),parts:[]};service.optimistic.add(directory,input);
        const before=pending();service.optimistic.complete(directory,{sessionID:'session',messageID:'pending'});
        const after=pending();dispose();return before&&!after;
      });results.push({name:'optimistic-membership-reactive',pass});
    }
    {
      const first=deferred(),second=deferred();let calls=0,value;
      const loader=createFileContentLoader({scope:()=>directory,normalize:p=>p,loaded:()=>false,
        read:()=>++calls===1?first.promise:second.promise,onLoading:()=>{},onContent:(_,next)=>value=next,onError:()=>{}});
      const old=loader.load('file.txt');const fresh=loader.load('file.txt',{force:true});
      first.resolve({data:{type:'text',content:'stale'}});await old;
      const ignored=value===undefined;second.resolve({data:{type:'text',content:'fresh'}});await fresh;
      results.push({name:'file-content-trailing-refresh',pass:ignored&&calls===2&&value.content==='fresh'});
      loader.reset();
    }
    {
      const pending=deferred();let scope=directory;
      const tree=createFileTreeStore({scope:()=>scope,normalizeDir:p=>p,list:()=>pending.promise,onError:()=>{}});
      const old=tree.listDir('');scope+='-other';tree.reset();scope=directory;tree.reset();
      pending.resolve([{path:'stale',name:'stale',absolute:directory+'/stale',type:'file'}]);await old;
      results.push({name:'file-tree-reset-epoch',pass:tree.children('').length===0});
    }
    {
      const first=deferred(),second=deferred();let calls=0;
      const sdk={directory,client:{app:{skills:()=>++calls===1?first.promise:second.promise}}};
      const old=loadSkills(sdk);const fresh=loadSkills(sdk,{force:true});
      first.resolve({data:[{name:'old'}]});await old;second.resolve({data:[{name:'fresh'}]});
      const list=await fresh;results.push({name:'skills-force-refresh',pass:calls===2&&list[0].name==='fresh'});
    }
    return results;
  })()`)
  for (const result of results) {
    assert(result.pass, `Module regression failed: ${result.name}`)
    log(`PASS ${result.name}`)
  }
}

await withCdp(async (cdp, target) => {
  assert(target.url.includes("localhost:5173"), "Expected development Electron")
  await checkModules(cdp)
  const directory = await mkdtemp("/private/tmp/opencode-cache-p2-")
  const filename = "cache-p2-proof.txt"
  const file = join(directory, filename)
  const oldText = "CACHE_P2_OLD_CONTENT"
  const freshText = "CACHE_P2_FRESH_CONTENT"
  await writeFile(file, oldText)
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization()",
  )
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`)
    return response.status === 204 ? undefined : response.json()
  }
  const previous = await cdp.evaluate<string | undefined>(
    "document.querySelector('[data-prompt-scope]')?.getAttribute('data-prompt-scope')",
  )
  const session = await request("/session", "POST", { title: "QA P2 file cache lifecycle" })
  const navigate = async (dir: string, id: string) => {
    const route = `/${Buffer.from(dir).toString("base64url")}/session/${id}`
    await cdp.evaluate(
      `(()=>{void import(${JSON.stringify(`/@fs${source}utils/notification-click.ts`)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)}));return true})()`,
    )
  }
  try {
    await request(`/session/${session.id}/message`, "POST", {
      noReply: true,
      agent: "build",
      model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
      parts: [{ type: "text", text: "CACHE_P2_REMOVE_PART" }],
    })
    const messages = await request(`/session/${session.id}/message`)
    const user = messages.find((row: any) => row.info.role === "user")
    const text = user.parts.find((part: any) => part.type === "text" && part.text === "CACHE_P2_REMOVE_PART")
    assert(text, "Sidecar did not receive the test message")
    await request(`/session/${session.id}/message/${user.info.id}/part/${text.id}`, "DELETE")
    const updated = await request(`/session/${session.id}/message`)
    const row = updated.find((entry: any) => entry.info.id === user.info.id)
    assert(row.parts.length === 0, "Sidecar did not return an empty part list after deletion")
    const cleared = await cdp.evaluate<boolean>(`(async()=>{
      const {createSessionMessagesService}=await import(${JSON.stringify(`/@fs${source}context/global-sync/session-messages-service.ts`)});
      const {createSessionControllerHarness}=await import(${JSON.stringify(`/@fs${source}context/global-sync/session-service-test-utils.ts`)});
      const row=${JSON.stringify(row)};const parts=${JSON.stringify(user.parts)};
      const harness=createSessionControllerHarness({messages:async()=>({data:[row],response:{headers:{get:()=>null}}})},${JSON.stringify(directory)});
      harness.child[1]('part',row.info.id,parts);const service=createSessionMessagesService(harness.deps);
      await service.load({directory:${JSON.stringify(directory)},sessionID:row.info.sessionID,limit:80,authoritative:true});
      return service.parts(${JSON.stringify(directory)},row.info.id).length===0;
    })()`)
    assert(cleared, "Actual empty backend snapshot retained deleted text")
    log("PASS actual sidecar empty-part snapshot clears cached text")
    await navigate(directory, session.id)
    await wait("test session ready", () =>
      cdp.evaluate(
        `!!document.querySelector('[data-component=session-page][data-session-id="${session.id}"][data-render-phase=interactive]')`,
      ),
    )
    await cdp.evaluate(`(()=>{
      const original=window.fetch;window.__cacheP2Fetch=original;window.__cacheP2Captured=false;window.__cacheP2Queued=false;
      window.__cacheP2Text=()=>{
        let text=document.body.innerText;
        const scan=root=>{for(const element of root.querySelectorAll('*')){
          if(!element.shadowRoot)continue;
          if(element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0)text+=element.shadowRoot.textContent;
          scan(element.shadowRoot);
        }};scan(document);return text;
      };
      const debug=console.debug;window.__cacheP2Debug=debug;
      console.debug=(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('[fresh-request] queue ')&&args[0].includes(${JSON.stringify(filename)}))window.__cacheP2Queued=true;debug(...args)};
      window.fetch=async(input,init)=>{
        const req=new Request(input,init);const url=new URL(req.url);
        const scope=url.searchParams.get('directory')??decodeURIComponent(req.headers.get('x-opencode-directory')??'');
        if(url.pathname==='/file/content'&&url.searchParams.get('path')===${JSON.stringify(filename)}&&scope===${JSON.stringify(directory)}){
          window.fetch=original;const response=await original(input,init);window.__cacheP2Captured=true;
          return new Promise(resolve=>window.__cacheP2Release=()=>resolve(response));
        }return original(input,init);
      };
    })()`)
    await cdp.evaluate(`(()=>{
      const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      const button=[...document.querySelectorAll('button[aria-controls=file-tree-panel]')].find(visible);
      if(button?.getAttribute('aria-expanded')!=='true')button?.click();
    })()`)
    await wait("file tree panel open", () =>
      cdp.evaluate("!!document.querySelector('button[aria-controls=file-tree-panel][aria-expanded=true]')"),
    )
    await cdp.evaluate(`(()=>{
      const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      const all=[...document.querySelectorAll('[role=tab]')].find(e=>visible(e)&&/所有文件|全部文件|all files/i.test(e.innerText));all?.click();
    })()`)
    await wait("fixture file tree item", () =>
      cdp.evaluate(
        `!![...document.querySelectorAll('[data-component=filetree] button')].find(e=>e.getBoundingClientRect().width>0&&e.innerText.includes(${JSON.stringify(filename)}))`,
      ),
    )
    await cdp.evaluate(
      `[...document.querySelectorAll('[data-component=filetree] button')].find(e=>e.getBoundingClientRect().width>0&&e.innerText.includes(${JSON.stringify(filename)})).click()`,
    )
    await wait("old file response captured", () => cdp.evaluate("window.__cacheP2Captured===true"))
    await writeFile(file, freshText)
    await wait("watcher forced refresh queued", () => cdp.evaluate("window.__cacheP2Queued===true"))
    await cdp.evaluate("window.__cacheP2Release()")
    await wait("fresh file visible", () =>
      cdp.evaluate(`window.__cacheP2Text().includes(${JSON.stringify(freshText)})`),
    )
    assert(
      await cdp.evaluate<boolean>(`!window.__cacheP2Text().includes(${JSON.stringify(oldText)})`),
      "Stale file text reappeared",
    )
    log("PASS actual watcher refresh ignores held old file response")
    await unlink(file)
    await wait("deleted file content cleared", () =>
      cdp.evaluate(`!window.__cacheP2Text().includes(${JSON.stringify(freshText)})`),
    )
    log("PASS deleting an open file clears its old content")
    assert(
      await cdp.evaluate<boolean>(
        "!document.body.innerText.includes('加载应用程序时发生错误')&&!document.querySelector('vite-error-overlay')",
      ),
      "Renderer failure during cache regression",
    )
  } finally {
    await cdp.evaluate(
      "(()=>{window.__cacheP2Release?.();if(window.__cacheP2Fetch)window.fetch=window.__cacheP2Fetch;if(window.__cacheP2Debug)console.debug=window.__cacheP2Debug;return true})()",
    )
    await request(`/session/${session.id}`, "DELETE")
    if (previous) {
      const [dir, id] = JSON.parse(previous)
      if (dir && id) await navigate(dir, id)
    }
    log("owned test session cleaned")
  }
})

await import("./frontend-cache-p1-e2e")
log("PASS complete P1 + P2 CDP regression")
