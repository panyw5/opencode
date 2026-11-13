// Managed extension child processes (remediation plan T2.5). Children spawned
// through host.spawn run in their own process group; generation teardown
// (disable/reload/quiesce) must reap the whole tree and await the observed
// exit event — never just signal delivery or a bare timeout.
import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import type { ExtensionHost, ManagedProcess } from "@opencode-ai/extension-kit/server"
import { ExtensionRuntime, type Options } from "../../src/extension/runtime"
import { ExtensionRegistry } from "../../src/extension/registry"
import { extensionPackage } from "./fixture"
import { tmpdir } from "../fixture/fixture"

let options: Options
let rt: ReturnType<typeof ExtensionRuntime.make>

let temp: Awaited<ReturnType<typeof tmpdir>>
let previous: string | undefined
let id = ""

// Stays alive until killed; both `node -e` and `bun -e` run it.
const SLEEPER = "setInterval(() => {}, 60 * 1000)"
const TERM_PROOF = 'process.on("SIGTERM", () => {}); ' + SLEEPER

function alive(pid: number | undefined) {
  if (pid === undefined || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Activates the extension's process service; the unknown method is irrelevant. */
async function activate() {
  await rt.rpc({ id, method: "missing" }).catch(() => {})
}

beforeEach(async () => {
    options = {}
    rt = ExtensionRuntime.make(options)
  temp = await tmpdir()
  previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(temp.path, "registry.json")
  id = `test.proc-${crypto.randomUUID()}`
  const dir = await extensionPackage(temp.path, {
    id,
    serverEntry: "dist/server.js",
    // T5.8: undeclared defaults to process; this suite exercises the inline backend.
    isolation: "inline",
    webExport: null,
    webManifest: false,
    fileViewers: null,
    activation: null,
  })
  await ExtensionRegistry.link(dir)
})

afterEach(async () => {
  await rt.testing.reset()
  if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  await temp[Symbol.asyncDispose]()
})

test("disable terminates a spawned child process and observes its exit", async () => {
  let spawned: ManagedProcess | undefined
  options.importer = (async () => ({
    id,
    activate: async (host: ExtensionHost) => {
      spawned = host.spawn(process.execPath, ["-e", SLEEPER])
      return {}
    },
  }))
  await activate()
  const child = spawned!
  expect(child.pid).toBeGreaterThan(0)
  expect(alive(child.pid)).toBe(true)
  await rt.disable(id)
  expect(child.exited).toBe(true)
  expect(alive(child.pid)).toBe(false)
})

test.each(["disable", "reload", "quiesce"] as const)("%s reaps spawned children", async (action) => {
  let spawned: ManagedProcess | undefined
  options.importer = (async () => ({
    id,
    activate: async (host: ExtensionHost) => {
      spawned = host.spawn(process.execPath, ["-e", SLEEPER])
      return {}
    },
  }))
  await activate()
  const pid = spawned!.pid
  await rt[action](id, { timeoutMs: 5_000 })
  expect(alive(pid)).toBe(false)
})

test("a child ignoring SIGTERM is escalated to SIGKILL after the configured grace period", async () => {
  Object.assign(options, { killGraceMs: 100 })
  let spawned: ManagedProcess | undefined
  options.importer = (async () => ({
    id,
    activate: async (host: ExtensionHost) => {
      spawned = host.spawn(process.execPath, ["-e", TERM_PROOF])
      return {}
    },
  }))
  await activate()
  const started = Date.now()
  await rt.disable(id)
  // The child can only be dead via the SIGKILL escalation, so the override
  // proves effective when teardown lands well under the 3s default grace.
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(spawned!.exited).toBe(true)
  expect(alive(spawned!.pid)).toBe(false)
})

test("process-group teardown also reaps grandchildren", async () => {
  // The managed child spawns a same-group grandchild and reports its pid.
  const parent = `
    import("node:child_process").then(({ spawn }) => {
      const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}], { stdio: "ignore" })
      console.log(grandchild.pid)
    })
    ${SLEEPER}
  `
  let spawned: ManagedProcess | undefined
  options.importer = (async () => ({
    id,
    activate: async (host: ExtensionHost) => {
      spawned = host.spawn(process.execPath, ["-e", parent])
      return {}
    },
  }))
  await activate()
  const child = spawned!
  let grandchildPid = 0
  child.stdout!.on("data", (chunk) => {
    const parsed = Number.parseInt(String(chunk).trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) grandchildPid = parsed
  })
  await until(() => grandchildPid > 0)
  expect(alive(child.pid)).toBe(true)
  expect(alive(grandchildPid)).toBe(true)
  await rt.disable(id)
  expect(alive(child.pid)).toBe(false)
  await until(() => !alive(grandchildPid))
})

test("ManagedProcess.kill terminates the child and spawn on a disposed host throws", async () => {
  let host!: ExtensionHost
  let spawned: ManagedProcess | undefined
  options.importer = (async () => ({
    id,
    activate: async (value: ExtensionHost) => {
      host = value
      spawned = host.spawn(process.execPath, ["-e", SLEEPER])
      return {}
    },
  }))
  await activate()
  const child = spawned!
  const exited = new Promise<void>((resolve) => child.onExit(() => resolve()))
  child.kill()
  await exited
  expect(child.exited).toBe(true)
  expect(child.exitCode).toBeNull()
  await rt.disable(id)
  expect(() => host.spawn(process.execPath, ["-e", SLEEPER])).toThrow(/disposed/)
})
