import { mkdtemp } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { withCdp, type CdpClient } from "./cdp"

const repository = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const source = fileURLToPath(new URL("../../app/src/", import.meta.url))
const log = (message: string) => console.log(`[cache-p1-e2e] ${message}`)
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function wait(label: string, check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function checkRequestOwnership(cdp: CdpClient) {
  const results = await cdp.evaluate<Array<{ name: string; safe: boolean }>>(`window.__cacheP1Ownership = (async () => {
    const base=${JSON.stringify(`/@fs${source}`)};
    const {deferred,createSessionControllerHarness,sessionInfo}=await import(base+'context/global-sync/session-service-test-utils.ts');
    const {createSessionTodoService}=await import(base+'context/global-sync/session-todo-service.ts');
    const {createSessionDiffService}=await import(base+'context/global-sync/session-diff-service.ts');
    const {createSessionMessagesService}=await import(base+'context/global-sync/session-messages-service.ts');
    const info=await import(base+'context/global-sync/session-info-load.ts');
    const prefetch=await import(base+'context/global-sync/session-prefetch.ts');
    const directory='/tmp/cache-p1-ownership-'+Date.now();
    const results=[];
    for(const kind of ['todo','diff']){
      const first=deferred(),second=deferred();let calls=0;
      const harness=createSessionControllerHarness({[kind]:()=>++calls===1?first.promise:second.promise},directory);
      const service=(kind==='todo'?createSessionTodoService:createSessionDiffService)(harness.deps);
      const old=service.refresh(directory,'session');
      service.clear(directory,['session']);service.clear(directory,['session']);
      const fresh=service.refresh(directory,'session');
      first.resolve({data:kind==='todo'?[{content:'deleted',status:'pending',priority:'high'}]:[{file:'deleted.ts',before:'',after:'old',additions:1,deletions:0}]});
      await old;
      const safe=service.get(directory,'session')===undefined;
      second.resolve({data:[]});await fresh;service.clear(directory,['session']);
      results.push({name:kind+'-double-clear',safe});
    }
    {
      const first=deferred(),second=deferred();let calls=0;
      const response=id=>({data:id?[{info:{id,sessionID:'session',role:'user',time:{created:1}},parts:[]}]:[],response:{headers:{get:()=>null}}});
      const harness=createSessionControllerHarness({messages:()=>++calls===1?first.promise:second.promise},directory);
      const service=createSessionMessagesService(harness.deps);
      const input={directory,sessionID:'session',limit:80};const old=service.load(input);
      service.clear(directory,['session']);service.clear(directory,['session']);
      const fresh=service.load(input);first.resolve(response('deleted'));
      const result=await old;
      const safe=!result.committed&&service.get(directory,'session')===undefined;
      second.resolve(response('fresh'));await fresh;service.clear(directory,['session']);
      results.push({name:'messages-double-clear',safe});
    }
    {
      const pending=deferred();const old=info.loadSessionInfo({directory,sessionID:'session',load:()=>pending.promise});
      info.clearSessionInfos(directory,['session']);info.clearSessionInfos(directory,['session']);
      pending.resolve(sessionInfo());const result=await old;
      results.push({name:'info-double-clear',safe:result===undefined});
    }
    {
      const pending=deferred();let safe=false;
      const old=prefetch.runSessionPrefetch({directory,sessionID:'session',task:async token=>{
        await pending.promise;safe=!prefetch.isSessionPrefetchCurrent(directory,'session',token);return undefined;
      }});
      prefetch.clearSessionPrefetch(directory,['session']);prefetch.clearSessionPrefetch(directory,['session']);
      pending.resolve();await old;prefetch.clearSessionPrefetchDirectory(directory);
      results.push({name:'prefetch-double-clear',safe});
    }
    return results;
  })()`)
  for (const result of results) {
    assert(result.safe, `Canceled request wrote stale data: ${result.name}`)
    log(`PASS ${result.name}`)
  }
}

await withCdp(async (cdp, target) => {
  assert(target.url.includes("localhost:5173"), "Refusing to operate outside development Electron")
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization()",
  )
  const request = async (directory: string, path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${connection.url}${path}`, {
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
  const navigate = async (directory: string, sessionID: string) => {
    const route = `/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`
    await cdp.evaluate(`(() => {
      void import(${JSON.stringify(`/@fs${source}utils/notification-click.ts`)}).then(m=>m.handleNotificationClick(${JSON.stringify(route)}));
      return true;
    })()`)
  }
  const previousScope = await cdp.evaluate<string | undefined>(
    "document.querySelector('[data-prompt-scope]')?.getAttribute('data-prompt-scope')",
  )
  const owned: Array<{ directory: string; id: string }> = []
  const createSession = async (directory: string, title: string) => {
    const session = await request(directory, "/session", "POST", { title })
    owned.push({ directory, id: session.id })
    return session
  }
  try {
    await checkRequestOwnership(cdp)
    const session = await createSession(repository, "QA P1 message index race")
    for (const text of ["CACHE_P1_DELETE", "CACHE_P1_KEEP"]) {
      await request(repository, `/session/${session.id}/message`, "POST", {
        noReply: true,
        agent: "build",
        model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
        parts: [{ type: "text", text }],
      })
    }
    const rows = await request(repository, `/session/${session.id}/message`)
    const deleted = rows.find((row: any) =>
      row.parts.some((part: any) => part.type === "text" && part.text === "CACHE_P1_DELETE"),
    )?.info.id
    assert(deleted, "Sidecar did not receive the test message")
    log(`sidecar received messages sid=${session.id}`)
    await cdp.evaluate(`(() => {
      const original=window.fetch;window.__cacheP1OriginalFetch=original;window.__cacheP1Captured=false;
      const releases=[];window.__cacheP1IndexStarted=false;window.__cacheP1IndexCaptured=false;
      window.__cacheP1IndexDeletedPending=false;window.__cacheP1IndexCount=undefined;
      const debug=console.debug;window.__cacheP1OriginalDebug=debug;
      console.debug=(...args)=>{
        const text=typeof args[0]==='string'?args[0]:'';
        if(text.includes('sid=${session.id}')){
          if(text.startsWith('[user-message-index] load-start '))window.__cacheP1IndexStarted=true;
          if(text.startsWith('[user-message-index] remove ')&&text.includes('pending=true'))window.__cacheP1IndexDeletedPending=true;
          if(text.startsWith('[user-message-index] commit '))window.__cacheP1IndexCount=Number(text.match(/count=(\\d+)/)?.[1]);
        }
        debug(...args);
      };
      window.__cacheP1Release=()=>{window.fetch=original;for(const release of releases)release()};
      window.fetch=async(input,init)=>{
        const req=new Request(input,init);
        if(new URL(req.url).pathname==='/session/${session.id}/user-message-index'){
          const afterStart=window.__cacheP1IndexStarted;const response=await original(input,init);
          window.__cacheP1Captured=true;
          if(afterStart)window.__cacheP1IndexCaptured=true;
          return new Promise(resolve=>releases.push(()=>resolve(response)));
        }
        return original(input,init);
      };
    })()`)
    await navigate(repository, session.id)
    await wait("main index snapshot captured", () => cdp.evaluate("window.__cacheP1IndexCaptured===true"))
    await request(repository, `/session/${session.id}/message/${deleted}`, "DELETE")
    const remaining = await request(repository, `/session/${session.id}/message`)
    assert(!remaining.some((row: any) => row.info.id === deleted), "Backend did not delete the test message")
    await wait("message removed from timeline", () => cdp.evaluate(`!document.querySelector('#message-${deleted}')`))
    await wait("deletion tracked by pending index", () => cdp.evaluate("window.__cacheP1IndexDeletedPending===true"))
    await cdp.evaluate("window.__cacheP1Release()")
    await wait("index committed without deleted item", () => cdp.evaluate("window.__cacheP1IndexCount===1"))
    await Bun.sleep(500)
    const ghost = await cdp.evaluate<boolean>(
      `!!document.querySelector('[data-testid=session-user-message-rail-item][data-message-id="${deleted}"]')`,
    )
    assert(!ghost, "Old index resurrected the deleted message")
    log("PASS delayed index cannot resurrect deleted navigation item")
    await cdp.evaluate("console.debug=window.__cacheP1OriginalDebug")
    const reply = await request(repository, `/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "axonhub-codex", modelID: "gpt-6.1-sol" },
      parts: [{ type: "text", text: "Reply with exactly CACHE_P1_REPLY_OK. Do not use tools." }],
    })
    assert(
      reply.parts?.some((part: any) => part.type === "text" && part.text.includes("CACHE_P1_REPLY_OK")),
      "Real sidecar reply was not received",
    )
    log("PASS real sidecar reply received")

    const directory = await mkdtemp("/private/tmp/opencode-cache-p1-")
    const removed = await createSession(directory, "QA P1 deleted root")
    const retained = await createSession(directory, "QA P1 retained root")
    await cdp.evaluate(`(() => {
      const original=window.fetch;window.__cacheP1OriginalFetch=original;window.__cacheP1Captured=false;
      const debug=console.debug;window.__cacheP1OriginalDebug=debug;window.__cacheP1RootIDs=undefined;
      console.debug=(...args)=>{
        if(typeof args[0]==='string' && args[0].startsWith('[session-list] commit directory='+${JSON.stringify(directory)}+' ')){
          window.__cacheP1RootIDs=args[0].match(/rootIDs=(.*)$/)?.[1]?.split(',').filter(Boolean)??[];
        }
        debug(...args);
      };
      window.fetch=async(input,init)=>{
        const req=new Request(input,init);const url=new URL(req.url);
        if(url.pathname==='/session' && url.searchParams.get('roots')==='true' && url.searchParams.get('directory')===${JSON.stringify(directory)}){
          window.fetch=original;const response=await original(input,init);
          window.__cacheP1Captured=true;
          return new Promise(resolve=>window.__cacheP1Release=()=>resolve(response));
        }
        return original(input,init);
      };
    })()`)
    await navigate(directory, retained.id)
    await wait("root snapshot captured", () => cdp.evaluate("window.__cacheP1Captured===true"))
    await request(directory, `/session/${removed.id}`, "DELETE")
    const created = await createSession(directory, "QA P1 created during snapshot")
    await Bun.sleep(400)
    await cdp.evaluate("window.__cacheP1Release()")
    await wait("root snapshot committed", () => cdp.evaluate("Array.isArray(window.__cacheP1RootIDs)"))
    const clientIDs = await cdp.evaluate<string[]>("window.__cacheP1RootIDs")
    const backend = await request(directory, `/session?roots=true&directory=${encodeURIComponent(directory)}`)
    const backendIDs = backend.map((row: any) => row.id).sort()
    assert(!clientIDs.includes(removed.id), "Old root list resurrected the deleted session")
    assert(clientIDs.includes(created.id), "Old root list dropped the newly created session")
    assert(JSON.stringify(clientIDs.sort()) === JSON.stringify(backendIDs), "Frontend roots differ from the backend")
    log(`PASS delayed root list preserves realtime create/delete roots=${clientIDs.length}`)
    log("PASS all three P1 regressions")
  } finally {
    await cdp.evaluate(`(() => {
      window.__cacheP1Release?.();
      if(window.__cacheP1OriginalFetch)window.fetch=window.__cacheP1OriginalFetch;
      if(window.__cacheP1OriginalDebug)console.debug=window.__cacheP1OriginalDebug;
      return true;
    })()`)
    for (const session of owned) {
      const response = await fetch(`${connection.url}/session/${session.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
          "x-opencode-directory": encodeURIComponent(session.directory),
        },
      })
      if (!response.ok && response.status !== 404) throw new Error(`Test cleanup failed HTTP ${response.status}`)
    }
    if (previousScope) {
      const [directory, sessionID] = JSON.parse(previousScope)
      if (directory && sessionID) await navigate(directory, sessionID)
    }
    log("owned test sessions cleaned")
  }
})
