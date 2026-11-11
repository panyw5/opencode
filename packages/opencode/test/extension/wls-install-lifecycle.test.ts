// Opt-in real release/real kernel lifecycle regression. Never touches the user's registry.
// OPENCODE_WLS_ARCHIVES=/path/to/archives bun test test/extension/wls-install-lifecycle.test.ts
// Optional: OPENCODE_WLS_CDP=1 drives the real Electron form (port 9222) instead of direct service calls.
//
// Release mode replaces only descriptor fetches; artifacts still come from each
// version's real GitHub Release asset through the renderer proxy.
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installation } from "../../src/extension/install-service"
import { confirmThroughRenderer } from "./wls-install-cdp"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionID } from "../../src/extension/schema"

const archives = process.env.OPENCODE_WLS_ARCHIVES
const cdp = process.env.OPENCODE_WLS_CDP === "1"
const id = ExtensionID.make("local.wls-repl")
const descriptorURL = "https://raw.githubusercontent.com/panyw5/opencode-wls/main/stable.json"
const descriptor = (version: string, sha256: string) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    artifact: {
      url: `https://github.com/panyw5/opencode-wls/releases/download/v${version}/opencode-ai-wls-repl-extension-${version}.tgz`,
      sha256,
    },
  })

test.skipIf(!archives)(
  "real WLS: install, evaluate, update a live kernel, uninstall and reinstall without restart",
  async () => {
    const original = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "wls-install-lifecycle-")))
    process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(root, "registry.json")
    const file = path.join(root, "debug.wls")
    const service = installation()
    const digest = async (version: string) =>
      createHash("sha256")
        .update(await Bun.file(path.join(archives!, `opencode-ai-wls-repl-extension-${version}.tgz`)).bytes())
        .digest("hex")
    const source = async (version: string) => ({
      type: "local" as const,
      path: path.join(archives!, `opencode-ai-wls-repl-extension-${version}.tgz`),
    })
    const rpc = (method: string, input: Record<string, unknown> = {}) =>
      ExtensionRuntime.rpc({ id, method, input: { path: file, ...input } })
    // Release fixtures: the same descriptor URL serves the 1.18.58 document for
    // the initial install, then the real 1.18.64 document for the upgrade.
    const oldFixture = { url: descriptorURL, document: descriptor("1.18.58", await digest("1.18.58")) }
    const newFixture = { url: descriptorURL, document: descriptor("1.18.64", await digest("1.18.64")) }
    try {
      const installed = cdp
        ? await confirmThroughRenderer(
            service,
            { kind: "install", source: { type: "release", url: descriptorURL } },
            root,
            false,
            oldFixture,
          )
        : await (async () => {
            const first = await service.prepare({ kind: "install", source: await source("1.18.58") })
            expect(first.version).toBe("1.18.58")
            return service.commit(first.operationId, first.token, { enable: true })
          })()
      expect(installed.committed).toBe(true)
      expect(await rpc("kernel.evalAwait", { code: "lifecycleValue = 41; lifecycleValue + 1" })).toMatchObject({
        ok: true,
        text: "42",
      })
      const previous = (await rpc("kernel.status")) as { pid: number }
      expect(previous.pid).toBeGreaterThan(0)
      const firstRow = (await ExtensionRegistry.snapshot(id)).row
      expect(firstRow?.version).toBe("1.18.58")
      if (cdp) {
        // The form persisted a release source bound to the exact descriptor text.
        expect(firstRow?.source.type).toBe("release")
        expect((firstRow?.source as { descriptor?: string }).descriptor).toBe(descriptorURL)
        expect((firstRow?.source as { sha256?: string }).sha256).toBe(await digest("1.18.58"))
      }
      console.info(`[wls-lifecycle] old release received result=42 pid=${previous.pid}`)

      const update = await service.prepare({ kind: "update", id, source: await source("1.18.64") })
      expect(update.oldVersion).toBe("1.18.58")
      expect(update.version).toBe("1.18.64")
      expect(update.source).toMatchObject({
        type: "archive",
        sha256: "004716ab52a77584c6ac8a984572bd45f73bb790889e859ed881cadc0cced288",
      })
      // Preparing is non-destructive: the old kernel remains usable until confirmation.
      expect(await rpc("kernel.evalAwait", { code: "lifecycleValue" })).toMatchObject({ ok: true, text: "41" })
      if (cdp) await service.cancel(update.operationId, update.token)
      const updated = cdp
        ? await confirmThroughRenderer(
            service,
            { kind: "update", id, target: "release-current" },
            root,
            false,
            newFixture,
          )
        : await service.commit(update.operationId, update.token)
      expect(updated).toMatchObject({ committed: true, synced: true })
      expect(() => process.kill(previous.pid, 0)).toThrow()
      const updatedRow = (await ExtensionRegistry.snapshot(id)).row
      expect(updatedRow?.version).toBe("1.18.64")
      if (cdp) {
        expect(updatedRow?.source.type).toBe("release")
        expect((updatedRow?.source as { descriptor?: string }).descriptor).toBe(descriptorURL)
        expect((updatedRow?.source as { version?: string }).version).toBe("1.18.64")
        expect((updatedRow?.source as { sha256?: string }).sha256).toBe(await digest("1.18.64"))
      }
      expect(await rpc("kernel.evalAwait", { code: "lifecycleValue = 99; lifecycleValue + 1" })).toMatchObject({
        ok: true,
        text: "100",
      })
      const current = (await rpc("kernel.status")) as { pid: number }
      console.info(`[wls-lifecycle] new release received result=100 pid=${current.pid}; old kernel stopped`)

      const removed = cdp
        ? await confirmThroughRenderer(service, { kind: "uninstall", id, purgeData: false }, root)
        : await (async () => {
            const p = await service.prepare({ kind: "uninstall", id, purgeData: false })
            return service.commit(p.operationId, p.token)
          })()
      expect(removed.committed).toBe(true)
      expect(() => process.kill(current.pid, 0)).toThrow()
      expect((await ExtensionRegistry.snapshot(id)).row).toBeUndefined()
      const reinstalled = cdp
        ? await confirmThroughRenderer(
            service,
            { kind: "install", source: { type: "release", url: descriptorURL } },
            root,
            false,
            newFixture,
          )
        : await (async () => {
            const p = await service.prepare({ kind: "install", source: await source("1.18.64") })
            return service.commit(p.operationId, p.token, { enable: true })
          })()
      expect(reinstalled.committed).toBe(true)
      expect(await rpc("kernel.evalAwait", { code: "6 * 7" })).toMatchObject({ ok: true, text: "42" })
      console.info("[wls-lifecycle] uninstall/reinstall completed without restarting; result=42")
    } finally {
      await ExtensionRuntime.testing.reset()
      await service.close()
      if (original === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
      else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = original
      await rm(root, { recursive: true, force: true })
    }
  },
  90_000,
)
