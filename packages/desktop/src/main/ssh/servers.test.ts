import { beforeAll, describe, expect, mock, test } from "bun:test"

const storeData = new Map<string, unknown>()

beforeAll(() => {
  mock.module("electron", () => ({
    app: {
      isPackaged: false,
      on: () => undefined,
      once: () => undefined,
      getPath: () => "/tmp/opencode-test",
    },
  }))
  mock.module("../store", () => ({
    getStore: () => ({
      get: (key: string) => storeData.get(key),
      set: (key: string, value: unknown) => storeData.set(key, value),
      delete: (key: string) => storeData.delete(key),
    }),
  }))
})

type ServersModule = typeof import("./servers")

let mod: ServersModule
beforeAll(async () => {
  mod = await import("./servers")
})

const APP_VERSION = "1.0.0"

type TestOverrides = {
  spawnSidecar?: (target: string) => Promise<{
    listener: {
      stop: () => void
      onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
    }
    url: string
    username: string | null
    password: string
  }>
  probeHost?: (target: string) => Promise<{ reachable: boolean; error: string | null }>
  resolveOpencode?: (target: string) => Promise<string | null>
  readCommandVersion?: (target: string, path: string) => Promise<string | null>
  installOpencode?: (target: string, version: string) => Promise<{ code: number | null; stdout: string; stderr: string }>
  readServers?: () => Array<{ id: string; target: string; autoStart: boolean }>
}

