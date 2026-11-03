import { afterEach, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import tar from "tar-stream"
import {
  installation,
  installationCleanup,
  observeInstallations,
  recoverInstallations,
} from "../../src/extension/install-service"
import { provisionData } from "../../src/extension/data"
import { ExtensionLeases } from "../../src/extension/leases"
import { Global } from "@opencode-ai/core/global"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionID } from "../../src/extension/schema"
import { ExtensionWatcher } from "../../src/extension/watch"
import { extensionPackage } from "./fixture"
import { Effect } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import type { PluginInput } from "@opencode-ai/plugin"

let id = ExtensionID.make("test.install-service")
const original = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
const releases: Array<() => Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()))
  await ExtensionRuntime.testing.reset()
  await ExtensionWatcher.resetForTesting()
  if (original === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = original
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(sharedID?: ExtensionID) {
  id = sharedID ?? ExtensionID.make(`test.service-${randomUUID()}`)
  const fixtureID = id
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-install-service-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
  const file = path.join(root, "extension.tgz")
  async function source(version: string) {
    const pack = tar.pack()
    const chunks: Buffer[] = []
    const read = (async () => {
      for await (const chunk of pack) chunks.push(Buffer.from(chunk))
    })()
    pack.entry(
      { name: "package/package.json" },
      JSON.stringify({
        name: "test-install-service",
        version,
        type: "module",
        exports: { "./server": "./server.js" },
        opencode: { manifestVersion: 1, id: fixtureID, displayName: "Install service fixture" },
      }),
    )
    pack.entry(
      { name: "package/server.js" },
      `export default { id: ${JSON.stringify(fixtureID)}, async activate() { return { rpc: { version: () => ${JSON.stringify(version)} }, dispose() {} } } }`,
    )
    pack.finalize()
    await read
    const bytes = gzipSync(Buffer.concat(chunks))
    await writeFile(file, bytes)
    return { type: "local" as const, path: file, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  return { root, registry, source, id: fixtureID, installer: installation() }
}

test("production installation coordinator fences replacement and routes RPC to the new generation", async () => {
  const f = await setup()
  const first = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  expect((await f.installer.commit(first.operationId, first.token, { enable: true })).synced).toBe(true)
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("1.0.0")
  const previous = (await ExtensionRegistry.snapshot(id)).row!
  const next = await f.installer.prepare({ kind: "update", id, source: await f.source("2.0.0") })
  const result = await f.installer.commit(next.operationId, next.token)
  expect(result.committed).toBe(true)
  expect(result.synced).toBe(true)
  expect(result.cleanupPending).toBe(true)
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("2.0.0")
  expect((await ExtensionRegistry.snapshot(id)).row!.installId).not.toBe(previous.installId)
  expect(await Bun.file(path.join(previous.dir, "server.js")).exists()).toBe(true)
})

test("first installation invalidates an actual InstanceState cache built before the new row existed", async () => {
  const f = await setup()
  const prepared = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  ExtensionRuntime.testing.setImporter(async () => ({
    activate: async () => ({}),
    server: async () => ({ tool: { example: { description: "example", args: {}, execute: async () => "new" } } }),
  }))
  const input = { directory: f.root, worktree: f.root, serverUrl: new URL("http://127.0.0.1") } as PluginInput
  const context = { directory: f.root, directoryKey: f.root } as InstanceContext
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0
        const cache = yield* InstanceState.make(() =>
          Effect.acquireRelease(
            Effect.promise(async () => {
              attempts++
              return ExtensionRuntime.instanceHooks(input)
            }),
            (entries) =>
              Effect.promise(async () => {
                for (const entry of entries) await entry.hooks.dispose?.()
              }),
          ),
        )
        const get = InstanceState.get(cache).pipe(Effect.provideService(InstanceRef, context))
        let invalidations = 0
        const unregister = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
          await Effect.runPromise(InstanceState.invalidateAll(cache))
          invalidations++
          // Concurrent rebuilding after the initial invalidation sees no row yet.
          if (invalidations === 1) expect(await Effect.runPromise(get)).toEqual([])
        })
        try {
          const result = yield* Effect.promise(() =>
            f.installer.commit(prepared.operationId, prepared.token, { enable: true }),
          )
          expect(result).toMatchObject({ committed: true, synced: true })
          expect(invalidations).toBe(2)
          const entries = yield* get
          expect(entries[0]!.hooks.tool?.example).toBeDefined()
          expect(yield* get).toBe(entries)
          expect(attempts).toBe(2)
        } finally {
          unregister()
        }
      }),
    ),
  )
})

