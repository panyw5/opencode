import { describe, expect, test } from "bun:test"
import { watch } from "node:fs"
import { readFile } from "node:fs/promises"
import extensionDefault, { createWlsService, type KernelHandle, type SpawnKernel } from "../src/server"
import type { ExtensionHost, ExtensionPluginInput } from "@opencode-ai/extension-kit/server"

type Emitted = { name: string; payload: unknown }

function makeHost(settings: Record<string, unknown> = {}) {
  const emitted: Emitted[] = []
  const logs: string[] = []
  const host: ExtensionHost = {
    id: "local.wls-repl",
    version: "0.0.0-test",
    dataDir: "/tmp/wls-repl-test-data",
    cacheDir: "/tmp/wls-repl-test-cache",
    serverUrl: new URL("http://127.0.0.1:1/"),
    settings: {
      get: () => settings,
      onDidChange: () => () => {},
    },
    emit: (name, payload) => {
      emitted.push({ name, payload })
    },
    log: {
      debug: () => {},
      info: (message) => logs.push(message),
      warn: () => {},
      error: () => {},
    },
  }
  return { host, emitted, logs }
}

type FakeKernel = {
  ctlPath: string
  nonce: string
  requests: Array<Record<string, unknown>>
  killed: boolean
  handle: KernelHandle
  emitProtocol: (message: Record<string, unknown>) => void
  emitOutput: (text: string) => void
  exit: (code: number | null) => void
}

function watchLines(path: string, onLine: (request: Record<string, unknown>) => void): () => void {
  let offset = 0
  let stopped = false
  const check = async () => {
    if (stopped) return
    const text = await readFile(path, "utf8").catch(() => "")
    if (text.length > offset) {
      const chunk = text.slice(offset)
      offset = text.length
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue
        try {
          onLine(JSON.parse(line))
        } catch {
          /* malformed line: ignore */
        }
      }
    }
  }
  const watcher = watch(path, () => void check())
  void check()
  return () => {
    stopped = true
    watcher.close()
  }
}

