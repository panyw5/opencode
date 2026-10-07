// From packages/desktop:
// bun build scripts/test-updater-download.ts --target=node --format=esm --packages=external --outfile=out/updater-download-test.mjs
// node_modules/.bin/electron out/updater-download-test.mjs
// Uses an isolated local feed/cache and never installs an update.
import { app } from "electron"
import pkg from "electron-updater"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { createUpdaterController } from "../src/main/updater-controller"
import { createUpdaterBackend } from "../src/main/updater-backend"

const root = mkdtempSync(join(tmpdir(), "opencode-updater-test-"))
app.setPath("userData", root)
const payload = Buffer.alloc(2 * 1024 * 1024, 42)
const checksum = createHash("sha512").update(payload).digest("base64")
let requests = 0
let interrupted = 0
const server = createServer((request, response) => {
  if (request.url?.startsWith("/latest-mac.yml")) {
    response.end(
      `version: 99.1.0\nfiles:\n  - url: update-arm64.zip\n    sha512: ${checksum}\n    size: ${payload.length}\npath: update-arm64.zip\nsha512: ${checksum}\n`,
    )
    return
  }
  requests++
  response.writeHead(200, { "Content-Length": payload.length })
  let offset = 0
  const timer = setInterval(() => {
    response.write(payload.subarray(offset, offset + 64 * 1024))
    offset += 64 * 1024
    if (offset >= payload.length) response.end()
  }, 80)
  response.on("close", () => {
    clearInterval(timer)
    if (offset < payload.length) interrupted++
    console.log(`[updater-test] http closed bytes=${offset} interrupted=${interrupted}`)
  })
})

async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for updater state")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function main() {
  await app.whenReady()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const config = join(root, "app-update.yml")
  writeFileSync(config, "updaterCacheDirName: updater-test\n")
  const updater = new pkg.MacUpdater({ provider: "generic", url: `http://127.0.0.1:${address.port}` })
  Object.defineProperty(updater, "app", {
    value: {
      version: "1.0.0",
      name: "updater-test",
      isPackaged: true,
      appUpdateConfigPath: config,
      userDataPath: root,
      baseCachePath: root,
      whenReady: () => app.whenReady(),
      quit: () => {},
      relaunch: () => {},
      onQuit: () => {},
    },
  })
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.disableDifferentialDownload = true
  updater.logger = {
    info: (message) => console.log(String(message)),
    warn: (message) => console.log(String(message)),
    error: (message) => console.error(String(message)),
    debug: (message) => console.log(message),
  }
  let stored: { version: string } | undefined
  const ctrl = createUpdaterController({
    enabled: true,
    currentVersion: "1.0.0",
    backend: createUpdaterBackend(updater, console.log),
    persistence: {
      get: () => stored,
      set: (value) => {
        stored = value
      },
      clear: () => {
        stored = undefined
      },
    },
    stop: async () => {},
    log: console.log,
  })
  const first = ctrl.check()
  await waitFor(() => {
    const s = ctrl.getState()
    return s.status === "downloading" && (s.percent ?? 0) > 0
  })
  ctrl.pause()
  await first
  assert.equal(ctrl.getState().status, "paused")
  await waitFor(() => interrupted === 1)
  assert.equal(updater.listenerCount("download-progress"), 0)
  const resume = ctrl.resume()
  await waitFor(() => requests === 2)
  await ctrl.cancel()
  await resume
  assert.equal(ctrl.getState().status, "idle")
  assert.equal(stored, undefined)
  await waitFor(() => interrupted === 2)
  assert.equal((await ctrl.check()).status, "ready")
  assert.equal(stored?.version, "99.1.0")
  assert.equal(updater.listenerCount("download-progress"), 0)
  console.log(
    `[updater-test] PASS real MacUpdater progress/pause/resume/cancel/retry requests=${requests} interrupted=${interrupted}; installation intentionally not invoked`,
  )
}

main()
  .then(() => 0)
  .catch((error) => {
    console.error(`[updater-test] FAIL ${String(error)}`)
    return 1
  })
  .then((code) => {
    server.close()
    rmSync(root, { recursive: true, force: true })
    app.exit(code)
  })
