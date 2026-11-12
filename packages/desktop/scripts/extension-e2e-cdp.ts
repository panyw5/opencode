/**
 * extension-e2e-cdp.ts — T6.2 desktop CDP end-to-end script.
 *
 * Connects over CDP :9222 to an ALREADY-RUNNING dev desktop renderer
 * (`bun run dev:desktop`) and exercises the real extension lifecycle:
 *
 *   probe → pack hello-viewer → preclean → install (local archive bridge)
 *   → open .hello file → assert viewer DOM + injected styles
 *   → disable → assert DOM/style teardown → uninstall → assert cleanup
 *
 * The script never launches or quits any app instance. If no CDP page
 * target is available it exits non-zero with an explanatory message.
 * On assertion failure it saves a screenshot under /tmp and attempts
 * best-effort cleanup without touching the app.
 *
 * Usage:
 *   bun packages/desktop/scripts/extension-e2e-cdp.ts [options]
 *
 * Options:
 *   --help, -h            Show this help and exit.
 *   --probe               Only check the CDP endpoint for a usable page target.
 *   --endpoint <url>      CDP endpoint (default http://127.0.0.1:9222,
 *                         env OPENCODE_CDP_ENDPOINT).
 *   --project <dir>       Workspace directory used to select a session tab and
 *                         host the .hello fixture (default: repo root,
 *                         env OC_E2E_PROJECT).
 *   --archive <path>      Use a prebuilt hello-viewer .tgz instead of packing
 *                         packages/extensions/hello-viewer (env OC_E2E_ARCHIVE).
 *
 * Notes:
 *   - The packed fixture strips package.json `engines`. Dev sidecar builds
 *     report a prerelease version (e.g. 1.18.64-local.YYYYMMDDHHMM), which
 *     does not satisfy `engines.opencode: ">=x.y.z"`, so preparation would
 *     fail before the archive is ever exercised.
 *   - Repeated runs are idempotent: an existing `example.hello-viewer`
 *     installation is disabled and uninstalled before installing again.
 */
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { connectCdp, listTargets, pickPageTarget, type CdpClient } from "./cdp"

const EXTENSION_ID = "example.hello-viewer"
const FIXTURE_NAME = "e2e-hello-viewer-fixture.hello"
const FIXTURE_MARKER = "E2E_HELLO_MARKER_LINE_ONE"
const FIXTURE_TEXT = `${FIXTURE_MARKER}\nsecond e2e line\nthird e2e line\n`
const ARTIFACT_DIR = "/tmp/oc-ext-e2e-artifacts"
// Dev sidecar data root; only used to inspect the retained tombstone so a
// stale fingerprint from an older pack can be reconciled instead of failing.
const REGISTRY_PATH = Bun.env.OC_E2E_REGISTRY || `${Bun.env.HOME}/.local/share/opencode/extensions/registry.json`
const DEFAULT_ENDPOINT = "http://127.0.0.1:9222"
const POLL_INTERVAL_MS = 400
const DEFAULT_TIMEOUT_MS = 20_000

const repoRoot = path.resolve(import.meta.dir, "../../..")
const extensionRoot = path.join(repoRoot, "packages/extensions/hello-viewer")

type Options = {
  endpoint: string
  project: string
  archive?: string
  probeOnly: boolean
}

class StepError extends Error {
  constructor(
    readonly phase: string,
    message: string,
  ) {
    super(message)
    this.name = "StepError"
  }
}

function usage() {
  return [
    "extension-e2e-cdp.ts — exercise the extension lifecycle against the",
    "already-running dev desktop app over CDP :9222.",
    "",
    "Usage: bun packages/desktop/scripts/extension-e2e-cdp.ts [options]",
    "",
    "Options:",
    "  --help, -h          Show this help and exit",
    "  --probe             Only verify that a usable CDP page target exists",
    "  --endpoint <url>    CDP endpoint (env OPENCODE_CDP_ENDPOINT,",
    "                      default http://127.0.0.1:9222)",
    "  --project <dir>     Workspace directory for the session tab + .hello",
    "                      fixture (env OC_E2E_PROJECT, default repo root)",
    "  --archive <path>    Prebuilt hello-viewer .tgz (env OC_E2E_ARCHIVE)",
    "",
    "The script never starts or stops any app. Missing targets exit non-zero.",
    "Assertion failures save a screenshot under /tmp/extension-e2e-cdp-*.png.",
  ].join("\n")
}

