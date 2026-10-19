import { expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/opencode-remote-controller-test" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  utilityProcess: {
    fork: () => {
      throw new Error("test fork must be injected")
    },
  },
}))

const { createRemoteAccessController } = await import("./controller")

type MessageHandler = (message: any) => void
class FakeWorker {
  handlers = new Map<string, Set<(...args: any[]) => void>>()
  startCount = 0
  killCount = 0
  pendingStart?: any
  pendingStop?: any
  failStart = false
  delayStop = false
  autoStart = false
  storeResults: Array<{ id: string; ok: boolean }> = []
  postMessage(message: any) {
    if (message.type === "store-result") {
      this.storeResults.push({ id: message.id, ok: message.ok })
      return
    }
    if (message.type !== "request") return
    if (message.method === "start") {
      this.startCount += 1
      this.pendingStart = message
      if (this.failStart) {
        this.emit("message", { type: "response", id: message.id, ok: false })
        return
      }
      this.emit("message", { type: "status", generation: message.input.generation, phase: "connecting" })
      if (this.autoStart) this.completeStart()
      return
    }
    if (message.method === "stop") {
      if (this.delayStop) {
        this.pendingStop = message
        return
      }
      this.emit("message", { type: "response", id: message.id, ok: true })
      return
    }
    this.emit("message", { type: "response", id: message.id, ok: true, value: [] })
  }
  on(event: string, handler: (...args: any[]) => void) {
    let handlers = this.handlers.get(event)
    if (!handlers) this.handlers.set(event, (handlers = new Set()))
    handlers.add(handler)
  }
  once(event: string, handler: (...args: any[]) => void) {
    const onceHandler = (...args: any[]) => {
      this.handlers.get(event)?.delete(onceHandler)
      handler(...args)
    }
    this.on(event, onceHandler)
  }
  emit(event: string, value: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
  completeStart() {
    const request = this.pendingStart
    if (!request) return
    this.pendingStart = undefined
    this.emit("message", { type: "response", id: request.id, ok: true, value: { url: "https://remote.example" } })
    this.emit("message", {
      type: "status",
      generation: request.input.generation,
      phase: "online",
      url: "https://remote.example",
    })
  }
  completeStop() {
    const request = this.pendingStop
    if (!request) return
    this.pendingStop = undefined
    this.emit("message", { type: "response", id: request.id, ok: true })
  }
  kill() {
    this.killCount += 1
    this.emit("exit", 0)
  }
}

function fixture(
  initial?: any,
  persistWrite?: (value: any) => Promise<void>,
  persistClear?: () => Promise<void>,
  persistRead?: () => Promise<any>,
) {
  let enabled = false
  let value = initial ?? {
    version: 1,
    auth: { version: 1, devices: [] },
    tunnel: { version: 1, identities: {}, pending: {} },
  }
  let clears = 0
  let reads = 0
  const worker = new FakeWorker()
  const ctrl = createRemoteAccessController({
    workerPath: "/tmp/remote-worker.js",
    webRoot: "/tmp/remote-web",
    getUpstream: () => ({ url: "http://127.0.0.1:1234", username: "user", password: "secret" }),
    getEnabled: () => enabled,
    setEnabled: (next) => {
      enabled = next
    },
    log: () => {},
    fork: () => worker as any,
    persist: {
      read: async () => {
        reads += 1
        return persistRead ? persistRead() : value
      },
      write: async (next) => {
        await persistWrite?.(next)
        value = next
      },
      clear: async () => {
        clears += 1
        await persistClear?.()
        value = undefined
      },
    },
  })
  return {
    ctrl,
    worker,
    get enabled() {
      return enabled
    },
    get clears() {
      return clears
    },
    get reads() {
      return reads
    },
    get value() {
      return value
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("remote controller enable is prompt and disable wins against an in-flight tunnel start", async () => {
  const f = fixture()
  const initial = await f.ctrl.enable()
  expect(initial).toMatchObject({ enabled: true, phase: "starting" })
  await tick()
  expect(f.worker.startCount).toBe(1)
  const disabled = await f.ctrl.disable()
  expect(disabled).toEqual({ enabled: false, phase: "disabled" })
  f.worker.completeStart()
  await tick()
  expect(f.ctrl.status()).toEqual({ enabled: false, phase: "disabled" })
  expect(f.worker.killCount).toBe(1)
})

test("remote controller does not duplicate an online tunnel and close is idempotent", async () => {
  const f = fixture()
  await f.ctrl.enable()
  await tick()
  f.worker.completeStart()
  await tick()
  expect(f.ctrl.status()).toMatchObject({ phase: "online", url: "https://remote.example" })
  await f.ctrl.enable()
  expect(f.worker.startCount).toBe(1)
  await Promise.all([f.ctrl.close(), f.ctrl.close()])
  expect(f.worker.killCount).toBe(1)
})

test("re-enable waits for a delayed old-worker stop before creating one replacement", async () => {
  let enabled = false
  const workers = [new FakeWorker(), new FakeWorker()]
  let nextWorker = 0
  const ctrl = createRemoteAccessController({
    workerPath: "/tmp/remote-worker.js",
    webRoot: "/tmp/remote-web",
    getUpstream: () => ({ url: "http://127.0.0.1:1234", username: "user", password: "secret" }),
    getEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = value
    },
    log: () => {},
    fork: () => workers[nextWorker++] as any,
    persist: {
      read: async () => ({
        version: 1,
        auth: { version: 1, devices: [] },
        tunnel: { version: 1, identities: {}, pending: {} },
      }),
      write: async () => {},
      clear: async () => {},
    },
  })
  await ctrl.enable()
  await tick()
  workers[0].completeStart()
  await tick()
  workers[0].delayStop = true
  const disabling = ctrl.disable()
  await tick()
  await ctrl.enable()
  expect(workers[1].startCount).toBe(0)
  workers[0].completeStop()
  await disabling
  await tick()
  expect(workers[0].killCount).toBe(1)
  expect(workers[1].startCount).toBe(1)
  workers[1].completeStart()
  await tick()
  expect(ctrl.status()).toMatchObject({ enabled: true, phase: "online", url: "https://remote.example" })
  await ctrl.close()
})

test("remote controller cleans up failed startup without leaving a reconnecting worker", async () => {
  const f = fixture()
  f.worker.failStart = true
  await f.ctrl.enable()
  await tick()
  await tick()
  expect(f.worker.startCount).toBe(1)
  expect(f.worker.killCount).toBe(1)
  expect(f.ctrl.status()).toMatchObject({ enabled: true, phase: "error" })
})

test("remote controller returns sanitized device metadata while disabled and reset clears encrypted state", async () => {
  const f = fixture({
    version: 1,
    auth: {
      version: 1,
      devices: [
        {
          id: "a".repeat(32),
          name: "phone",
          createdAt: 1,
          lastSeenAt: 2,
          expiresAt: Date.now() + 60_000,
          tokenHash: "b".repeat(64),
        },
      ],
    },
    tunnel: { version: 1, identities: {}, pending: {} },
  })
  expect(await f.ctrl.devices()).toEqual([
    {
      id: "a".repeat(32),
      name: "phone",
      createdAt: 1,
      lastSeenAt: 2,
      expiresAt: expect.any(Number),
    },
  ])
  await f.ctrl.reset()
  expect(f.clears).toBe(1)
  expect(f.value as any).toBeUndefined()
})

test("concurrent controller operations share the initial secure-storage read", async () => {
  const f = fixture()
  await Promise.all([f.ctrl.devices(), f.ctrl.devices()])
  expect(f.reads).toBe(1)
})

test("remote reset revokes a persisted tunnel identity without starting a gateway", async () => {
  const f = fixture({
    version: 1,
    auth: { version: 1, devices: [] },
    tunnel: {
      version: 1,
      identities: {
        "opencode-desktop-remote": {
          id: "identity",
          hostname: "remote.example",
          token: "t".repeat(32),
          privateKey: "private-key",
          certificate: "certificate",
          chain: "chain",
          certificateExpiry: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      pending: {},
    },
  })
  await f.ctrl.reset()
  expect(f.worker.startCount).toBe(0)
  expect(f.worker.killCount).toBe(1)
  expect(f.clears).toBe(1)
})

test("explicit reset clears an unreadable remote vault and leaves access disabled", async () => {
  const f = fixture(undefined, undefined, undefined, async () => {
    throw new Error("corrupt ciphertext")
  })
  await f.ctrl.reset()
  expect(f.clears).toBe(1)
  expect(f.value as any).toBeUndefined()
  expect(f.enabled).toBe(false)
  expect(f.ctrl.status()).toEqual({ enabled: false, phase: "disabled" })
})

test("remote reset reports filesystem deletion failure and retains disabled error state", async () => {
  const previous = {
    version: 1,
    auth: { version: 1, devices: [] },
    tunnel: { version: 1, identities: {}, pending: {} },
  }
  const f = fixture(previous, undefined, async () => {
    throw new Error("disk unavailable")
  })
  await expect(f.ctrl.reset()).rejects.toThrow("could not be reset")
  expect(f.value).toEqual(previous)
  expect(f.enabled).toBe(false)
  expect(f.ctrl.status()).toMatchObject({ enabled: false, phase: "error" })
})

test("worker store writes are acknowledged only after durable persistence", async () => {
  let release!: () => void
  const writeGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(undefined, () => writeGate)
  await f.ctrl.enable()
  await tick()
  f.worker.completeStart()
  await tick()
  const auth = {
    version: 1,
    devices: [
      {
        id: "c".repeat(32),
        name: "test device",
        createdAt: 1,
        lastSeenAt: 1,
        expiresAt: Date.now() + 60_000,
        tokenHash: "d".repeat(64),
      },
    ],
  }
  f.worker.emit("message", { type: "store-write", id: "write-1", store: "auth", value: auth })
  await tick()
  expect(f.worker.storeResults).toEqual([])
  release()
  await tick()
  expect(f.worker.storeResults).toEqual([{ id: "write-1", ok: true }])
  await f.ctrl.close()
})

test("failed encrypted persistence is nacked and reset waits for pending writes", async () => {
  let release!: () => void
  const writeGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(undefined, async () => {
    await writeGate
    throw new Error("disk failed")
  })
  await f.ctrl.enable()
  await tick()
  f.worker.completeStart()
  await tick()
  f.worker.autoStart = true
  const auth = {
    version: 1,
    devices: [
      {
        id: "e".repeat(32),
        name: "test device",
        createdAt: 1,
        lastSeenAt: 1,
        expiresAt: Date.now() + 60_000,
        tokenHash: "f".repeat(64),
      },
    ],
  }
  f.worker.emit("message", { type: "store-write", id: "write-2", store: "auth", value: auth })
  await tick()
  const reset = f.ctrl.reset()
  await tick()
  expect(f.clears).toBe(0)
  release()
  await reset
  expect(f.worker.storeResults).toEqual([{ id: "write-2", ok: false }])
  expect(f.clears).toBe(1)
  expect(f.enabled).toBe(false)
  expect(f.worker.killCount).toBe(1)
  expect(f.ctrl.status()).toMatchObject({ enabled: false, phase: "disabled" })
})

test("a worker persistence failure disables the live bridge and explicit reset clears retained data", async () => {
  let storageWorks = false
  const f = fixture(undefined, async () => {
    if (!storageWorks) throw new Error("disk failed")
  })
  await f.ctrl.enable()
  await tick()
  f.worker.completeStart()
  await tick()
  f.worker.emit("message", {
    type: "store-write",
    id: "write-fail-closed",
    store: "auth",
    value: {
      version: 1,
      devices: [
        {
          id: "9".repeat(32),
          name: "test device",
          createdAt: 1,
          lastSeenAt: 1,
          expiresAt: Date.now() + 60_000,
          tokenHash: "8".repeat(64),
        },
      ],
    },
  })
  await tick()
  await tick()
  expect(f.worker.storeResults).toEqual([{ id: "write-fail-closed", ok: false }])
  expect(f.enabled).toBe(false)
  expect(f.worker.killCount).toBe(1)
  expect(f.ctrl.status()).toMatchObject({ enabled: false, phase: "error" })
  await f.ctrl.setUpstream({ url: "http://127.0.0.1:1234", username: "user", password: "secret" })
  expect(f.worker.startCount).toBe(1)
  storageWorks = true
  f.worker.autoStart = true
  await f.ctrl.enable()
  await tick()
  expect(f.enabled).toBe(true)
  expect(f.worker.startCount).toBe(2)
  expect((f.value as any).auth.devices).toHaveLength(1)
  await f.ctrl.disable()
  await f.ctrl.reset()
  expect(f.clears).toBe(1)
  expect(f.value as any).toBeUndefined()
})
