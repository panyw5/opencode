// Test-only bridge: production installer + isolated registry + real Electron form.
import { expect } from "bun:test"
import { randomUUID, createHash } from "node:crypto"
import { writeFile, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { withCdp } from "../../../desktop/scripts/cdp"
import type { installation } from "../../src/extension/install-service"
import type { InstallRequest, InstallResult } from "../../src/extension/install"

/**
 * Opt-in release mode fixture. `url` is the HTTPS descriptor URL the real form
 * and the desktop archive operations see; `document` is the exact descriptor
 * JSON served for that URL by injected fetch (only the descriptor is replaced,
 * never the artifact download: the renderer still fetches the descriptor's
 * real GitHub release asset through its own proxy).
 */
export type RendererReleaseFixture = {
  url: string
  document: string
}

export async function confirmThroughRenderer(
  service: ReturnType<typeof installation>,
  request: InstallRequest,
  root: string,
  localArchive = false,
  release?: RendererReleaseFixture,
): Promise<InstallResult> {
  const secret = randomUUID()
  const staged = new Set<string>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      }
      if (req.method === "OPTIONS") return new Response(null, { headers })
      if (req.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 403, headers })
      try {
        const p = (await req.json()) as any
        let value: unknown
        if (p.op === "stage") {
          const file = path.join(root, `download-${randomUUID()}.tgz`)
          await writeFile(file, new Uint8Array(p.bytes))
          staged.add(file)
          value = { path: file }
        } else if (p.op === "cleanup") {
          if (staged.delete(p.path)) await rm(p.path, { force: true })
        } else if (p.op === "digest") {
          if (!("source" in request) || request.source?.type !== "local" || p.path !== request.source.path)
            throw new Error("Unexpected digest path")
          const bytes = await readFile(p.path)
          value = { path: p.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
        } else if (p.op === "prepare") {
          if (p.archive) value = await service.prepareArchive(p.request, p.archive)
          else if (!p.release) value = await service.prepare(p.request)
          else {
            // Release mode hands the staged artifact plus the exact descriptor
            // text to the private release path; fail loudly instead of silently
            // re-downloading the descriptor or the artifact.
            const api = service as typeof service & {
              prepareRelease?: (
                request: InstallRequest,
                release: { url: string; descriptor: string; path: string },
              ) => Promise<unknown>
            }
            if (typeof api.prepareRelease !== "function")
              throw new Error("service.prepareRelease is required for release installs")
            value = await api.prepareRelease(p.request, p.release)
          }
        } else if (p.op === "commit") value = await service.commit(p.operationId, p.token, p.input)
        else if (p.op === "cancel") value = await service.cancel(p.operationId, p.token)
        else if (p.op === "status") value = await service.status(p.operationId, p.token)
        else throw new Error("Unknown test operation")
        return Response.json({ ok: true, value }, { headers })
      } catch (error) {
        return Response.json(
          { ok: false, error: { message: error instanceof Error ? error.message : "test operation failed" } },
          { headers },
        )
      }
    },
  })
  const intent =
    release && request.kind === "install" && request.source.type === "release"
      ? { kind: "install" as const }
      : release && request.kind === "update" && request.target === "release-current"
        ? { kind: "update" as const, id: request.id, source: { type: "release" as const, descriptor: release.url } }
        : localArchive && request.kind === "install" && request.source.type === "local"
          ? { kind: "install", localArchive: { path: request.source.path } }
          : request.kind === "update"
            ? {
                kind: "update",
                id: request.id,
                source: { type: "archive", location: "https://example.com/old.tgz", sha256: "a".repeat(64) },
              }
            : request.kind === "uninstall"
              ? { kind: "uninstall", id: request.id }
              : { kind: "install" }
  try {
    const source = `/@fs${path.resolve(import.meta.dir, "../../../app/src/components/dialog-install-extension.tsx")}?wls-ui=${Date.now()}`
    const helper = `/@fs${path.resolve(import.meta.dir, "../../../app/src/extensions/install-desktop.ts")}`
    const remote =
      "https://github.com/panyw5/opencode-wls/releases/download/v1.18.64/opencode-ai-wls-repl-extension-1.18.64.tgz"
    return await withCdp(async (client, target) => {
      expect(target.url.startsWith("http://localhost:")).toBe(true)
      try {
        const result = await client.evaluate<any>(`(async()=>{
          const source=${JSON.stringify(source)};
          const transformed=await fetch(source).then(r=>r.text());
          const urls=[...transformed.matchAll(/from "([^"]+)"/g)].map(m=>m[1]);
          const {render}=await import(urls.find(u=>u.includes('solid-js_web.js')));
          const {createComponent}=await import(urls.find(u=>u.includes('/solid-js.js')));
          const {ExtensionInstallationForm}=await import(source);
          const {createDesktopArchiveOperations}=await import(${JSON.stringify(helper)});
          const call=async(op,payload={})=>fetch(${JSON.stringify(`http://127.0.0.1:${server.port}`)},{method:'POST',headers:{authorization:${JSON.stringify(`Bearer ${secret}`)},'content-type':'application/json'},body:JSON.stringify({op,...payload})}).then(r=>r.json());
          const unwrap=async(op,payload)=>{const r=await call(op,payload);if(!r.ok)throw new Error(r.error.message);return r.value};
          const base={prepareInstallation:request=>unwrap('prepare',{request}),commitInstallation:(p,input)=>unwrap('commit',{operationId:p.operationId,token:p.token,input}),cancelInstallation:p=>unwrap('cancel',{operationId:p.operationId,token:p.token}),installationStatus:p=>unwrap('status',{operationId:p.operationId,token:p.token})};
          const release=${JSON.stringify(release ?? null)};
          const operations=createDesktopArchiveOperations({fallback:base,local:()=>true,connection:()=>base,
            download:async url=>{const r=await window.api.extensionArchiveDownload(url);if(!r.ok)throw Error(r.error.message);return r.value.bytes},
            ...(release?{releaseURL:()=>release.url,fetch:(input,init)=>String(typeof input==='string'?input:input instanceof Request?input.url:String(input))===release.url?new Response(release.document,{headers:{'content-type':'application/json'}}):fetch(input,init)}:{}),
            bridge:{invoke:call,stage:bytes=>call('stage',{bytes:[...bytes]}),cleanup:path=>call('cleanup',{path})}});
          const root=document.createElement('div');root.style.cssText='position:fixed;inset:20px;z-index:99999;overflow:auto;background:var(--background-base)';document.body.append(root);
          let result;
          const intent=${JSON.stringify(intent)};
          const dispose=render(()=>createComponent(ExtensionInstallationForm,{intent,operations,enabled:true,connection:()=>base,language:{t:key=>key},localArchiveBridge:{digest:path=>call('digest',{path})},onClose(){},onResult:r=>{result=r}}),root);
          window.__wlsInstallTestCleanup=()=>{dispose();root.remove();delete window.__wlsInstallTestCleanup};
          const wait=async(check,label)=>{const end=Date.now()+30000;while(!check()){if(Date.now()>end)throw new Error(label+' timed out: '+root.innerText);await new Promise(r=>setTimeout(r,30));}};
          if(intent.kind!=='uninstall' && !intent.localArchive){
            if(!release){
              const select=root.querySelector('select[data-field="source-type"]');select.value='archive';select.dispatchEvent(new Event('change',{bubbles:true}));
              if(root.querySelector('input[aria-label="config.extensions.install.sha256"]'))throw new Error('Unexpected checksum input');
              const input=root.querySelector('input[aria-label="config.extensions.install.url"]');input.value=${JSON.stringify(remote)};input.dispatchEvent(new Event('input',{bubbles:true}));
            } else if(intent.kind==='install'){
              // Release install: the form already defaults to the release channel.
              if(root.querySelector('input[aria-label="config.extensions.install.sha256"]'))throw new Error('Unexpected checksum input');
              const input=root.querySelector('input[aria-label="config.extensions.install.releaseUrl"]');
              if(!input)throw new Error('Release URL input missing');
              input.value=release.url;input.dispatchEvent(new Event('input',{bubbles:true}));
            }
            // release-current update: the descriptor comes from the installed
            // release source through releaseURL(); the field is read-only.
          }
          await wait(()=>!root.querySelector('[data-action="extension-install-prepare"]').disabled,'automatic digest');
          if(root.querySelector('input[aria-label="config.extensions.install.sha256"]'))throw new Error('Unexpected checksum input');
          root.querySelector('[data-action="extension-install-prepare"]').click();
          await wait(()=>root.querySelector('[data-action="extension-install-confirm"]'),'preview');
          const upgrade=root.querySelector('[data-field="accept-registry-upgrade"] input');
          if(upgrade&&!upgrade.checked)upgrade.click();
          if(intent.kind==='install')root.querySelector('[data-field="enable"] input').click();
          root.querySelector('[data-action="extension-install-confirm"]').click();
          await wait(()=>result,'commit');
          return result;
        })().catch(error=>({error:String(error)}))`)
        console.info(
          `[wls-cdp-lifecycle] kind=${request.kind} localArchive=${localArchive} release=${release?.url ?? "-"} userChecksum=false committed=${result.committed} synced=${result.synced}`,
        )
        expect(result.error).toBeUndefined()
        expect(result.committed).toBe(true)
        return result as InstallResult
      } finally {
        await client.evaluate("window.__wlsInstallTestCleanup?.()")
      }
    })
  } finally {
    server.stop(true)
  }
}