function parseArgs(argv: string[]): Options | "help" {
  const options: Options = {
    endpoint: Bun.env.OPENCODE_CDP_ENDPOINT || DEFAULT_ENDPOINT,
    project: Bun.env.OC_E2E_PROJECT || repoRoot,
    archive: Bun.env.OC_E2E_ARCHIVE || undefined,
    probeOnly: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return "help"
    if (arg === "--probe") {
      options.probeOnly = true
      continue
    }
    if (arg === "--endpoint") {
      options.endpoint = argv[++index] ?? ""
      continue
    }
    if (arg === "--project") {
      options.project = argv[++index] ?? ""
      continue
    }
    if (arg === "--archive") {
      options.archive = argv[++index] ?? ""
      continue
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`)
  }
  return options
}

function log(phase: string, message: string) {
  console.log(`[extension-e2e] ${phase}: ${message}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Evaluate an async/string expression in the renderer and return its value. */
function evaluate<T>(client: CdpClient, expression: string) {
  return client.evaluate<T>(expression)
}

/**
 * Poll a renderer predicate until it returns a truthy value. The predicate
 * source must be a self-contained expression evaluating to a value (or
 * promise of one); the resolved value is returned.
 */
async function waitFor<T>(client: CdpClient, phase: string, label: string, expression: string, timeout = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      last = await evaluate<T>(client, expression)
      if (last) return last
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new StepError(phase, `Timed out after ${timeout}ms waiting for: ${label} (last=${JSON.stringify(last)})`)
}

async function screenshot(client: CdpClient, phase: string) {
  const file = `/tmp/extension-e2e-cdp-${phase}-${Date.now()}.png`
  try {
    await client.call("Page.enable")
    const shot = await client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await writeFile(file, Buffer.from(shot.data, "base64"))
    log(phase, `screenshot saved: ${file}`)
  } catch (error) {
    log(phase, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return file
}

async function clickElement(client: CdpClient, phase: string, selector: string, label: string) {
  const result = await evaluate<{ ok: boolean }>(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false }
      el.scrollIntoView({ block: "center", inline: "center" })
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
      return { ok: true }
    })()`,
  )
  if (!result?.ok) throw new StepError(phase, `Element not found for click: ${label} (${selector})`)
}

async function clickAtCenter(client: CdpClient, phase: string, selector: string, label: string) {
  const rect = await evaluate<{ x: number; y: number } | undefined>(
    client,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return undefined
      el.scrollIntoView({ block: "center", inline: "center" })
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return undefined
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`,
  )
  if (!rect) throw new StepError(phase, `Element not visible for click: ${label} (${selector})`)
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 })
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 })
}

async function typeText(client: CdpClient, text: string) {
  await client.call("Input.insertText", { text })
}

async function pressKey(client: CdpClient, key: string) {
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key })
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key })
}

// ---------------------------------------------------------------------------
// Renderer-side helpers (evaluated in the page)
// ---------------------------------------------------------------------------

const EXTENSION_LIST_JS = `(async () => {
  const ready = await window.api.awaitInitialization()
  const auth = "Basic " + btoa("opencode:" + ready.password)
  const res = await fetch(ready.url + "/global/extension", { headers: { authorization: auth } })
  if (!res.ok) return { ok: false, status: res.status }
  const list = await res.json()
  const item = list.find((entry) => entry.id === ${JSON.stringify(EXTENSION_ID)})
  return { ok: true, found: !!item, enabled: item?.enabled === true, state: item?.state, ids: list.map((entry) => entry.id) }
})()`

const DISABLE_JS = `(async () => {
  const ready = await window.api.awaitInitialization()
  const auth = "Basic " + btoa("opencode:" + ready.password)
  const res = await fetch(ready.url + "/global/extension/" + ${JSON.stringify(EXTENSION_ID)} + "/disable", {
    method: "POST",
    headers: { authorization: auth },
  })
  return { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 300) }
})()`