function makeFakeSpawn(onRequest?: (kernel: FakeKernel, request: Record<string, unknown>) => void) {
  const spawned: FakeKernel[] = []
  const spawnKernel: SpawnKernel = ({ ctlPath }) => {
    const outListeners = new Set<(line: string) => void>()
    const errListeners = new Set<(line: string) => void>()
    const exitListeners = new Set<(code: number | null) => void>()
    const errorListeners = new Set<(error: Error) => void>()
    const kernel = {
      ctlPath,
      nonce: "deadbeef",
      requests: [],
      killed: false,
      emitProtocol: (message: Record<string, unknown>) => {
        const line = `\x1e${kernel.nonce}${JSON.stringify(message)}`
        for (const listener of outListeners) listener(line)
      },
      emitOutput: (text: string) => {
        for (const listener of outListeners) listener(text)
      },
      exit: (code: number | null) => {
        for (const listener of exitListeners) listener(code)
      },
    } as FakeKernel
    const stopWatch = watchLines(ctlPath, (request) => {
      kernel.requests.push(request)
      onRequest?.(kernel, request)
    })
    kernel.handle = {
      pid: 42_000 + spawned.length,
      onStdoutLine: (listener) => {
        outListeners.add(listener)
        return () => outListeners.delete(listener)
      },
      onStderrLine: (listener) => {
        errListeners.add(listener)
        return () => errListeners.delete(listener)
      },
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => exitListeners.delete(listener)
      },
      onError: (listener) => {
        errorListeners.add(listener)
        return () => errorListeners.delete(listener)
      },
      kill: () => {
        kernel.killed = true
        stopWatch()
        for (const listener of exitListeners) listener(0)
      },
    }
    spawned.push(kernel)
    setTimeout(() => {
      kernel.emitProtocol({ type: "ready", protocol: 1, nonce: kernel.nonce, version: "fake 13.3" })
    }, 5)
    return kernel.handle
  }
  return { spawned, spawnKernel }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("wls-repl service (fake kernel)", () => {
  test("run writes a ctl command and routes protocol events", async () => {
    const { host, emitted } = makeHost()
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    const started = await service.rpc!["kernel.run"]({
      path: "/tmp/demo.wls",
      code: "a = 1;\nb = a + 1;",
      breakpoints: [2],
    })
    expect(started).toMatchObject({ started: true })
    expect(typeof (started as { runId: string }).runId).toBe("string")

    await until(() => spawned.length === 1)
    await until(() => spawned[0]!.requests.some((request) => request.op === "run"))
    const run = spawned[0]!.requests.find((request) => request.op === "run")!
    expect(run.code).toBe("a = 1;\nb = a + 1;")
    expect(run.breakpoints).toEqual([2])
    expect(typeof run.timeoutSeconds).toBe("number")

    const kernel = spawned[0]!
    kernel.emitProtocol({ type: "paused", id: run.id, line: 2, variables: { a: "HoldPattern[a] :> 1" } })
    await until(() =>
      emitted.some(
        ({ name, payload }) => name === "local.wls-repl/message" && (payload as { type?: string }).type === "paused",
      ),
    )
    const status = await service.rpc!["kernel.status"]({ path: "/tmp/demo.wls" })
    expect(status).toMatchObject({ status: "paused", pausedLine: 2, kernelRunning: true })

    await expect(service.rpc!["kernel.run"]({ path: "/tmp/demo.wls", code: "x" })).rejects.toThrow(
      /already in progress/,
    )

    await service.rpc!["kernel.continue"]({ path: "/tmp/demo.wls" })
    await until(() => kernel.requests.some((request) => request.op === "continue"))
    kernel.emitProtocol({ type: "done", id: run.id, aborted: false })
    await until(() => emitted.some(({ payload }) => (payload as { type?: string }).type === "done"))
    expect(await service.rpc!["kernel.status"]({ path: "/tmp/demo.wls" })).toMatchObject({ status: "ready" })
  })

  test("non-protocol stdout lines become output events", async () => {
    const { host, emitted } = makeHost()
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    await service.rpc!["kernel.eval"]({ path: "/tmp/out.wls", code: "Print[1]" })
    await until(() => spawned.length === 1 && spawned[0]!.requests.length > 0)

    const kernel = spawned[0]!
    kernel.emitOutput("hello from Print")
    kernel.emitProtocol({ type: "eval-result", id: "x", ok: true, text: "Null" })
    await until(() => emitted.some(({ payload }) => (payload as { kind?: string }).kind === "output"))
    const output = emitted.find(({ payload }) => (payload as { kind?: string }).kind === "output")!
    expect(output.payload).toMatchObject({ path: "/tmp/out.wls", kind: "output", text: "hello from Print" })
  })

  test("continue without a pause is rejected", async () => {
    const { host } = makeHost()
    const { spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    await service.rpc!["kernel.eval"]({ path: "/tmp/idle.wls", code: "1" })
    await expect(service.rpc!["kernel.continue"]({ path: "/tmp/idle.wls" })).rejects.toThrow(/not paused/)
  })

  test("invalid inputs are rejected", async () => {
    const { host } = makeHost()
    const service = createWlsService(host, { spawnKernel: makeFakeSpawn().spawnKernel })
    await expect(service.rpc!["kernel.run"]({ path: "" })).rejects.toThrow()
    await expect(service.rpc!["kernel.run"]({ path: "/a.wls", code: 5 })).rejects.toThrow()
    await expect(service.rpc!["kernel.run"]({ path: "/a.wls", code: "1", breakpoints: ["x"] })).resolves.toMatchObject({
      started: true,
    })
  })

  test("dispose kills kernels", async () => {
    const { host } = makeHost()
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    await service.rpc!["kernel.eval"]({ path: "/tmp/k.wls", code: "1" })
    await until(() => spawned.length === 1)
    await service.dispose!()
    expect(spawned[0]!.killed).toBe(true)
    expect(await service.rpc!["kernel.status"]({ path: "/tmp/k.wls" })).toMatchObject({
      status: "stopped",
      kernelRunning: false,
    })
  })

  test("kernel exit transitions status and emits kernel-exit", async () => {
    const { host, emitted } = makeHost()
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    await service.rpc!["kernel.eval"]({ path: "/tmp/gone.wls", code: "1" })
    await until(() => spawned.length === 1 && spawned[0]!.requests.length > 0)
    spawned[0]!.exit(0)
    await until(() => emitted.some(({ payload }) => (payload as { type?: string }).type === "kernel-exit"))
    expect(await service.rpc!["kernel.status"]({ path: "/tmp/gone.wls" })).toMatchObject({ kernelRunning: false })
  })

  test("maxKernels evicts the least recently used kernel", async () => {
    const { host } = makeHost({ maxKernels: 1 })
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })

    await service.rpc!["kernel.eval"]({ path: "/tmp/one.wls", code: "1" })
    await until(() => spawned.length === 1)
    await until(() => spawned[0]!.killed === false && spawned[0]!.requests.length > 0)

    await service.rpc!["kernel.eval"]({ path: "/tmp/two.wls", code: "1" })
    await until(() => spawned.length === 2)
    await until(() => spawned[0]!.killed === true)
    expect(spawned[1]!.killed).toBe(false)
  })
})

describe("wolfram_eval tool (fake kernel)", () => {
  test("evaluates through the process service and returns the result", async () => {
    const { host } = makeHost()
    const { spawned, spawnKernel } = makeFakeSpawn((kernel, request) => {
      if (request.op === "eval") {
        setTimeout(
          () => kernel.emitProtocol({ type: "eval-result", id: request.id, ok: true, text: `echo:${request.code}` }),
          5,
        )
      }
    })
    const service = createWlsService(host, { spawnKernel })
    const hooks = await extensionDefault.server({
      directory: "/tmp/proj",
      extension: { ...host, service },
    } as unknown as ExtensionPluginInput)

    const result = (await hooks.tool!.wolfram_eval.execute({ code: "1+1" }, { sessionID: "s1" } as never)) as string
    expect(result).toContain("wolfram> 1+1")
    expect(result).toContain("echo:1+1")
    await until(() => spawned.length === 1)
    await service.dispose!()
  })

  test("exposeTool=never disables the tool without spawning a kernel", async () => {
    const { host } = makeHost({ exposeTool: "never" })
    const { spawned, spawnKernel } = makeFakeSpawn()
    const service = createWlsService(host, { spawnKernel })
    const hooks = await extensionDefault.server({
      directory: "/tmp/proj",
      extension: { ...host, service },
    } as unknown as ExtensionPluginInput)

    const result = (await hooks.tool!.wolfram_eval.execute({ code: "1+1" }, { sessionID: "s1" } as never)) as string
    expect(result).toContain("disabled")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(spawned.length).toBe(0)
    await service.dispose!()
  })
})
