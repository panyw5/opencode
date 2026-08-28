import { beforeAll, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { join, resolve } from "node:path"

import type { SqliteMigrationProgress } from "../preload/types"
import { resolveDesktopStartupPaths } from "./server-env"

type ServerModule = typeof import("./server")

class FakeSidecar extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly postedMessages: unknown[] = []
  killed = false

  postMessage(message: unknown): void {
    this.postedMessages.push(message)
  }

  kill(): void {
    this.killed = true
    this.emit("exit", 143)
  }

  emitMessage(message: unknown): void {
    this.emit("message", message)
  }

  emitExit(code: number): void {
    this.emit("exit", code)
  }
}

type HarnessOptions = {
  startStallTimeout?: number
  checkHealth?: (url: string, password?: string | null) => Promise<boolean>
  delay?: (ms: number) => Promise<void>
}

const startupPaths = resolveDesktopStartupPaths({ userDataPath: "/tmp/opencode-user-data" })

let serverModule: ServerModule | undefined

function module(): ServerModule {
  if (!serverModule) throw new Error("server module was not loaded")
  return serverModule
}

function createHarness(options: HarnessOptions = {}) {
  const child = new FakeSidecar()
  const app = new EventEmitter()
  const spawnLocalServer = module().createSpawnLocalServer({
    app,
    forkSidecar: () => child,
    makeDirectory: async () => undefined,
    sidecarPath: "/tmp/sidecar.js",
    checkHealth: options.checkHealth ?? (async () => true),
    delay: options.delay ?? ((ms) => Bun.sleep(ms)),
    startStallTimeout: options.startStallTimeout ?? 100,
    stopTimeout: 25,
  })

  const start = () =>
    spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: true,
      startupPaths,
    })

  return { app, child, spawnLocalServer, start }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    return new Error(String(error))
  }
  throw new Error("expected promise to reject")
}

beforeAll(async () => {
  mock.module("electron", () => ({
    app: {
      on: () => undefined,
      off: () => undefined,
      getPath: () => "/tmp/opencode-user-data",
    },
    utilityProcess: {
      fork: () => {
        throw new Error("default utilityProcess.fork should not run in server tests")
      },
    },
  }))
  mock.module("./shell-env", () => ({
    getUserShell: () => "/bin/sh",
    loadShellEnv: () => null,
  }))
  mock.module("./store", () => ({
    getStore: () => ({
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
    }),
  }))
  serverModule = await import("./server")
})

describe("spawnLocalServer", () => {
  test("rejects startup when the sidecar reports an error before ready", async () => {
    const { child, start } = createHarness()
    const started = start()

    await Bun.sleep(0)
    child.emitMessage({
      type: "error",
      error: { message: "migration failed", stack: "Error: migration failed\n    at sidecar" },
    })

    const error = await rejection(started)

    expect(error.message).toBe("migration failed")
    expect(error.stack).toContain("sidecar")
    expect(child.killed).toBe(true)
  })

  test("rejects startup when the sidecar exits before ready", async () => {
    const { child, spawnLocalServer } = createHarness()
    const exitCodes: number[] = []
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onExit: (code) => exitCodes.push(code),
    })

    await Bun.sleep(0)
    child.emitExit(2)
    const error = await rejection(started)

    expect(error.message).toBe("Sidecar exited before ready with code 2")
    expect(exitCodes).toEqual([2])
    expect(child.killed).toBe(false)
  })

  test("forwards sqlite progress and keeps startup alive while waiting for ready", async () => {
    const progress: SqliteMigrationProgress[] = []
    const { child, spawnLocalServer } = createHarness({ startStallTimeout: 150 })
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: true,
      startupPaths,
      onSqliteProgress: (item) => progress.push(item),
    })

    await Bun.sleep(40)
    child.emitMessage({
      type: "sqlite",
      progress: { type: "InProgress", value: 50, message: "Applying database migrations" },
    })
    await Bun.sleep(130)
    child.emitMessage({ type: "ready" })
    const result = await started

    expect(progress).toEqual([{ type: "InProgress", value: 50, message: "Applying database migrations" }])
    expect(result.listener).toBeDefined()
    expect(child.killed).toBe(false)
  })

  test("calls onUnexpectedExit after ready and health success", async () => {
    const unexpectedCodes: number[] = []
    const healthUrls: string[] = []
    const { child, spawnLocalServer } = createHarness({
      checkHealth: async (url) => {
        healthUrls.push(url)
        return true
      },
    })
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onUnexpectedExit: (code) => unexpectedCodes.push(code),
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait
    child.emitExit(7)

    expect(healthUrls).toEqual(["http://127.0.0.1:4096"])
    expect(unexpectedCodes).toEqual([7])
  })

  test("does not call onUnexpectedExit when stop is expected", async () => {
    const unexpectedCodes: number[] = []
    const { child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onUnexpectedExit: (code) => unexpectedCodes.push(code),
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait
    const stopping = result.listener.stop()
    child.emitExit(0)
    await stopping

    expect(child.postedMessages).toContainEqual({ type: "stop" })
    expect(unexpectedCodes).toEqual([])
  })

  test("starts the sidecar in the app-private default workspace", async () => {
    let cwd = ""
    let receivedPaths: typeof startupPaths | undefined
    const child = new FakeSidecar()
    const spawnLocalServer = module().createSpawnLocalServer({
      app: new EventEmitter(),
      forkSidecar: (_sidecar, sidecarCwd, paths) => {
        cwd = sidecarCwd
        receivedPaths = paths
        return child
      },
      makeDirectory: async () => undefined,
      sidecarPath: "/tmp/sidecar.js",
      checkHealth: async () => true,
      delay: (ms) => Bun.sleep(ms),
      startStallTimeout: 100,
      stopTimeout: 25,
    })
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    await started

    expect(cwd).toBe(join(resolve("/tmp/opencode-user-data"), "default-workspace"))
    expect(receivedPaths).toBe(startupPaths)
  })
})