const UNINSTALL_JS = `(async () => {
  const ready = await window.api.awaitInitialization()
  const auth = "Basic " + btoa("opencode:" + ready.password)
  const prepare = await fetch(ready.url + "/global/extension/prepare", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ kind: "uninstall", id: ${JSON.stringify(EXTENSION_ID)}, purgeData: true }),
  })
  const preview = await prepare.json()
  if (!prepare.ok) return { step: "prepare", status: prepare.status, ok: false, body: JSON.stringify(preview).slice(0, 300) }
  const res = await fetch(ready.url + "/global/extension/" + encodeURIComponent(preview.id), {
    method: "DELETE",
    headers: { authorization: auth, "content-type": "application/json", "x-opencode-extension-token": preview.token },
    body: JSON.stringify({ operationId: preview.operationId }),
  })
  return { step: "commit", status: res.status, ok: res.ok, body: (await res.text()).slice(0, 300) }
})()`

const VIEWER_STATE_JS = `(() => ({
  viewer: !!document.querySelector(".oc-hello-viewer-root"),
  title: document.querySelector(".oc-hello-viewer-title")?.textContent ?? null,
  path: document.querySelector(".oc-hello-viewer-path")?.textContent ?? null,
  marker: document.body.innerText.includes(${JSON.stringify(FIXTURE_MARKER)}),
  style: !!document.querySelector('link[data-extension=${JSON.stringify(EXTENSION_ID)}]'),
  sourceShown: !!document.querySelector('[data-component="file"]'),
}))()`

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function probe(endpoint: string) {
  const targets = await listTargets(endpoint).catch((error) => {
    throw new StepError(
      "probe",
      `CDP endpoint ${endpoint} is unreachable (${error instanceof Error ? error.message : String(error)}). ` +
        `Start the dev app with \`bun run dev:desktop\`; this script never launches one.`,
    )
  })
  const target = pickPageTarget(targets)
  if (!target) {
    throw new StepError(
      "probe",
      `No usable page target at ${endpoint} (saw ${targets.length} target(s): ` +
        `${targets.map((item) => `${item.type}:${item.url.slice(0, 60)}`).join(", ") || "none"}). ` +
        `Confirm the dev Electron renderer is running with remote debugging on 9222.`,
    )
  }
  log("probe", `found page target "${target.title}" at ${target.url}`)
  return target
}

async function packExtension(options: Options) {
  const phase = "pack"
  if (options.archive) {
    const bytes = await readFile(options.archive)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    log(phase, `using prebuilt archive ${options.archive} bytes=${bytes.length} sha256=${sha256}`)
    return { archive: options.archive, sha256 }
  }
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const pkg = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"))
  // Dev sidecar versions are prereleases (e.g. 1.18.64-local.xxx) which can
  // never satisfy `engines.opencode`; strip it so the dev install can proceed.
  if (pkg.engines) {
    delete pkg.engines
    log(phase, "stripped package.json engines (dev sidecar prerelease version cannot satisfy engines.opencode)")
  }
  const require = createRequire(path.join(repoRoot, "packages/opencode/package.json"))
  const tar = require("tar-stream") as typeof import("tar-stream")
  const archive = tar.pack()
  const chunks: Buffer[] = []
  const drain = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk))
  })()
  // A fixed mtime keeps the archive bytes deterministic so the sha256 is
  // stable across runs (mtime:0 is falsy and tar-stream would fall back to
  // the current time).
  const epoch = new Date(0)
  archive.entry({ name: "package/package.json", mtime: epoch }, JSON.stringify(pkg, null, 2))
  for (const file of ["dist/server.js", "dist/web/index.js", "dist/web/index.css"]) {
    archive.entry({ name: `package/${file}`, mtime: epoch }, await readFile(path.join(extensionRoot, file)))
  }
  archive.finalize()
  await drain
  const bytes = gzipSync(Buffer.concat(chunks))
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  // Per-sha artifacts are kept so a future run can reinstall the exact bytes
  // a retained tombstone still references.
  const file = path.join(ARTIFACT_DIR, `hello-viewer-e2e-${sha256.slice(0, 12)}.tgz`)
  await writeFile(file, bytes)
  log(phase, `packed ${file} bytes=${bytes.length} sha256=${sha256}`)
  return { archive: file, sha256 }
}

async function extensionState(client: CdpClient) {
  return evaluate<{ ok: boolean; found?: boolean; enabled?: boolean; state?: string; ids?: string[]; status?: number }>(
    client,
    EXTENSION_LIST_JS,
  )
}

