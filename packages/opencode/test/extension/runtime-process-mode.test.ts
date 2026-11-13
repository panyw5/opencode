import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { ExtensionRuntime } from "../../src/extension/runtime"

/**
 * Runtime-level coverage for the process-isolation backend (T5.3): real OS
 * worker crash/restart, in-flight request fencing, caller cancellation,
 * quiesce/disable observing worker exit, restart-budget exhaustion and
 * recovery through retry. The protocol/supervisor-level equivalents live in
 * test/extension/host-process/*; these tests pin the host-runtime wiring.
 */

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-pmode-"))
const registry = path.join(root, "registry.json")

// `bun test` cannot re-exec the test file as the extension-host entrypoint.
process.env.OPENCODE_EXTENSION_HOST_ARGV = JSON.stringify([
  process.execPath,
  path.join(import.meta.dir, "../../src/index.ts"),
  "extension-host",
])

const id = "test.pmode"

// The worker records every activation in its host-owned data dir (`gen`,
// `pid`), so the test can prove a real process replacement rather than relying
// on status polling. `hang` marks `hanging-<gen>` as an admission barrier.
const SERVER = `
import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const state = { count: 0 }

export default {
  id: "__ID__",
  async activate(host) {
    mkdirSync(host.dataDir, { recursive: true })
    let gen = 1
    try { gen = Number(readFileSync(join(host.dataDir, "gen"), "utf8")) + 1 } catch {}
    writeFileSync(join(host.dataDir, "gen"), String(gen))
    writeFileSync(join(host.dataDir, "pid"), String(process.pid))
    return {
      rpc: {
        echo: async (input) => ({ echo: input?.message ?? null, pid: process.pid, gen, count: state.count }),
        "state.bump": async () => ++state.count,
        die: async () => {
          process.exit(1)
        },
        hang: async (_input, ctx) => {
          writeFileSync(join(host.dataDir, "hanging-" + gen), "1")
          return new Promise((_resolve, reject) => {
            if (ctx.signal.aborted) return reject(new Error("hang aborted"))
            ctx.signal.addEventListener("abort", () => reject(new Error("hang aborted")), { once: true })
          })
        },
      },
      dispose: () => {},
    }
  },
  async server() {
    return {}
  },
}
`

const dataDir = () =>
  path.join(
    process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share"),
    "opencode",
    "extensions",
    "data",
    id,
  )

async function writePackage() {
  const dir = path.join(root, "ext")
  await mkdir(path.join(dir, "dist"), { recursive: true })
  await writeFile(path.join(dir, "dist", "server.js"), SERVER.replaceAll("__ID__", id))
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: id,
        version: "1.0.0",
        type: "module",
        exports: { "./server": "./dist/server.js" },
        opencode: {
          manifestVersion: 1,
          id,
          displayName: "Process Mode",
          server: { isolation: "process" },
        },
      },
      null,
      2,
    ),
  )
  return dir
}

async function link(dir: string) {
  const store = (await Bun.file(registry)
    .json()
    .catch(() => ({ version: 1, extensions: {} }))) as { version: number; extensions: Record<string, unknown> }
  store.extensions[id] = {
    name: id,
    version: "1.0.0",
    source: { type: "path", path: dir },
    dir,
    enabled: true,
    installedAt: Date.now(),
  }
  await writeFile(registry, JSON.stringify(store, null, 2))
}