describe("spawnLocalServer crash and shutdown edge cases", () => {
  test("treats exit between ready and health check as unexpected and rejects health.wait", async () => {
    const unexpectedCodes: number[] = []
    const { child, spawnLocalServer } = createHarness({ checkHealth: async () => false })
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onUnexpectedExit: (code) => unexpectedCodes.push(code),
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    child.emitExit(9)

    expect(unexpectedCodes).toEqual([9])
    const error = await rejection(result.health.wait)
    expect(error.message).toBe("Sidecar exited before health check passed with code 9")
  })

  test("keeps polling health until checkHealth succeeds", async () => {
    let calls = 0
    const { child, spawnLocalServer } = createHarness({
      checkHealth: async () => {
        calls += 1
        return calls >= 3
      },
    })
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", { needsMigration: false, startupPaths })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait

    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test("rejects and kills the sidecar when ready never arrives", async () => {
    const { child, start } = createHarness({ startStallTimeout: 50 })
    const error = await rejection(start())

    expect(error.message).toContain("Sidecar did not become ready within 50ms")
    expect(child.killed).toBe(true)
  })

  test("kills the sidecar when it ignores the stop command", async () => {
    const unexpectedCodes: number[] = []
    const { child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onUnexpectedExit: (code) => unexpectedCodes.push(code),
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait

    await result.listener.stop()

    expect(child.postedMessages).toContainEqual({ type: "stop" })
    expect(child.killed).toBe(true)
    expect(unexpectedCodes).toEqual([])
  })

  test("resolves stop immediately without posting when the sidecar already exited", async () => {
    const { child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", { needsMigration: false, startupPaths })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait
    child.emitExit(0)

    await result.listener.stop()

    expect(child.postedMessages).not.toContainEqual({ type: "stop" })
  })

  test("returns the same stop promise for concurrent stop calls", async () => {
    const { child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", { needsMigration: false, startupPaths })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    const result = await started
    await result.health.wait

    const first = result.listener.stop()
    const second = result.listener.stop()
    child.emitExit(0)
    await Promise.all([first, second])

    expect(second).toBe(first)
    const stopMessages = child.postedMessages.filter((message) => (message as { type?: string }).type === "stop")
    expect(stopMessages).toHaveLength(1)
  })

  test("forwards sidecar error messages to stderr after ready", async () => {
    const stderr: string[] = []
    const { child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onStderr: (line) => stderr.push(line),
    })

    await Bun.sleep(0)
    child.emitMessage({ type: "ready" })
    await started
    child.emitMessage({ type: "error", error: { message: "fatal after ready" } })

    expect(stderr).toContain("sidecar error: fatal after ready")
  })

  test("logs child-process-gone only for the sidecar utility process", async () => {
    const stderr: string[] = []
    const { app, child, spawnLocalServer } = createHarness()
    const started = spawnLocalServer("127.0.0.1", 4096, "secret", {
      needsMigration: false,
      startupPaths,
      onStderr: (line) => stderr.push(line),
    })

    await Bun.sleep(0)
    app.emit("child-process-gone", {}, { type: "Utility", name: "opencode server", reason: "crashed", exitCode: 1 })
    app.emit("child-process-gone", {}, { type: "Utility", name: "other service", reason: "crashed", exitCode: 1 })
    app.emit("child-process-gone", {}, { type: "GPU", name: "opencode server", reason: "crashed", exitCode: 1 })

    expect(stderr.filter((line) => line.includes("lifecycle gone"))).toEqual([
      "sidecar lifecycle gone type=Utility name=opencode server reason=crashed exitCode=1",
    ])

    child.emitMessage({ type: "ready" })
    await started
  })
})

describe("checkHealth", () => {
  test("returns true for a healthy response and sends basic auth", async () => {
    let authorization: string | null = null
    let requestedPath = ""
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization")
        requestedPath = new URL(request.url).pathname
        return new Response("ok")
      },
    })

    try {
      const healthy = await module().checkHealth(`http://127.0.0.1:${server.port}`, "secret")
      expect(healthy).toBe(true)
      expect(requestedPath).toBe("/global/health")
      expect(authorization).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
    } finally {
      server.stop(true)
    }
  })

  test("returns false when the server responds with an error status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 500 }),
    })

    try {
      expect(await module().checkHealth(`http://127.0.0.1:${server.port}`, "secret")).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("returns false for an invalid url", async () => {
    expect(await module().checkHealth("not a url")).toBe(false)
  })

  test("returns false when the connection is refused", async () => {
    expect(await module().checkHealth("http://127.0.0.1:1", null)).toBe(false)
  })
})