async function archiveOp<T>(client: CdpClient, op: "prepare" | "commit" | "status" | "cancel", payload: unknown) {
  return evaluate<{ ok: boolean; value?: T; error?: { code?: string; message?: string } }>(
    client,
    `(async () => window.api.extensionArchiveOp(${JSON.stringify(op)}, ${JSON.stringify(payload)}))()`,
  )
}

async function preclean(client: CdpClient, archive: string, sha256: string) {
  const phase = "preclean"
  const state = await extensionState(client)
  if (!state?.ok) throw new StepError(phase, `Extension list request failed (status=${state?.status})`)
  if (!state.found) {
    log(phase, "no previous installation found")
    await reconcileTombstone(client, archive, sha256)
    return
  }
  log(phase, `found existing installation (enabled=${state.enabled} state=${state.state}); removing it first`)
  // Normalize the recorded source identity to this run's archive before
  // uninstalling: the uninstall tombstone is written from the row, so
  // updating first keeps the retained fingerprint identical to what the
  // next install will present even if a previous run used other bytes.
  const update = await archiveOp<{ operationId: string; token: string }>(client, "prepare", {
    request: { kind: "update", id: EXTENSION_ID, source: { type: "local", path: archive, sha256 } },
  })
  if (update.ok && update.value) {
    const committed = await archiveOp(client, "commit", {
      operationId: update.value.operationId,
      token: update.value.token,
      input: {},
    })
    log(phase, `source identity normalized via update (ok=${committed?.ok === true})`)
  } else {
    log(phase, `update-before-uninstall skipped (${update.error?.code ?? "unavailable"}); continuing`)
  }
  if (state.enabled) {
    const disabled = await evaluate<{ ok: boolean; status: number }>(client, DISABLE_JS)
    log(phase, `disable existing installation status=${disabled?.status}`)
  }
  const removed = await evaluate<{ ok: boolean; status: number; body?: string }>(client, UNINSTALL_JS)
  if (!removed?.ok) throw new StepError(phase, `Failed to uninstall stale extension: ${JSON.stringify(removed)}`)
  await waitFor(client, phase, `extension ${EXTENSION_ID} absent from list`, `(async () => {
    const ready = await window.api.awaitInitialization()
    const auth = "Basic " + btoa("opencode:" + ready.password)
    const res = await fetch(ready.url + "/global/extension", { headers: { authorization: auth } })
    if (!res.ok) return false
    const list = await res.json()
    return !list.some((entry) => entry.id === ${JSON.stringify(EXTENSION_ID)})
  })()`)
  log(phase, "stale installation removed")
}

type Retained = { purgedAt?: number; source?: { sha256?: string } }

/**
 * An uninstalled extension can still block reinstalls: the registry keeps a
 * retained tombstone keyed by source identity, and archive installs only
 * inherit data when the sha256 matches. When a previous run left a tombstone
 * whose fingerprint differs from this run's pack, reinstall the exact bytes
 * it references (kept as per-sha artifacts) and immediately re-uninstall so
 * the tombstone is rewritten with this run's identity.
 */
async function reconcileTombstone(client: CdpClient, archive: string, sha256: string) {
  const phase = "preclean"
  let retained: Retained | undefined
  try {
    const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8"))
    retained = registry?.retained?.[EXTENSION_ID]
  } catch {
    return
  }
  if (!retained || retained.purgedAt !== undefined) return
  const retainedSha = retained.source?.sha256
  if (!retainedSha || retainedSha === sha256) {
    log(phase, "retained tombstone matches this pack (or has no sha256); install can proceed")
    return
  }
  const candidate = path.join(ARTIFACT_DIR, `hello-viewer-e2e-${retainedSha.slice(0, 12)}.tgz`)
  try {
    await readFile(candidate)
  } catch {
    log(phase, `stale tombstone references sha256 ${retainedSha.slice(0, 12)}… with no retained artifact; ` +
      `install will rely on the deferred purge or fail with a tombstone conflict`)
    return
  }
  log(phase, `stale tombstone sha=${retainedSha.slice(0, 12)}…; bootstrap-installing matching artifact`)
  const prepared = await archiveOp<{ operationId: string; token: string }>(client, "prepare", {
    request: { kind: "install", source: { type: "local", path: candidate, sha256: retainedSha } },
  })
  if (!prepared.ok || !prepared.value) {
    log(phase, `bootstrap install prepare failed (${prepared.error?.code}); continuing anyway`)
    return
  }
  const installed = await archiveOp(client, "commit", {
    operationId: prepared.value.operationId,
    token: prepared.value.token,
    input: { enable: false },
  })
  if (!installed.ok) {
    log(phase, "bootstrap install commit failed; continuing anyway")
    return
  }
  // Rewrite the tombstone identity to this run's archive, then uninstall.
  const update = await archiveOp<{ operationId: string; token: string }>(client, "prepare", {
    request: { kind: "update", id: EXTENSION_ID, source: { type: "local", path: archive, sha256 } },
  })
  if (update.ok && update.value) {
    await archiveOp(client, "commit", { operationId: update.value.operationId, token: update.value.token, input: {} })
  }
  const removed = await evaluate<{ ok: boolean }>(client, UNINSTALL_JS)
  log(phase, `bootstrap normalization finished (uninstall ok=${removed?.ok === true})`)
}