test("a released fence preserves durable success when postcommit cache invalidation fails", async () => {
  const f = await setup()
  let invalidations = 0
  const unregister = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
    if (++invalidations === 2) throw new Error("postcommit invalidation failed")
  })
  try {
    const prepared = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
    const result = await f.installer.commit(prepared.operationId, prepared.token, { enable: true })
    expect(result).toMatchObject({ committed: true, synced: false, cleanupPending: true })
    expect(result.warnings.join(" ")).toContain("fence release failed")
    expect(await f.installer.commit(prepared.operationId, prepared.token)).toEqual(result)
    expect(invalidations).toBe(2)
    expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("1.0.0")
  } finally {
    unregister()
  }
})

test("an old registry observer cannot quiesce the current registry's same-id runtime", async () => {
  const old = await setup()
  const oldPrepare = await old.installer.prepare({ kind: "install", source: await old.source("1.0.0") })
  await old.installer.commit(oldPrepare.operationId, oldPrepare.token)
  releases.push(await observeInstallations())
  const current = await setup(old.id)
  const prepared = await current.installer.prepare({ kind: "install", source: await current.source("2.0.0") })
  await current.installer.commit(prepared.operationId, prepared.token, { enable: true })
  let disposed = 0
  ExtensionRuntime.testing.setImporter(async () => ({
    activate: async () => ({
      rpc: { version: async () => "current" },
      dispose: async () => {
        disposed++
      },
    }),
  }))
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("current")
  await writeFile(old.registry, JSON.stringify({ version: 2, revision: 2, extensions: {} }))
  await new Promise((resolve) => setTimeout(resolve, 1300))
  expect(disposed).toBe(0)
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("current")
})

test("production uninstall removes routing but preserves the managed generation", async () => {
  const f = await setup()
  const first = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(first.operationId, first.token, { enable: true })
  await ExtensionRuntime.rpc({ id, method: "version" })
  const previous = (await ExtensionRegistry.snapshot(id)).row!
  const prepared = await f.installer.prepare({ kind: "uninstall", id })
  const result = await f.installer.commit(prepared.operationId, prepared.token)
  expect(result.committed).toBe(true)
  expect(result.synced).toBe(true)
  expect((await ExtensionRegistry.snapshot(id)).row).toBeUndefined()
  await expect(ExtensionRuntime.rpc({ id, method: "version" })).rejects.toThrow()
  expect(await Bun.file(path.join(previous.dir, "server.js")).exists()).toBe(true)
})

test("a corrupt registry does not prevent shared observer startup and recovers later", async () => {
  const f = await setup()
  await writeFile(f.registry, "invalid JSON")
  const a = await observeInstallations()
  const b = await observeInstallations()
  releases.push(a, b)
  await writeFile(f.registry, JSON.stringify({ version: 2, revision: 0, extensions: {} }))
  const prepared = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  expect((await f.installer.commit(prepared.operationId, prepared.token)).committed).toBe(true)
  await a()
  await a()
  expect((await ExtensionRegistry.snapshot(id)).row?.version).toBe("1.0.0")
})

test("external link and enable writes refresh production development-watch targets", async () => {
  const f = await setup()
  const linkedID = ExtensionID.make("test.extension")
  const directory = await extensionPackage(path.join(f.root, "development"))
  const subscribed = new Set<string>()
  let reloads = 0
  let callback: import("../../src/extension/watch").WatchCallback | undefined
  const watcher = ExtensionWatcher.start({
    debounceMs: 0,
    subscribe: async (directory, listener) => {
      subscribed.add(directory)
      callback = listener
      return {
        unsubscribe: async () => {
          subscribed.delete(directory)
        },
      }
    },
    onServerChange: async () => {
      reloads++
    },
    serverFingerprint: async () => String(await Bun.file(path.join(directory, "package.json")).text()),
  })
  await watcher.refresh()
  releases.push(await observeInstallations())
  await ExtensionRegistry.link(directory)
  for (let attempt = 0; attempt < 100 && !subscribed.has(directory); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(subscribed.has(directory)).toBe(true)
  await watcher.idle()
  const pkg = await Bun.file(path.join(directory, "package.json")).json()
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ ...pkg, version: "1.2.4" }))
  callback!(null, [])
  await new Promise((resolve) => setTimeout(resolve, 10))
  await watcher.idle()
  expect(reloads).toBe(1)
  await ExtensionRegistry.setEnabled(linkedID, false)
  for (let attempt = 0; attempt < 100 && subscribed.has(directory); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(subscribed.has(directory)).toBe(false)
  await ExtensionRegistry.setEnabled(linkedID, true)
  for (let attempt = 0; attempt < 100 && !subscribed.has(directory); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(subscribed.has(directory)).toBe(true)
})

test("the observer does not stop a locally coordinated generation a second time", async () => {
  const f = await setup()
  releases.push(await observeInstallations())
  const first = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(first.operationId, first.token, { enable: true })
  let disposals = 0
  ExtensionRuntime.testing.setImporter(async () => ({
    id,
    async activate() {
      return {
        rpc: { version: () => "active" },
        dispose() {
          disposals++
        },
      }
    },
  }))
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("active")
  await new Promise((resolve) => setTimeout(resolve, 1300))
  expect(disposals).toBe(0)
  expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("active")
})