function createController(overrides: TestOverrides = {}) {
  const logs: Array<{ level: string; message: string; meta?: unknown }> = []
  const controller = mod.createSshServersController(APP_VERSION, overrides.spawnSidecar ?? (async () => {
    throw new Error("spawnSidecar not stubbed")
  }), {
    logger: {
      log: (message, meta) => logs.push({ level: "info", message, meta }),
      error: (message, meta) => logs.push({ level: "error", message, meta }),
    },
    readServers: overrides.readServers ?? (() => {
      const record = storeData.get("sshServers") as { servers?: unknown } | undefined
      return (record?.servers as Array<{ id: string; target: string; autoStart: boolean }>) ?? []
    }),
    writeServers: (servers) => storeData.set("sshServers", { servers }),
    probeHost: overrides.probeHost ?? (async () => ({ reachable: true, error: null })),
    resolveOpencode: overrides.resolveOpencode ?? (async () => "/home/amy/.opencode/bin/opencode"),
    readCommandVersion: overrides.readCommandVersion ?? (async () => APP_VERSION),
    installOpencode: overrides.installOpencode ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
  })
  return { controller, logs }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("sshServerIdsToStartOnInitialize", () => {
  test("starts only autoStart servers", () => {
    expect(
      mod.sshServerIdsToStartOnInitialize([
        { id: "ssh:host-a", target: "host-a", autoStart: true },
        { id: "ssh:host-b", target: "host-b", autoStart: false },
      ]),
    ).toEqual(["ssh:host-a"])
  })
})

describe("expectRemoteOpencodeVersion", () => {
  test("accepts matching version", () => {
    expect(() => mod.expectRemoteOpencodeVersion("1.0.0", "1.0.0")).not.toThrow()
  })

  test("rejects mismatched version", () => {
    expect(() => mod.expectRemoteOpencodeVersion("0.9.0", "1.0.0", "amy@host")).toThrow(/expected/)
    expect(() => mod.expectRemoteOpencodeVersion(null, "1.0.0", "amy@host")).toThrow(/expected/)
  })
})

describe("createSshServersController", () => {
  test("addServer persists config and starts sidecar", async () => {
    storeData.clear()
    const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    let stopped = false
    const { controller, logs } = createController({
      spawnSidecar: async (target) => {
        expect(target).toBe("amy@host")
        return {
          listener: {
            stop: () => {
              stopped = true
            },
            onExit: (cb) => exits.push(cb),
          },
          url: "http://127.0.0.1:4123",
          username: "opencode",
          password: "secret",
        }
      },
    })

    const config = await controller.addServer("amy@host")
    expect(config).toEqual({ id: "ssh:amy@host", target: "amy@host", autoStart: true })
    await flush()

    expect(storeData.get("sshServers")).toEqual({ servers: [config] })
    expect(controller.getState().servers).toHaveLength(1)
    expect(controller.getState().servers[0].runtime).toEqual({
      kind: "ready",
      url: "http://127.0.0.1:4123",
      username: "opencode",
      password: "secret",
    })
    expect(logs.some((entry) => entry.message === "ssh sidecar ready")).toBe(true)

    controller.stopAll()
    expect(stopped).toBe(true)
  })

  test("rejects duplicate targets", async () => {
    storeData.clear()
    const { controller } = createController({
      spawnSidecar: async () => {
        throw new Error("should not spawn")
      },
    })
    await controller.addServer("amy@host")
    await expect(() => controller.addServer("amy@host")).toThrow(/already added/)
    controller.stopAll()
  })

  test("marks server failed when the host is unreachable", async () => {
    storeData.clear()
    const { controller, logs } = createController({
      probeHost: async () => ({ reachable: false, error: "Connection refused" }),
    })
    await controller.addServer("down@host")
    await flush()

    const item = controller.getState().servers[0]
    expect(item.runtime.kind).toBe("failed")
    expect(item.runtime.kind === "failed" && item.runtime.message).toContain("Connection refused")
    expect(logs.some((entry) => entry.level === "error")).toBe(true)
    controller.stopAll()
  })

  test("marks server failed when sidecar spawn throws", async () => {
    storeData.clear()
    const { controller } = createController({
      spawnSidecar: async () => {
        throw new Error("OpenCode is not installed on amy@host")
      },
    })
    await controller.addServer("amy@host")
    await flush()

    const item = controller.getState().servers[0]
    expect(item.runtime.kind).toBe("failed")
    expect(item.runtime.kind === "failed" && item.runtime.message).toContain("not installed")
    controller.stopAll()
  })

  test("failed runtime after exit carries the exit code", async () => {
    storeData.clear()
    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
    const { controller } = createController({
      spawnSidecar: async () => ({
        listener: {
          stop: () => undefined,
          onExit: (cb) => {
            exitListener = cb
          },
        },
        url: "http://127.0.0.1:4124",
        username: "opencode",
        password: "secret",
      }),
    })
    await controller.addServer("amy@host")
    await flush()
    expect(controller.getState().servers[0].runtime.kind).toBe("ready")

    exitListener?.(137, null)
    await flush()
    const runtime = controller.getState().servers[0].runtime
    expect(runtime.kind).toBe("failed")
    expect(runtime.kind === "failed" && runtime.message).toContain("137")
    controller.stopAll()
  })

  test("removeServer drops persisted config and state", async () => {
    storeData.clear()
    const { controller } = createController()
    const config = await controller.addServer("amy@host", false)
    await controller.removeServer(config.id)
    await flush()

    expect(controller.getState().servers).toHaveLength(0)
    expect(storeData.get("sshServers")).toEqual({ servers: [] })
  })

  test("installOpencode restarts the matching server", async () => {
    storeData.clear()
    let installed = false
    let spawns = 0
    const { controller } = createController({
      spawnSidecar: async () => {
        spawns++
        if (!installed) throw new Error("OpenCode is not installed on amy@host")
        return {
          listener: {
            stop: () => undefined,
            onExit: () => undefined,
          },
          url: "http://127.0.0.1:4125",
          username: "opencode",
          password: "secret",
        }
      },
      resolveOpencode: async () => (installed ? "/home/amy/.opencode/bin/opencode" : null),
      installOpencode: async () => {
        installed = true
        return { code: 0, stdout: "", stderr: "" }
      },
    })

    await controller.addServer("amy@host")
    await flush()
    expect(controller.getState().servers[0].runtime.kind).toBe("failed")

    await controller.installOpencode("amy@host")
    await flush()
    expect(installed).toBe(true)
    expect(spawns).toBe(2)
    expect(controller.getState().servers[0].runtime.kind).toBe("ready")
    controller.stopAll()
  })

  test("startServer discards the stale attempt when a newer start wins", async () => {
    storeData.clear()
    let spawnCount = 0
    const deferreds: Array<() => void> = []
    const stoppedUrls: string[] = []
    const { controller } = createController({
      spawnSidecar: async () => {
        spawnCount++
        const index = spawnCount
        await new Promise<void>((resolve) => deferreds.push(resolve))
        return {
          listener: {
            stop: () => stoppedUrls.push(`sidecar-${index}`),
            onExit: () => undefined,
          },
          url: `http://127.0.0.1:412${index}`,
          username: "opencode",
          password: "secret",
        }
      },
    })

    await controller.addServer("amy@host", false)
    // Attempt 1 (from addServer) is still mid-flight; two explicit starts
    // invalidate it in turn. Each flush lets the current attempt advance to
    // its next await before the following start invalidates it.
    const first = controller.startServer("ssh:amy@host")
    await flush()
    const second = controller.startServer("ssh:amy@host")
    await flush()
    deferreds.forEach((resolve) => resolve())
    await Promise.all([first, second])
    await flush()

    // The addServer attempt is discarded at the probe gate; attempt 2 spawns
    // a sidecar that is stopped once attempt 3 wins.
    expect(spawnCount).toBe(2)
    expect(stoppedUrls).toEqual(["sidecar-1"])
    expect(controller.getState().servers[0].runtime.kind).toBe("ready")
    expect(controller.getState().servers[0].runtime.kind === "ready" && controller.getState().servers[0].runtime.url).toBe(
      "http://127.0.0.1:4122",
    )
    controller.stopAll()
  })
})
