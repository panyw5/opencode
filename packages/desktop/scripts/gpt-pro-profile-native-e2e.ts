// Bundle for Electron, not Bun. All pages and credentials are synthetic and offline.
import { app, BrowserWindow, safeStorage, session } from "electron"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { BrowserController } from "../src/main/browser"
import { GptProController } from "../src/main/gpt-pro-controller"
import { GptProDriver } from "../src/main/gpt-pro-driver"
import { GptProCredentialProfiles } from "../src/main/gpt-pro-credential-profiles"
import { GptProCredentialVault } from "../src/main/gpt-pro-credential-vault"
import { getGptProSessionCoordinator, type GptProSessionCoordinator } from "../src/main/gpt-pro-session-coordinator"
import { GptProLoginTransaction } from "../src/main/gpt-pro-login-transaction"
import { createGptProExecutionStore } from "../src/main/gpt-pro-execution-store"
import { createGptProBodyJournal } from "../src/main/gpt-pro-body-journal"
import { runGptProPerformanceCase } from "./gpt-pro-performance-case"

const root = mkdtempSync(join(tmpdir(), "opencode-gpt-profile-native-"))
app.setName("OpenCode GPT Profile Regression")
app.setPath("userData", root)
app.on("window-all-closed", () => {})
const log = (message: string) => console.info(`[gpt-profile-native] ${message}`)
const check = (value: unknown, message: string) => {
  if (!value) throw Error(message)
}
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic ChatGPT</title>
<button data-testid="model-switcher-dropdown-button">Pro</button>
<div data-composer-body><input type="file" aria-label="Attach files" multiple>
<div id="prompt-textarea" role="textbox" contenteditable="true" style="min-height:50px;border:1px solid black"></div>
<div data-composer-attachments data-visible-attachments><div class="flex-wrap"></div></div>
<button data-testid="send-button" aria-label="Send prompt">Send</button></div><main></main>
<script>
window.syntheticSends=0;window.syntheticUploads=0;
const input=document.querySelector('input');const editor=document.getElementById('prompt-textarea');
input.onchange=()=>{window.syntheticUploads++;const wrapper=document.querySelector('.flex-wrap');wrapper.innerHTML='';for(const file of input.files){
 const card=document.createElement('div');card.className='group/composer-attachment';
 const label=document.createElement('span');label.className='truncate';label.textContent=file.name;card.append(label);
 if(file.type.startsWith('image/')){card.setAttribute('role','button');card.setAttribute('aria-label',file.name);card.setAttribute('aria-haspopup','dialog');card.setAttribute('aria-expanded','false');const reader=new FileReader();reader.onload=()=>{const img=document.createElement('img');img.alt='thumbnail';img.src=reader.result;card.append(img)};reader.readAsDataURL(file)}
 for(const name of [file.name,'Remove '+file.name]){const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',name);button.textContent=name;card.append(button)}
 wrapper.append(card);
}};
document.querySelector('[data-testid="send-button"]').onclick=()=>{window.syntheticSends++;
 const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.dataset.messageId='synthetic-user-turn';
 const bubble=document.createElement('div');bubble.setAttribute('data-user-message-bubble','');bubble.textContent=editor.innerText;user.append(bubble);
 for(const file of input.files){if(file.type.startsWith('image/')){const original=Array.from(document.querySelectorAll('[class~="group/composer-attachment"]')).find(card=>card.getAttribute('aria-label')===file.name)?.querySelector('img');const card=document.createElement('div');card.setAttribute('role','button');card.setAttribute('aria-label','User attachment');const img=original.cloneNode();img.alt='User attachment';img.setAttribute('aria-expanded','false');img.setAttribute('data-state','closed');card.append(img);user.append(card);continue}const card=document.createElement('div');card.className='group/resource-card';const label=document.createElement('span');label.className='truncate';label.title=file.name;card.append(label);
 const button=document.createElement('button');button.type='button';button.setAttribute('aria-label',file.name);button.setAttribute('aria-busy','false');button.textContent=file.name;card.append(button);user.append(card)}
 const article=document.createElement('article');article.append(user);document.querySelector('main').append(article);
 const reply=document.createElement('article');reply.innerHTML='<div data-message-author-role="assistant" data-message-id="synthetic-answer" data-is-streaming="false"><div class="markdown">NATIVE_PROFILE_RECOVERY_OK</div></div>';document.querySelector('main').append(reply);
 editor.innerHTML='';document.querySelector('.flex-wrap').innerHTML='';history.replaceState(null,'','/c/native-profile-recovery');
};</script>`

async function main() {
  await app.whenReady()
  check(safeStorage.isEncryptionAvailable(), "Encrypted native storage unavailable; refusing plaintext test fallback")
  const vaultPath = join(root, "credentials.enc")
  const vault = new GptProCredentialVault({
    path: vaultPath,
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    log,
  })
  let requests = 0
  const profiles = new GptProCredentialProfiles({
    create: (id) => {
      const profile = session.fromPartition(id)
      profile.protocol.handle("https", (request) => {
        const url = new URL(request.url)
        if (url.origin !== "https://chatgpt.com") return new Response("Blocked synthetic origin", { status: 403 })
        if (url.pathname === "/api/auth/session") {
          requests++
          return Response.json({ user: { id: "native-synthetic-account" }, expires: "2099-01-01T00:00:00Z" })
        }
        return new Response(html, { headers: { "Content-Type": "text/html" } })
      })
      return {
        cookies: profile.cookies,
        dispose: async () => {
          profile.protocol.unhandle("https")
          await profile.clearStorageData()
          await profile.closeAllConnections()
        },
      }
    },
    persist: (cookies) => vault.write(cookies),
    changed: () => {},
    log,
  })
  await profiles.jar().set({
    url: GPT_PRO_URL,
    name: "__Secure-next-auth.session-token",
    value: "OLD_SYNTHETIC_ONLY",
    secure: true,
    httpOnly: true,
  })
  await profiles.persist()
  const browser = new BrowserController()
  const window = new BrowserWindow({ show: false, width: 1280, height: 900 })
  browser.attachWindow(window)
  const id = `gpt_${randomUUID()}`
  const oldPageID = `gpt-pro-page-${id}`
  const attachmentName = `${id.slice(4)}-1-managed.txt`
  const stagedPath = join(root, "owned", id, attachmentName)
  mkdirSync(join(root, "owned", id), { recursive: true })
  const bytes = Buffer.from("Synthetic managed attachment; no user files are read.\n")
  writeFileSync(stagedPath, bytes)
  const imageName = `${id.slice(4)}-2-managed.png`
  const imagePath = join(root, "owned", id, imageName)
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=",
    "base64",
  )
  const imageHash = createHash("sha256").update(image).digest("hex")
  writeFileSync(imagePath, image)
  const initial: GptProJob = {
    id,
    owner: "/synthetic\nses_native_profile",
    requestID: "native-profile-recovery",
    phase: "paused",
    prompt: "Return NATIVE_PROFILE_RECOVERY_OK for this synthetic attachment.",
    accountID: createHash("sha256").update("native-synthetic-account").digest("hex"),
    submitted: false,
    sendAttempted: false,
    uploadAttempted: true,
    url: GPT_PRO_URL,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    background: true,
    attachments: [
      {
        id: "managed-image",
        name: "managed.png",
        uploadName: imageName,
        path: join(root, "nonexistent-original.png"),
        mime: "image/png",
        size: image.length,
        sha256: imageHash,
        previewSha256: imageHash,
        status: "ready",
      },
      {
        id: "managed-file",
        name: "managed.txt",
        uploadName: attachmentName,
        path: join(root, "nonexistent-original.txt"),
        mime: "text/plain",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        status: "ready",
      },
    ],
    stagedAttachments: [
      { id: "managed-image", path: imagePath, uploadName: imageName, sha256: imageHash },
      {
        id: "managed-file",
        path: stagedPath,
        uploadName: attachmentName,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  }
  const bodies = createGptProBodyJournal(join(root, "bodies"), log)
  const execution = createGptProExecutionStore(new DatabaseSync(join(root, "execution.db")), log, 500, bodies)
  const controller = new GptProController(
    (job) => new GptProDriver(browser, log, { pageID: job.pageID, profileID: job.profileID }),
    {
      load: () => execution.load(() => [initial]),
      save: (jobs) => execution.save(jobs),
      flush: async () => {
        await execution.flush()
      },
      config: () => ({ enabled: true, timeoutMinutes: 1, maxConcurrent: 1 }),
      setConfig: () => {},
      stagingRoot: () => join(root, "owned"),
      profileID: () => profiles.profileID(),
    },
    log,
    20,
    50,
  )
  const coordinators = new Map<string, GptProSessionCoordinator>()
  const transaction = new GptProLoginTransaction({
    browser,
    controller,
    credentials: {
      ready: async () => {},
      profileID: () => profiles.profileID(),
      stage: (cookies) => profiles.stage(cookies),
      promote: (profile, commit) => profiles.promote(profile, commit),
      retain: (profile) => profiles.retain(profile),
      collect: (retain) => profiles.collect(retain),
    },
    coordinator: (profile) => {
      if (!coordinators.has(profile)) coordinators.set(profile, getGptProSessionCoordinator(browser, profile, log))
      return coordinators.get(profile)!
    },
    changed: () => {},
    log,
  })
  try {
    await browser.openPage(oldPageID, GPT_PRO_PARTITION, GPT_PRO_URL, { kind: "consultation" })
    await browser
      .cdp(oldPageID)!
      .evaluate(`document.getElementById('prompt-textarea').textContent='SYNTHETIC_MANUAL_DRAFT_MUST_SURVIVE'`)
    const before = browser.getState().find((v) => v.pageID === oldPageID)!
    await transaction.import([
      {
        name: "__Secure-next-auth.session-token",
        value: "NEW_SYNTHETIC_ONLY",
        domain: ".chatgpt.com",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: false,
        sameSite: "lax",
        session: true,
      },
    ])
    const migrated = controller.list()[0]
    check(
      migrated.profileID === profiles.profileID() && migrated.pageID !== oldPageID,
      "Managed job did not migrate to a new page/profile",
    )
    check(migrated.phase === "paused" && !migrated.sendAttempted, "Import automatically resumed or sent")
    const old = browser.getState().find((v) => v.pageID === oldPageID)!
    check(old.epoch === before.epoch && old.documentEpoch === before.documentEpoch, "Original document was refreshed")
    check(
      await browser
        .cdp(oldPageID)!
        .evaluate(`document.getElementById('prompt-textarea').textContent==='SYNTHETIC_MANUAL_DRAFT_MUST_SURVIVE'`),
      "Original manual draft changed",
    )
    check(
      (await profiles.jar(GPT_PRO_PARTITION).get({})).some((c) => c.value === "OLD_SYNTHETIC_ONLY"),
      "Old jar was mutated",
    )
    check(
      !(await readFile(vaultPath)).includes(Buffer.from("NEW_SYNTHETIC_ONLY")),
      "Credential plaintext leaked to disk",
    )
    await controller.command({ action: "resume", id }, initial.owner)
    const deadline = Date.now() + 20_000
    while (controller.list()[0].phase !== "completed") {
      if (Date.now() > deadline || controller.list()[0].phase === "paused")
        throw Error(`Recovery failed phase=${controller.list()[0].phase} error=${controller.list()[0].error ?? "none"}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const recovered = controller.list()[0]
    const counts = await browser
      .cdp(recovered.pageID!)!
      .evaluate<{ sends: number; uploads: number }>(`({sends:window.syntheticSends,uploads:window.syntheticUploads})`)
    check(counts.sends === 1 && counts.uploads === 1, "Managed recovery duplicated send or upload")
    check(
      controller
        .notifications()
        .some((event) => event.kind === "completed" && event.text.includes("NATIVE_PROFILE_RECOVERY_OK")),
      "Completion outbox missing",
    )
    const benchmark = await runGptProPerformanceCase(browser, profiles.profileID(), root)
    await writeFile(join(root, "performance.json"), JSON.stringify(benchmark, null, 2))
    log(
      `performance criticalP95Ms=${benchmark.persistence.criticalCommits.p95Ms.toFixed(2)} criticalP99Ms=${benchmark.persistence.criticalCommits.p99Ms.toFixed(2)} incrementalBlocks=${benchmark.capture.incremental.recomputedBlocksMax} baselineBlocks=${benchmark.capture.full.recomputedBlocksMax}`,
    )
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          synthetic: true,
          offline: true,
          oldJarPreserved: true,
          oldDraftPreserved: true,
          importAutoSends: 0,
          recoveredSends: counts.sends,
          recoveredUploads: counts.uploads,
          recoveredAttachments: 2,
          imagePreviewHashVerified: true,
          encrypted: true,
          authenticationRequests: requests,
          completed: true,
        },
        null,
        2,
      ),
    )
    log(`PASS native isolated candidate promotion and staged recovery; evidence=${join(root, "result.json")}`)
  } finally {
    controller.dispose()
    coordinators.forEach((coordinator) => coordinator.dispose())
    browser.dispose()
    await execution.close()
    await bodies.close()
    window.destroy()
  }
}
void main().then(
  () => app.exit(0),
  (error) => {
    log(`FAIL ${String(error)} evidenceRoot=${root}`)
    app.exit(1)
  },
)