async function install(client: CdpClient, archive: string, sha256: string) {
  const phase = "install"
  log(phase, `preparing local archive install from ${archive}`)
  const prepared = await archiveOp<{ operationId: string; token: string; id: string; version: string }>(client, "prepare", {
    request: { kind: "install", source: { type: "local", path: archive, sha256 } },
  })
  if (!prepared?.ok || !prepared.value) {
    throw new StepError(
      phase,
      `Extension prepare failed: ${JSON.stringify(prepared?.error ?? prepared)} ` +
        `(check the sidecar build version supports this archive)`,
    )
  }
  log(phase, `prepared operationId=${prepared.value.operationId} id=${prepared.value.id} version=${prepared.value.version}`)
  // A retained tombstone from a previous uninstall whose purge is still in
  // flight can briefly reject commits; retry the known conflict a few times.
  let committed: { ok: boolean; error?: { code?: string; message?: string } } | undefined
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    committed = await archiveOp(client, "commit", {
      operationId: prepared.value.operationId,
      token: prepared.value.token,
      input: { enable: true },
    })
    const conflict = committed?.error?.message?.includes("different installation") === true
    if (committed?.ok || !conflict) break
    log(phase, `commit conflict on retained data (attempt ${attempt}/4); waiting for purge to settle`)
    await sleep(1500)
  }
  if (!committed?.ok) {
    throw new StepError(
      phase,
      `Extension commit failed: ${JSON.stringify(committed?.error ?? committed)}. ` +
        `If this mentions a different installation, a stale retained tombstone with a foreign ` +
        `archive fingerprint is blocking reinstall; reinstall the matching archive or wait for ` +
        `the deferred data purge to finish.`,
    )
  }
  log(phase, "commit succeeded; waiting for the extension to appear enabled")
  await waitFor(client, phase, `extension ${EXTENSION_ID} enabled`, `(async () => {
    const ready = await window.api.awaitInitialization()
    const auth = "Basic " + btoa("opencode:" + ready.password)
    const res = await fetch(ready.url + "/global/extension", { headers: { authorization: auth } })
    if (!res.ok) return false
    const list = await res.json()
    const item = list.find((entry) => entry.id === ${JSON.stringify(EXTENSION_ID)})
    return !!item && item.enabled === true
  })()`)
  log(phase, "extension installed and enabled")
}

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function waitForFixtureIndexed(client: CdpClient, project: string) {
  const phase = "fixture"
  // The open-file dialog queries GET /find/file, which is backed by the
  // server's file index; wait until the freshly-written fixture is visible
  // there instead of racing the file watcher.
  await waitFor(
    client,
    phase,
    `fixture ${FIXTURE_NAME} indexed by /find/file`,
    `(async () => {
      const ready = await window.api.awaitInitialization()
      const auth = "Basic " + btoa("opencode:" + ready.password)
      const res = await fetch(ready.url + "/find/file?query=" + encodeURIComponent(${JSON.stringify(FIXTURE_NAME)}) + "&directory=" + encodeURIComponent(${JSON.stringify(project)}), {
        headers: { authorization: auth },
      })
      if (!res.ok) return false
      const files = await res.json()
      return Array.isArray(files) && files.some((file) => file.endsWith(${JSON.stringify(FIXTURE_NAME)}))
    })()`,
    60_000,
  )
  log(phase, "fixture is visible to the file index")
}