async function poll<T>(fn: () => Promise<T | undefined>, message: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await fn()
    if (last !== undefined) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${message} (last=${JSON.stringify(last)})`)
}

const rpc = (method: string, input: Record<string, unknown> = {}, signal?: AbortSignal) =>
  ExtensionRuntime.rpc({ id, method, input, signal }) as Promise<Record<string, unknown>>

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dir = await writePackage()

describe("extension runtime process mode", () => {
  beforeEach(async () => {
    await ExtensionRuntime.testing.reset()
    process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
    await link(dir)
    ExtensionRuntime.testing.setWorkerLimits({ restartBackoffMs: [50, 100, 200] })
  })

  test("a crashed worker restarts automatically with fresh state and a new pid", async () => {
    const first = await rpc("echo", { message: "a" })
    await rpc("state.bump")
    await expect(rpc("die")).rejects.toThrow(/unavailable|crashed|exited/i)
    const second = await poll(
      () =>
        rpc("echo", { message: "b" })
          .then((value) => (value.pid !== first.pid ? value : undefined))
          .catch(() => undefined),
      "worker did not restart with a new pid",
    )
    // Fresh activate: generation marker advanced, per-process state reset.
    expect(second.gen).toBe(2)
    expect(second.count).toBe(0)
    expect(ExtensionRuntime.describe(id).runtime).toBe("ready")
  }, 20_000)

  test("an in-flight request rejects when the worker crashes", async () => {
    const first = await rpc("echo")
    const hanging = rpc("hang").then(
      () => "resolved",
      (error: unknown) => error,
    )
    await poll(
      async () => existsSync(path.join(dataDir(), `hanging-${first.gen}`)) || undefined,
      "hang never reached the worker",
    )
    await rpc("die").catch(() => {})
    const outcome = await hanging
    expect(outcome).not.toBe("resolved")
    expect(String(outcome instanceof Error ? outcome.message : outcome)).toMatch(/unavailable|crashed|exited/i)
  }, 20_000)

  test("caller abort cancels an in-flight worker request and the worker survives", async () => {
    const first = await rpc("echo")
    const controller = new AbortController()
    const pending = rpc("hang", {}, controller.signal).then(
      () => "resolved",
      (error: unknown) => error,
    )
    await poll(
      async () => existsSync(path.join(dataDir(), `hanging-${first.gen}`)) || undefined,
      "hang never reached the worker",
    )
    controller.abort()
    const outcome = await pending
    expect(outcome).not.toBe("resolved")
    // Cancellation is per-request: the same worker still answers.
    const after = await rpc("echo", { message: "ok" })
    expect(after).toMatchObject({ echo: "ok", pid: first.pid })
  }, 20_000)

  test("disable quiesces the worker and observes its OS exit", async () => {
    const { pid } = await rpc("echo")
    expect(alive(pid as number)).toBe(true)
    await ExtensionRuntime.disable(id)
    await poll(async () => (alive(pid as number) ? undefined : true), `worker pid ${pid} still alive after disable`)
    expect(ExtensionRuntime.describe(id).runtime).toBe("idle")
  }, 20_000)

  test("a crash loop exhausts the restart budget into a sticky error; retry recovers", async () => {
    ExtensionRuntime.testing.setWorkerLimits({ restartBackoffMs: [50] })
    const first = await rpc("echo")
    await rpc("die").catch(() => {})
    // One restart attempt fits inside the [50] skeleton.
    await poll(
      () =>
        rpc("echo")
          .then((value) => (value.pid !== first.pid ? value : undefined))
          .catch(() => undefined),
      "first crash did not restart",
    )
    // The second crash exceeds the budget: sticky entry error, no more restarts.
    await rpc("die").catch(() => {})
    await poll(
      async () => (ExtensionRuntime.describe(id).runtime === "error" ? true : undefined),
      "restart budget was not exhausted into a sticky error",
    )
    await expect(rpc("echo")).rejects.toThrow()
    const third = await ExtensionRuntime.retry(id).then(() =>
      poll(
        () =>
          rpc("echo", { message: "c" })
            .then((value) => (value.pid !== first.pid ? value : undefined))
            .catch(() => undefined),
        "retry did not recover a fresh worker",
      ),
    )
    expect(third.gen).toBeGreaterThanOrEqual(3)
  }, 20_000)
})

afterAll(async () => {
  await ExtensionRuntime.testing.reset()
  delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  await rm(root, { recursive: true, force: true })
})
