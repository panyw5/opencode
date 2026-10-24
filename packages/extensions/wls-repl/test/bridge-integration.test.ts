import { describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extensionDefault, { createWlsService } from "../src/server"
import type { ExtensionHost, ExtensionPluginInput } from "@opencode-ai/extension-kit/server"

const wolframscript = (() => {
  const probe = spawnSync("which", ["wolframscript"], { encoding: "utf8" })
  return probe.status === 0 ? probe.stdout.trim() : ""
})()

const wolframAvailable = wolframscript !== ""

type Emitted = { name: string; payload: Record<string, unknown> }

function makeHost(dataDir = "/tmp/wls-repl-test-data"): { host: ExtensionHost; emitted: Emitted[] } {
  const emitted: Emitted[] = []
  const host: ExtensionHost = {
    id: "local.wls-repl",
    version: "0.0.0-test",
    dataDir,
    cacheDir: "/tmp/wls-repl-test-cache",
    serverUrl: new URL("http://127.0.0.1:1/"),
    settings: {
      get: () => ({ wolframscriptPath: wolframscript }),
      onDidChange: () => () => {},
    },
    emit: (name, payload) => {
      emitted.push({ name, payload: payload as Record<string, unknown> })
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  }
  return { host, emitted }
}

function waitfor(emitted: Emitted[], match: (payload: Record<string, unknown>) => boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const tick = () => {
      const found = emitted.find(({ payload }) => match(payload))
      if (found) return resolve(found.payload)
      if (Date.now() > deadline) return reject(new Error("expected event not emitted before timeout"))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe.skipIf(!wolframAvailable)("wls-repl real wolframscript integration", () => {
  test("run with breakpoints pauses, inspects, and continues", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)
    const path = "/tmp/wls-repl-it/debug.wls"

    const started = (await service.rpc!["kernel.run"]({
      path,
      code: "a = 1;\nb = a + 1;\nc = Table[x^2, {x, 3}];\nd = b * 10;\nd",
      breakpoints: [3],
      timeoutSeconds: 30,
    })) as { started: boolean; pid?: number }
    expect(started.started).toBe(true)

    const paused = await waitfor(emitted, (payload) => payload.type === "paused")
    expect(paused.line).toBe(3)
    const variables = paused.variables as Record<string, string>
    expect(variables.a).toContain("1")
    expect(variables.b).toContain("2")

    const inspect = await service.rpc!["kernel.eval"]({ path, code: "a + b" })
    const inspectResult = await waitfor(
      emitted,
      (payload) => payload.type === "inspect-result" && payload.id === (inspect as { id: string }).id,
    )
    expect(inspectResult.ok).toBe(true)
    expect(inspectResult.text).toBe("3")

    await service.rpc!["kernel.continue"]({ path })
    await waitfor(emitted, (payload) => payload.type === "done")
    const resultEntry = emitted.find((entry) => entry.payload.type === "result" && entry.payload.line === 5)
    expect((resultEntry?.payload.text as string) ?? "").toContain("20")

    const repl = await service.rpc!["kernel.eval"]({ path, code: "d + 100" })
    const replResult = await waitfor(
      emitted,
      (payload) => payload.type === "eval-result" && payload.id === (repl as { id: string }).id,
    )
    expect(replResult.ok).toBe(true)
    expect(replResult.text).toBe("120")

    const status = await service.rpc!["kernel.status"]({ path })
    expect(status).toMatchObject({ status: "ready" })

    await service.dispose!()
    const after = await service.rpc!["kernel.status"]({ path })
    expect(after).toMatchObject({ kernelRunning: false })
  }, 120_000)

  test("step stops at every statement and abort skips the rest", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)
    const path = "/tmp/wls-repl-it/step.wls"

    await service.rpc!["kernel.run"]({
      path,
      code: "x = 1;\ny = 2;\nz = 3;",
      breakpoints: [1],
      timeoutSeconds: 30,
    })
    await waitfor(emitted, (payload) => payload.type === "paused" && payload.line === 1)

    await service.rpc!["kernel.step"]({ path })
    await waitfor(emitted, (payload) => payload.type === "paused" && payload.line === 2)

    await service.rpc!["kernel.abort"]({ path })
    const done = await waitfor(emitted, (payload) => payload.type === "done")
    expect(done.aborted).toBe(true)
    expect(emitted.some((entry) => entry.payload.type === "result" && entry.payload.line === 3)).toBe(false)

    await service.dispose!()
  }, 120_000)

  test("statement timeout aborts the run", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)
    const path = "/tmp/wls-repl-it/timeout.wls"

    await service.rpc!["kernel.run"]({
      path,
      code: "Pause[30];",
      breakpoints: [],
      timeoutSeconds: 2,
    })
    const errorEvent = await waitfor(emitted, (payload) => payload.type === "error")
    expect(String(errorEvent.text)).toContain("timed out")
    await waitfor(emitted, (payload) => payload.type === "done")

    await service.dispose!()
  }, 120_000)

  test("syntax error surfaces and run aborts", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)
    const path = "/tmp/wls-repl-it/syntax.wls"

    await service.rpc!["kernel.run"]({
      path,
      code: "a = 1;\nb = ;",
      breakpoints: [],
      timeoutSeconds: 30,
    })
    const errorEvent = await waitfor(emitted, (payload) => payload.type === "error")
    expect(String(errorEvent.text)).toContain("syntax")
    const done = await waitfor(emitted, (payload) => payload.type === "done")
    expect(done.aborted).toBe(true)

    await service.dispose!()
  }, 120_000)

  test("kernel.stop terminates the wolframscript process", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)
    const path = "/tmp/wls-repl-it/stop.wls"

    const result = (await service.rpc!["kernel.eval"]({ path, code: "1 + 1" })) as { queued: boolean }
    expect(result.queued).toBe(true)
    await waitfor(emitted, (payload) => payload.type === "ready")

    const stopped = await service.rpc!["kernel.stop"]({ path })
    expect(stopped).toMatchObject({ stopped: true })
    await waitfor(emitted, (payload) => payload.type === "kernel-exit")
  }, 120_000)
})