async function selectSession(client: CdpClient, project: string) {
  const phase = "select-session"
  const tabs = await evaluate<{ directory: string | null; id: string | null }[]>(
    client,
    `(() => [...document.querySelectorAll('[data-component="session-tab"]')]
      .map((el) => ({ directory: el.getAttribute("data-directory"), id: el.getAttribute("data-session-id") })))()`,
  )
  log(phase, `session tabs: ${JSON.stringify(tabs)}`)
  const match = tabs.find((tab) => tab.directory === project)
  if (match) {
    await clickElement(
      client,
      phase,
      `[data-component="session-tab"][data-session-id=${JSON.stringify(match.id)}]`,
      `session tab ${match.id}`,
    )
    log(phase, `selected session ${match.id} for ${project}`)
    await waitFor(client, phase, "prompt editor", `!!document.querySelector('[contenteditable="true"]')`)
    return { created: undefined }
  }
  // No open tab for the project: create a real session through the server API
  // and navigate to its route. A bare directory route only yields a draft
  // prompt whose file-open dialog searches the previously active workspace.
  const created = await evaluate<{ ok: boolean; id?: string; status?: number }>(
    client,
    `(async () => {
      const ready = await window.api.awaitInitialization()
      const auth = "Basic " + btoa("opencode:" + ready.password)
      const res = await fetch(ready.url + "/session?directory=" + encodeURIComponent(${JSON.stringify(project)}), {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ title: "e2e-extension-cdp" }),
      })
      if (!res.ok) return { ok: false, status: res.status }
      const session = await res.json()
      return { ok: true, id: session.id }
    })()`,
  )
  if (!created?.ok || !created.id) {
    throw new StepError(phase, `Failed to create a session in ${project} (status=${created?.status})`)
  }
  const href = `/${base64Url(project)}/session/${created.id}`
  log(phase, `created session ${created.id}; navigating to ${href}`)
  await evaluate(client, `(() => { location.assign(${JSON.stringify(href)}); return true })()`)
  await waitFor(
    client,
    phase,
    `prompt editor for ${project}`,
    `(() => {
      const editor = document.querySelector('[contenteditable="true"]')
      return !!editor && location.pathname.startsWith(${JSON.stringify(`/${base64Url(project)}`)})
    })()`,
    30_000,
  )
  return { created: created.id }
}

/**
 * The file-open dialog resolves its search directory from the active
 * workspace context, which can differ from the route session's directory.
 * Sniff the actual /find/file request to learn where the fixture must live.
 */
async function detectSearchDirectory(client: CdpClient, fallback: string) {
  const phase = "detect-dir"
  await evaluate(
    client,
    `(() => {
      window.__e2eFind = []
      window.__e2eFetch = window.fetch
      window.fetch = (input, init) => {
        window.__e2eFind.push(typeof input === "string" ? input : input.url)
        return window.__e2eFetch(input, init)
      }
      return true
    })()`,
  )
  try {
    await pressKey(client, "Escape")
    await sleep(300)
    await clearPrompt(client)
    if (!(await focusPrompt(client))) throw new StepError(phase, "prompt editor did not take focus")
    await typeText(client, "/open")
    await waitFor(client, phase, "file.open slash item", `!!document.querySelector('[data-slash-id="file.open"]')`, 8000)
    await clickElement(client, phase, '[data-slash-id="file.open"]', "file.open slash command")
    await waitFor(
      client,
      phase,
      "open-file dialog input",
      `!!document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')`,
    )
    await typeText(client, "e2e-dir-probe")
    const directory = await waitFor<string>(
      client,
      phase,
      "sniffed /find/file directory",
      `(() => {
        const hit = window.__e2eFind.find((url) => url.includes("/find/file"))
        if (!hit) return null
        return new URL(hit).searchParams.get("directory")
      })()`,
      10_000,
    )
    log(phase, `dialog searches directory ${directory}`)
    return directory || fallback
  } catch (error) {
    log(phase, `sniff failed (${error instanceof Error ? error.message : String(error)}); falling back to ${fallback}`)
    return fallback
  } finally {
    await pressKey(client, "Escape").catch(() => undefined)
    await evaluate(
      client,
      `(() => { if (window.__e2eFetch) { window.fetch = window.__e2eFetch; window.__e2eFetch = undefined } return true })()`,
    ).catch(() => undefined)
  }
}