test("unloaded managed generations are reclaimed while process-pinned generations survive", async () => {
  const f = await setup()
  const prepared = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(prepared.operationId, prepared.token)
  const row = (await ExtensionRegistry.snapshot(id)).row!
  const remove = await f.installer.prepare({ kind: "uninstall", id })
  const result = await f.installer.commit(remove.operationId, remove.token)
  expect(result.committed).toBe(true)
  expect(result.cleanupPending).toBe(false)
  expect(await Bun.file(path.join(row.dir, "server.js")).exists()).toBe(false)
  expect((await ExtensionRegistry.receipt(remove.operationId))?.cleanupPending).toBe(false)
})

test("a quarantined generation keeps only its own cleanup receipt pending after recovery", async () => {
  const f = await setup()
  const first = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(first.operationId, first.token)
  const row = (await ExtensionRegistry.snapshot(id)).row!
  const blocked = path.join(row.dir, "not-owner-writable")
  await mkdir(blocked, { mode: 0o777 })
  await chmod(blocked, 0o777) // Owned-tree validation refuses this child after quarantine.
  const removed = await f.installer.prepare({ kind: "uninstall", id })
  expect((await f.installer.commit(removed.operationId, removed.token)).cleanupPending).toBe(true)
  expect(await Bun.file(path.join(row.dir, "server.js")).exists()).toBe(false)
  expect((await recoverInstallations(f.registry)).cleanupPending).toBe(true)
  expect((await ExtensionRegistry.receipt(removed.operationId, f.registry))?.cleanupPending).toBe(true)
  const next = await f.installer.prepare({ kind: "install", source: await f.source("2.0.0") })
  await f.installer.commit(next.operationId, next.token)
  const nextRemoval = await f.installer.prepare({ kind: "uninstall", id: f.id })
  expect((await f.installer.commit(nextRemoval.operationId, nextRemoval.token)).cleanupPending).toBe(false)
  expect((await recoverInstallations(f.registry)).cleanupPending).toBe(true)
  expect((await ExtensionRegistry.receipt(removed.operationId, f.registry))?.cleanupPending).toBe(true)
  expect((await ExtensionRegistry.receipt(nextRemoval.operationId, f.registry))?.cleanupPending).toBe(false)
  expect((await readdir(path.join(f.root, "trash"))).length).toBeGreaterThan(0)
})

test("explicit purge removes owned data only when no process has used that data namespace", async () => {
  const f = await setup()
  const prepared = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(prepared.operationId, prepared.token)
  const row = (await ExtensionRegistry.snapshot(id)).row!
  await provisionData({ id, name: row.name, source: row.source })
  const data = path.join(Global.Path.data, "extensions", "data", id)
  await import("node:fs/promises").then((fs) => fs.mkdir(data, { recursive: true }))
  await writeFile(path.join(data, "private"), "secret")
  const remove = await f.installer.prepare({ kind: "uninstall", id, purgeData: true })
  const result = await f.installer.commit(remove.operationId, remove.token)
  expect(result.committed).toBe(true)
  expect(result.cleanupPending).toBe(false)
  expect(await Bun.file(path.join(data, "private")).exists()).toBe(false)
  expect((await ExtensionRegistry.snapshot(id)).retained?.purgedAt).toBeNumber()
})

test("completed purge receipts remain recoverable after a new installation and unrelated pending trash", async () => {
  const f = await setup()
  const first = await f.installer.prepare({ kind: "install", source: await f.source("1.0.0") })
  await f.installer.commit(first.operationId, first.token)
  const removed = await f.installer.prepare({ kind: "uninstall", id, purgeData: true })
  await f.installer.commit(removed.operationId, removed.token)
  const stored = await Bun.file(f.registry).json()
  expect(stored.receipts[removed.operationId].purgeCompleted).toBe(true)
  stored.receipts[removed.operationId].cleanupPending = true // Crash before the completion receipt write.
  await writeFile(f.registry, JSON.stringify(stored))
  const next = await f.installer.prepare({ kind: "install", source: await f.source("2.0.0") })
  await f.installer.commit(next.operationId, next.token)
  const trash = path.join(f.root, "trash", randomUUID())
  await import("node:fs/promises").then((fs) => fs.mkdir(trash, { recursive: true, mode: 0o700 }))
  await writeFile(path.join(trash, "unknown"), "preserved")
  expect((await recoverInstallations(f.registry)).cleanupPending).toBe(true)
  expect((await ExtensionRegistry.receipt(removed.operationId, f.registry))?.cleanupPending).toBe(false)
  expect((await ExtensionRegistry.snapshot(id)).row?.version).toBe("2.0.0")
  expect(await Bun.file(path.join(trash, "unknown")).text()).toBe("preserved")
})