describe.skipIf(!wolframAvailable)("wls-repl stale kernel sweep", () => {
  test("a new service kills kernels left by a dead host process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "wls-sweep-"))
    const first = makeHost(dataDir)
    const service1 = createWlsService(first.host)
    const started = (await service1.rpc!["kernel.run"]({
      path: "/tmp/sweep.wls",
      code: "x = 1;",
      breakpoints: [],
      timeoutSeconds: 30,
    })) as { pid?: number }
    expect(typeof started.pid).toBe("number")
    const kernelPid = started.pid!

    // Simulate an abrupt host death: no dispose, and the recorded host pid
    // is rewritten to a pid that is provably dead.
    const deadHost = spawn("bash", ["-c", "exit 0"])
    await new Promise<void>((resolve) => deadHost.once("exit", () => resolve()))
    const file = join(dataDir, "kernel-pids.json")
    const records = JSON.parse(readFileSync(file, "utf8")) as Array<{ kernelPid: number; hostPid: number }>
    for (const record of records) record.hostPid = deadHost.pid!
    writeFileSync(file, JSON.stringify(records))

    const second = makeHost(dataDir)
    const service2 = createWlsService(second.host)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    let alive = true
    try {
      process.kill(kernelPid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
    await service2.dispose!()
  }, 120_000)
})

describe.skipIf(!wolframAvailable)("wolfram_eval tool integration", () => {
  test("shares kernel state with the user's file and persists across calls", async () => {
    const { host, emitted } = makeHost()
    const service = createWlsService(host)

    // The user's file kernel defines q = 6.
    await service.rpc!["kernel.run"]({
      path: "/tmp/wls-repl-it/shared.wls",
      code: "q = 6;",
      breakpoints: [],
      timeoutSeconds: 30,
    })
    await waitfor(emitted, (payload) => payload.type === "done")

    const hooks = await extensionDefault.server({
      directory: "/tmp/wls-repl-it/proj",
      extension: { ...host, service },
    } as unknown as ExtensionPluginInput)
    const runTool = (args: { code: string; path?: string }) =>
      hooks.tool!.wolfram_eval.execute(args, { sessionID: "s1" } as never) as Promise<string>

    // Path-targeted eval reuses the user's kernel: q is visible.
    const shared = await runTool({ code: "q * 7", path: "/tmp/wls-repl-it/shared.wls" })
    expect(shared).toContain("42")

    // Default (no path) uses the directory kernel: fresh state.
    const fresh = await runTool({ code: "q" })
    expect(fresh).toContain("wolfram> q")
    expect(fresh).not.toContain("6")

    // Tool kernel state persists across calls.
    await runTool({ code: "r = 5" })
    const persisted = await runTool({ code: "r + 1" })
    expect(persisted).toContain("6")

    await service.dispose!()
  }, 180_000)
})