const PROMPT_EDITOR_JS = `(() => {
  // [data-component="prompt-input"] is only an empty positioning anchor; the
  // real editor is the contenteditable surface overlapping it.
  const editor = document.querySelector('[contenteditable="true"]')
  if (!editor) return { ok: false, reason: "no contenteditable" }
  editor.focus()
  return { ok: document.activeElement === editor }
})()`

async function focusPrompt(client: CdpClient) {
  const result = await evaluate<{ ok: boolean }>(client, PROMPT_EDITOR_JS)
  if (!result?.ok) return false
  return true
}

async function clearPrompt(client: CdpClient) {
  await evaluate(
    client,
    `(() => {
      const editor = document.querySelector('[contenteditable="true"]')
      if (!editor) return false
      editor.focus()
      document.execCommand("selectAll")
      document.execCommand("delete")
      return true
    })()`,
  )
}

async function openFixtureFile(client: CdpClient) {
  const phase = "open-file"
  await pressKey(client, "Escape")
  await sleep(300)
  await waitFor(client, phase, "prompt editor", `!!document.querySelector('[contenteditable="true"]')`)
  let opened = false
  for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
    log(phase, `focusing prompt and typing /open (attempt ${attempt}/3)`)
    await clearPrompt(client)
    if (!(await focusPrompt(client))) {
      log(phase, "prompt editor did not take focus; retrying")
      await sleep(500)
      continue
    }
    await typeText(client, "/open")
    opened = await waitFor(
      client,
      phase,
      "file.open slash item",
      `!!document.querySelector('[data-slash-id="file.open"]')`,
      6000,
    )
      .then(() => true)
      .catch(() => false)
  }
  if (!opened) {
    throw new StepError(phase, "Typing /open into the focused prompt never raised the slash menu")
  }
  await clickElement(client, phase, '[data-slash-id="file.open"]', "file.open slash command")
  await waitFor(
    client,
    phase,
    "open-file dialog input",
    `!!document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')`,
  )
  log(phase, `typing fixture filename ${FIXTURE_NAME}`)
  await typeText(client, FIXTURE_NAME)
  const keySelector = `[data-slot="list-item"][data-key="file:${FIXTURE_NAME}"]`
  await waitFor(client, phase, `file result ${FIXTURE_NAME}`, `!!document.querySelector(${JSON.stringify(keySelector)})`)
  await clickElement(client, phase, keySelector, `file result ${FIXTURE_NAME}`)
  await waitFor(client, phase, "hello viewer DOM", `!!document.querySelector(".oc-hello-viewer-root")`)
  log(phase, "fixture file opened")
}

async function assertViewer(client: CdpClient) {
  const phase = "assert-render"
  const state = await evaluate<{
    viewer: boolean
    title: string | null
    path: string | null
    marker: boolean
    style: boolean
  }>(client, VIEWER_STATE_JS)
  const failures: string[] = []
  if (!state?.viewer) failures.push("hello viewer root (.oc-hello-viewer-root) is not rendered")
  if (state?.title !== "Hello Viewer") failures.push(`unexpected viewer title: ${JSON.stringify(state?.title)}`)
  if (state?.path !== FIXTURE_NAME) failures.push(`unexpected viewer path: ${JSON.stringify(state?.path)}`)
  if (!state?.marker) failures.push(`fixture marker text ${FIXTURE_MARKER} not visible in the rendered view`)
  if (!state?.style) failures.push(`extension stylesheet link[data-extension=${EXTENSION_ID}] is not injected`)
  if (failures.length > 0) throw new StepError(phase, `Viewer assertions failed:\n - ${failures.join("\n - ")}`)
  log(phase, "viewer DOM, marker text and injected stylesheet verified")
}

async function disableExtension(client: CdpClient) {
  const phase = "disable"
  const result = await evaluate<{ ok: boolean; status: number; body?: string }>(client, DISABLE_JS)
  if (!result?.ok) throw new StepError(phase, `Disable request failed (status=${result?.status}): ${result?.body}`)
  log(phase, "disable request accepted; waiting for contribution teardown")
  await waitFor(
    client,
    phase,
    "viewer DOM and extension styles removed",
    `(() => !document.querySelector(".oc-hello-viewer-root") && !document.querySelector('link[data-extension=${JSON.stringify(EXTENSION_ID)}]'))()`,
  )
  log(phase, "viewer DOM and injected stylesheet removed after disable")
}

