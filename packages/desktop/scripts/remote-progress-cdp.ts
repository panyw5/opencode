#!/usr/bin/env bun
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import appPlugin from "../../app/vite.js"
import { CdpClient, listTargets, connectCdp } from "./cdp"

const root = resolve(import.meta.dir, "../../..")
const scratch = await mkdtemp(join(tmpdir(), "opencode-progress-cdp-"))
const appRoot = join(root, "packages/app")
const entry = `/@fs/${join(import.meta.dir, "fixtures/remote-progress.tsx")}`
let electron: ReturnType<typeof Bun.spawn> | undefined
let client: CdpClient | undefined
let parent: CdpClient | undefined
let processLogs: Promise<void> | undefined
const pageID = `remote-progress-qa-${Date.now()}`
const server = await createServer({
  configFile: false,
  root: appRoot,
  cacheDir: join(scratch, "vite-cache"),
  plugins: [
    appPlugin,
    {
      name: "remote-progress-fixture",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== "/__remote-progress-qa") return next()
          void vite
            .transformIndexHtml(
              request.url,
              `<!doctype html><html><head><title>OpenCode progress QA</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
            )
            .then((html) => {
              response.setHeader("Content-Type", "text/html")
              response.end(html)
            }, next)
        })
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
})
async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const end = Date.now() + 60_000
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${description}`)
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
try {
  const existing = await listTargets().catch(() => [])
  await server.listen()
  const address = server.httpServer!.address()
  assert(address && typeof address !== "string", "Fixture server has no port")
  const url = `http://127.0.0.1:${address.port}/__remote-progress-qa`
  const main = join(scratch, "main.cjs")
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');let win;app.setPath('userData',${JSON.stringify(join(scratch, "electron-data"))});app.commandLine.appendSwitch('remote-debugging-port','9222');app.whenReady().then(()=>{win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});win.loadURL(${JSON.stringify(url)});app.on('window-all-closed',()=>app.quit())});`,
  )
  if (existing.length > 0) {
    parent = (await connectCdp()).client
    await parent.evaluate(`window.api.browser.open(${JSON.stringify(pageID)},${JSON.stringify(url)})`)
    console.log("[remote-progress-qa] reusing running Electron; only an isolated QA view is created")
  } else {
    electron = Bun.spawn([require("electron"), main], { stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(electron.stdout).text()
    const stderr = new Response(electron.stderr).text()
    processLogs = Promise.all([stdout, stderr]).then(async ([out, err]) =>
      writeFile(join(scratch, "electron.log"), out + err),
    )
  }
  const target = await waitFor(
    async () => (await listTargets()).find((t) => t.url === url),
    "isolated Electron renderer",
  )
  client = await CdpClient.connect(target.webSocketDebuggerUrl)
  await waitFor(
    async () =>
      (await client!.evaluate<boolean>(`!!document.querySelector('[data-slot="remote-connection-elapsed"]')`))
        ? true
        : undefined,
    "elapsed timer",
  )
  const first = await client.evaluate<string>(
    `document.querySelector('[data-slot="remote-connection-elapsed"]').textContent`,
  )
  assert(first.includes("02:") && !first.includes("{duration}"), "Elapsed time is missing or starts at zero")
  assert(
    await client.evaluate<boolean>(
      `document.body.innerText.includes('正在申请并等待 TLS 证书')&&document.body.innerText.includes('可以关闭此设置浮窗')`,
    ),
    "Setup hints are missing",
  )
  await waitFor(
    async () =>
      (await client!.evaluate<string>(
        `document.querySelector('[data-slot="remote-connection-elapsed"]').textContent`,
      )) !== first
        ? true
        : undefined,
    "timer ticks",
  )
  await client.evaluate(`window.__remoteProgressFixture.close()`)
  const closed = await client.evaluate<{ stops: number; listeners: number }>(`window.__remoteProgressFixture.inspect()`)
  assert(closed.stops === 0 && closed.listeners === 0, "Closing settings stopped the connection or leaked a subscriber")
  await client.evaluate(`window.__remoteProgressFixture.mount()`)
  await waitFor(
    async () =>
      (await client!.evaluate<boolean>(
        `document.querySelector('[data-slot="remote-connection-elapsed"]')?.textContent.includes('02:')`,
      ))
        ? true
        : undefined,
    "elapsed time survives reopening",
  )
  await client.evaluate(`window.__remoteProgressFixture.complete();window.__remoteProgressFixture.reconnect()`)
  await waitFor(
    async () =>
      (await client!.evaluate<boolean>(
        `!!document.querySelector('[data-component="remote-connection-progress"]')&&!document.querySelector('[data-slot="remote-connection-stage-elapsed"]')&&!document.body.innerText.includes('首次启用需要')`,
      ))
        ? true
        : undefined,
    "reconnect clears stale certificate stage metadata",
  )
  await client.evaluate(
    `window.__remoteProgressFixture.close();window.__remoteProgressFixture.complete();window.__remoteProgressFixture.mount()`,
  )
  await waitFor(
    async () =>
      (await client!.evaluate<boolean>(
        `document.body.innerText.includes('在线')&&!document.querySelector('[data-component="remote-connection-progress"]')`,
      ))
        ? true
        : undefined,
    "background connection finishes while settings is closed",
  )
  await client.evaluate(`window.__remoteProgressFixture.disabled()`)
  await waitFor(
    async () =>
      (await client!.evaluate<boolean>(
        `document.body.innerText.includes('借助免费的 OpenTunnel 中继服务，提供远程使用本机 OpenCode 功能。启动后将需要等待数分钟完成机器注册和收取证书')`,
      ))
        ? true
        : undefined,
    "updated enable description",
  )
  console.log(
    `[remote-progress-qa] PASS elapsed ticks, certificate hints, close/reopen, clean reconnect and background completion; artifacts=${scratch}`,
  )
} finally {
  client?.close()
  if (parent) {
    await parent.evaluate(`window.api.browser.close(${JSON.stringify(pageID)})`).catch(() => {})
    parent.close()
  }
  if (electron && electron.exitCode === null) {
    electron.kill("SIGTERM")
    await electron.exited
  }
  await processLogs?.catch(() => {})
  await server.close()
}
