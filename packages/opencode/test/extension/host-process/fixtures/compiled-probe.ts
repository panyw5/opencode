/**
 * Compiled-binary smoke probe (T5.4 desktop/packaging verification).
 *
 * `bun build --compile` this file into a binary named `opencode` so the
 * synthesized `/$bunfs/root/opencode` argv[1] hits the same branch a packaged
 * CLI takes, then run `<bin> <extension-dir> <data-dir>`:
 *
 *  1. `resolveSelfArgv` must return `[self, "extension-host", ...]` — before
 *     the fix it returned `[self, "/$bunfs/root/opencode", "extension-host"]`
 *     and the worker could never reach the entrypoint.
 *  2. `spawnWorkerTransport` under Bun compiles `control-fd.c` — the embedded
 *     text must be materialized to a real path (bunfs is invisible to `cc`).
 *  3. The child runs the real `runExtensionHost` entry: hello → init → import
 *     the fixture extension → ready → service.rpc echo/child.start →
 *     drain → dispose → observed exit.
 */
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { HostProcessError, makeIdentity } from "../../../../src/extension/host-process/protocol.ts"
import { superviseWorker } from "../../../../src/extension/host-process/supervisor.ts"
import { spawnWorkerTransport } from "../../../../src/extension/host-process/transport.ts"
import { resolveSelfArgv } from "../../../../src/math/spawn.ts"

const args = process.argv.slice(2)
if (args[0] === "extension-host") {
  const { runExtensionHost } = await import("../../../../src/extension/host-process/entry.ts")
  process.exit(await runExtensionHost(args.slice(1)))
}

const extensionDir = path.resolve(args[0] ?? "")
const dataDir = args[1] ? path.resolve(args[1]) : mkdtempSync(path.join(tmpdir(), "oc-probe-data-"))
const fence = { store: randomUUID(), installation: randomUUID(), generation: 0, epoch: 0 }
const identity = makeIdentity(fence)
const argv = resolveSelfArgv(["extension-host", "--identity", JSON.stringify(identity)], {
  execPath: process.execPath,
  argv: process.argv,
  env: {},
  electron: "electron" in process.versions,
  execArgv: process.execArgv,
})
console.log(`probe resolved argv=${JSON.stringify(argv)}`)
if (argv[0] !== process.execPath || argv[1] !== "extension-host") {
  console.error("probe FAIL: self re-exec argv is wrong for a compiled binary")
  process.exit(2)
}

const children = new Map<string, { pid: number | undefined }>()
const realChildren: ReturnType<typeof spawn>[] = []
const transport = await spawnWorkerTransport({
  executable: argv[0],
  args: argv.slice(1),
  frameBytes: 64 * 1024,
  bufferedFrames: 16,
  exitMs: 5_000,
  log: (stream, text) => process.stderr.write(`[worker ${stream}] ${text}`),
})

const worker = superviseWorker({
  extension: "probe.compiled",
  identity,
  transport,
  limits: {
    frameBytes: 64 * 1024,
    bufferedFrames: 16,
    readinessMs: 10_000,
    drainMs: 2_000,
    disposeMs: 5_000,
    exitMs: 5_000,
    maxPending: 8,
    restartBackoffMs: [50, 50, 50],
  },
  hooks: {
    init: {
      id: "test.e2e-ext",
      version: "1.0.0",
      dir: extensionDir,
      entry: path.join(extensionDir, "server.js"),
      dataDir,
      cacheDir: dataDir,
      settings: {},
    },
    async onHostCall(method, value) {
      const input = (value ?? {}) as { command?: string; args?: string[]; processId?: string; signal?: string }
      if (method === "host.spawn") {
        const child = spawn(input.command!, input.args ?? [], { detached: true, stdio: "ignore" })
        child.unref()
        realChildren.push(child)
        const processId = `probe-${realChildren.length}`
        children.set(processId, { pid: child.pid })
        return { processId, pid: child.pid ?? null }
      }
      if (method === "proc.kill") {
        const index = Number((input.processId ?? "").replace("probe-", "")) - 1
        realChildren[index]?.kill(input.signal === "KILL" ? "SIGKILL" : "SIGTERM")
        return null
      }
      if (method === "proc.stdin-end") return null
      throw new HostProcessError({ code: "denied", detail: `unsupported host.call: ${method}` })
    },
  },
})

const fail = (step: string, cause?: unknown) => {
  console.error(`probe FAIL at ${step}:`, cause)
  for (const child of realChildren) child.kill("SIGKILL")
  transport.terminate()
  process.exit(1)
}

try {
  await worker.ready()
  console.log(`probe ready pid=${worker.pid}`)
  const echo = await worker.request("service.rpc", { method: "echo", input: { message: "compiled-ok" }, directory: null })
  const echoValue = (echo as { status?: string; value?: { echo?: string } }).value?.echo
  console.log(`probe rpc echo=${JSON.stringify(echo)}`)
  if (echoValue !== "compiled-ok") throw new Error(`unexpected echo: ${JSON.stringify(echo)}`)

  const started = await worker.request("service.rpc", { method: "child.start", input: null, directory: null })
  const childPid = (started as { status?: string; value?: { pid?: number } }).value?.pid
  console.log(`probe host.spawn pid=${childPid}`)
  if (typeof childPid !== "number" || childPid <= 0) throw new Error(`host.spawn did not report a pid: ${JSON.stringify(started)}`)
  try {
    process.kill(childPid, 0)
  } catch {
    throw new Error(`host.spawn child pid=${childPid} is not alive`)
  }

  const result = await worker.stop()
  console.log(`probe stop=${JSON.stringify(result)}`)
  if (result.status !== "rootExited") throw new Error("worker did not exit")

  // The fixture's dispose kills its managed child; confirm nothing survives.
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    process.kill(childPid, 0)
    throw new Error(`managed child pid=${childPid} survived worker disposal`)
  } catch (error) {
    if (error instanceof Error && !error.message.includes("survived")) {
      // ESRCH — child is gone, as required.
    } else throw error
  }
  console.log("probe PASS")
  process.exit(0)
} catch (cause) {
  fail("lifecycle", cause)
}