async function uninstallExtension(client: CdpClient) {
  const phase = "uninstall"
  const result = await evaluate<{ ok: boolean; status: number; body?: string }>(client, UNINSTALL_JS)
  if (!result?.ok) throw new StepError(phase, `Uninstall failed: ${JSON.stringify(result)}`)
  log(phase, "uninstall committed; waiting for registry cleanup")
  await waitFor(client, phase, `extension ${EXTENSION_ID} absent from list`, `(async () => {
    const ready = await window.api.awaitInitialization()
    const auth = "Basic " + btoa("opencode:" + ready.password)
    const res = await fetch(ready.url + "/global/extension", { headers: { authorization: auth } })
    if (!res.ok) return false
    const list = await res.json()
    return !list.some((entry) => entry.id === ${JSON.stringify(EXTENSION_ID)})
  })()`)
  const state = await evaluate<{ viewer: boolean; style: boolean }>(client, VIEWER_STATE_JS)
  if (state?.viewer || state?.style) {
    throw new StepError(
      phase,
      `Extension uninstalled but contributions remain (viewer=${state?.viewer} style=${state?.style})`,
    )
  }
  log(phase, "extension removed from registry; no viewer/style residue")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === "help") {
    console.log(usage())
    return
  }
  const options = parsed
  log("start", `endpoint=${options.endpoint} project=${options.project}`)

  await probe(options.endpoint)
  if (options.probeOnly) {
    log("probe", "usable target found; exiting (--probe)")
    return
  }

  const { client } = await connectCdp(options.endpoint)
  let installed = false
  let fixturePath: string | undefined
  let createdSession: { id: string; directory: string } | undefined
  let phase = "run"
  try {
    const packed = await packExtension(options)

    phase = "preclean"
    await preclean(client, packed.archive, packed.sha256)

    phase = "install"
    await install(client, packed.archive, packed.sha256)
    installed = true

    phase = "select-session"
    const session = await selectSession(client, options.project)
    if (session.created) createdSession = { id: session.created, directory: options.project }

    phase = "detect-dir"
    const searchDirectory = await detectSearchDirectory(client, options.project)

    phase = "fixture"
    fixturePath = path.join(searchDirectory, FIXTURE_NAME)
    await Bun.write(fixturePath, FIXTURE_TEXT)
    log(phase, `wrote ${fixturePath}`)
    await waitForFixtureIndexed(client, searchDirectory)

    phase = "open-file"
    await openFixtureFile(client)

    phase = "assert-render"
    await assertViewer(client)

    phase = "disable"
    await disableExtension(client)

    phase = "uninstall"
    await uninstallExtension(client)
    installed = false

    log("done", "extension lifecycle verified end-to-end")
  } catch (error) {
    const step = error instanceof StepError ? error.phase : phase
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[extension-e2e] FAILED at ${step}: ${message}`)
    await screenshot(client, step)
    process.exitCode = 1
  } finally {
    if (installed) {
      try {
        log("cleanup", "attempting best-effort uninstall of the test extension")
        await evaluate(client, DISABLE_JS)
        await evaluate(client, UNINSTALL_JS)
      } catch (error) {
        log("cleanup", `uninstall attempt failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (fixturePath) {
      await rm(fixturePath, { force: true }).catch(() => undefined)
      log("cleanup", `removed fixture ${fixturePath}`)
    }
    if (createdSession) {
      try {
        const removed = await evaluate<{ ok: boolean; status: number }>(
          client,
          `(async () => {
            const ready = await window.api.awaitInitialization()
            const auth = "Basic " + btoa("opencode:" + ready.password)
            const res = await fetch(ready.url + "/session/" + ${JSON.stringify(createdSession.id)} + "?directory=" + encodeURIComponent(${JSON.stringify(createdSession.directory)}), {
              method: "DELETE",
              headers: { authorization: auth },
            })
            return { ok: res.ok, status: res.status }
          })()`,
        )
        log("cleanup", `deleted e2e session ${createdSession.id} (status=${removed?.status})`)
      } catch (error) {
        log("cleanup", `session delete failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    client.close()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[extension-e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
