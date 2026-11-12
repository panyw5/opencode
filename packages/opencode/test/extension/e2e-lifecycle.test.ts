// Always-on end-to-end extension lifecycle regression net (remediation plan
// T6.1). Packs the self-contained fixture in test/extension/fixtures/e2e-ext
// and drives the real installer and runtime through the full lifecycle:
// install → first RPC activation → extension tool via ToolRegistry → host.emit
// events → disable (hooks withdrawn, child process reaped) → enable → update
// to a new version → uninstall (registry row removed, data retained).
//
// No Wolfram, no Electron, no skipIf: this file must stay runnable on a bare
// CI checkout because Phase 5 will rely on it as the regression net.
import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import tar from "tar-stream"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { FetchHttpClient } from "effect/unstable/http"
import { GlobalBus } from "../../src/bus/global"
import { Bus } from "@/bus"
import { installation } from "../../src/extension/install-service"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionID } from "../../src/extension/schema"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { BackgroundShell } from "@/background/shell"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectTask } from "@/project-task/service"
import { IM } from "@/im/service"
import { IMOwner } from "@/im/owner"
import { IMSubscription } from "@/im/subscription"
import { Browser } from "@/browser"
import { SessionInput } from "@/session/input"
import { SessionID, MessageID } from "@/session/schema"
import { disposeAllInstances, TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "e2e-ext")
const id = ExtensionID.make("test.e2e-ext")
const PING_EVENT = "test.e2e-ext/ping"
const TOOL_ID = "e2e_ping"

// Same layer stack as test/tool/registry.test.ts: the real ToolRegistry pulls
// extension tools through Plugin.list → ExtensionRuntime.instanceHooks, which
// is exactly the path production takes.
const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})
const registryLayer = ToolRegistry.layer.pipe(
  Layer.provide(testInstanceStoreLayer),
  Layer.provide(configLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Question.defaultLayer),
  Layer.provide(Todo.defaultLayer),
  Layer.provide(ProjectTask.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(
    Layer.mergeAll(
      SessionStatus.defaultLayer,
      BackgroundJob.defaultLayer,
      BackgroundShell.defaultLayer,
      SessionInput.defaultLayer,
      IM.defaultLayer,
      IMOwner.defaultLayer,
      IMSubscription.defaultLayer,
    ),
  ),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
  Layer.provide(Reference.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(Instruction.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(node),
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
  Layer.provide(Browser.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(registryLayer.pipe(Layer.provide(RuntimeFlags.layer({}))), node, Agent.defaultLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

function assertTestStorage() {
  const home = process.env.OPENCODE_TEST_HOME
  if (!home || path.basename(path.dirname(home)) !== `opencode-test-data-${process.pid}`) {
    throw new Error("e2e lifecycle tests require the package's isolated test/preload.ts")
  }
  for (const directory of [Global.Path.data, Global.Path.cache]) {
    const relative = path.relative(path.dirname(home), directory)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("e2e lifecycle tests refuse non-test data/cache storage")
    }
  }
}

test("e2e lifecycle fixture refuses data access without the isolated test preload", () => {
  const original = process.env.OPENCODE_TEST_HOME
  try {
    delete process.env.OPENCODE_TEST_HOME
    expect(assertTestStorage).toThrow("isolated test/preload.ts")
  } finally {
    if (original === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = original
  }
})

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Packs the on-disk fixture into an npm-layout tgz pinned at `version`. */
async function pack(root: string, version: string) {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, "package.json"), "utf8"))
  manifest.version = version
  const server = await readFile(path.join(FIXTURE_DIR, "server.js"))
  const archive = tar.pack()
  const chunks: Buffer[] = []
  const reading = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk))
  })()
  archive.entry({ name: "package/package.json" }, JSON.stringify(manifest, null, 2))
  archive.entry({ name: "package/server.js" }, server)
  archive.finalize()
  await reading
  const bytes = gzipSync(Buffer.concat(chunks))
  // A stable file location keeps archive-update source identity intact.
  const file = path.join(root, "candidate.tgz")
  await writeFile(file, bytes)
  return { type: "local" as const, path: file, sha256: sha(bytes) }
}

type Seen = { id: string; name: string; data: unknown }

async function setup() {
  assertTestStorage()
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-e2e-ext-")))
  const registry = path.join(root, "registry.json")
  const original = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
  const service = installation()
  const seen: Seen[] = []
  const listener = (event: { payload: { type: string; properties?: Seen } }) => {
    if (event.payload.type === "extension.event" && event.payload.properties?.id === id) {
      seen.push(event.payload.properties)
    }
  }
  GlobalBus.on("event", listener)
  return {
    root,
    registry,
    service,
    seen,
    source: (version: string) => pack(root, version),
    dataFile: path.join(Global.Path.data, "extensions", "data", id, "e2e.txt"),
    async teardown() {
      GlobalBus.off("event", listener)
      try {
        // The runtime deliberately retains pins until this test-only reset;
        // reset is teardown, never evidence that production released them.
        await ExtensionRuntime.testing.reset()
        await service.close()
      } finally {
        if (original === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
        else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = original
        await rm(root, { recursive: true, force: true })
        // Global.Path.tmp is shared across test processes; remove our copies.
        await rm(path.join(Global.Path.tmp, "extension-modules", id), { recursive: true, force: true })
      }
    },
  }
}

const toolCtx = (agent: string): Tool.Context => ({
  sessionID: SessionID.make("ses_e2e"),
  messageID: MessageID.make("msg_e2e"),
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it.instance(
  "extension lifecycle: install → rpc → tool → emit → disable → enable → update → uninstall",
  () =>
    Effect.gen(function* () {
      const env = yield* Effect.promise(setup)
      try {
        const { service, seen } = env
        const test = yield* TestInstance
        const rpc = (method: string, input: Record<string, unknown> = {}) =>
          ExtensionRuntime.rpc({ id, method, input, directory: test.directory })

        // ── install ────────────────────────────────────────────────────────
        const source1 = yield* Effect.promise(() => env.source("1.0.0"))
        const prepared = yield* Effect.promise(() => service.prepare({ kind: "install", source: source1 }))
        const installed = yield* Effect.promise(() =>
          service.commit(prepared.operationId, prepared.token, { enable: true }),
        )
        expect(installed).toMatchObject({ committed: true, synced: true })

        // ── first RPC triggers activation ──────────────────────────────────
        const echo = yield* Effect.promise(() => rpc("echo", { message: "hello" }))
        expect(echo).toMatchObject({ echo: "hello", extension: id, version: "1.0.0" })
        expect(ExtensionRuntime.describe(id)).toMatchObject({ hasService: true, runtime: "ready" })
        expect(yield* Effect.promise(() => Bun.file(env.dataFile).exists())).toBe(true)

        // ── extension tool through the real ToolRegistry ───────────────────
        const registry = yield* ToolRegistry.Service
        const tools1 = yield* registry.all()
        const tool = tools1.find((item) => item.id === TOOL_ID)
        expect(tool).toBeDefined()
        const agent = (yield* (yield* Agent.Service).defaultInfo()).name
        const executed = yield* tool!.execute({ text: "lifecycle" }, toolCtx(agent))
        expect(executed.output).toBe("e2e-pong:lifecycle")
        expect(executed.metadata).toMatchObject({ echoed: "lifecycle" })

        // ── host.emit events reach the bus (tool + rpc paths) ──────────────
        expect(seen.some((e) => e.name === PING_EVENT && (e.data as any)?.source === "tool")).toBe(true)
        yield* Effect.promise(() => rpc("emit.ping", { message: "bus" }))
        expect(seen.some((e) => e.name === PING_EVENT && (e.data as any)?.source === "rpc")).toBe(true)

        // ── managed child process ──────────────────────────────────────────
        const started = (yield* Effect.promise(() => rpc("child.start"))) as { running: boolean; pid: number }
        expect(started.running).toBe(true)
        expect(started.pid).toBeGreaterThan(0)
        expect(alive(started.pid)).toBe(true)

        // ── disable: hooks withdrawn, service + child stopped ──────────────
        // Mirrors Extension.Service.setEnabled (registry write → invalidate →
        // disable) without the watcher, which is not part of this test.
        yield* Effect.promise(() => ExtensionRegistry.setEnabled(id, false))
        yield* Effect.promise(() => ExtensionRuntime.invalidateHooks())
        yield* Effect.promise(() => ExtensionRuntime.disable(id))
        expect((yield* registry.all()).some((item) => item.id === TOOL_ID)).toBe(false)
        expect(ExtensionRuntime.describe(id)).toMatchObject({ hasService: false, runtime: "idle" })
        expect(alive(started.pid)).toBe(false)
        const disabled = yield* Effect.promise(() =>
          rpc("echo").then(
            () => "ok",
            () => "rejected",
          ),
        )
        expect(disabled).toBe("rejected")

        // ── enable: hooks and service come back ────────────────────────────
        yield* Effect.promise(() => ExtensionRegistry.setEnabled(id, true))
        yield* Effect.promise(() => ExtensionRuntime.invalidateHooks())
        expect((yield* registry.all()).some((item) => item.id === TOOL_ID)).toBe(true)
        const echo2 = yield* Effect.promise(() => rpc("echo", { message: "back" }))
        expect(echo2).toMatchObject({ echo: "back", version: "1.0.0" })
        const restarted = (yield* Effect.promise(() => rpc("child.start"))) as { pid: number }
        expect(restarted.pid).toBeGreaterThan(0)
        expect(alive(restarted.pid)).toBe(true)

        // ── update to 2.0.0 while running ──────────────────────────────────
        const source2 = yield* Effect.promise(() => env.source("2.0.0"))
        const update = yield* Effect.promise(() => service.prepare({ kind: "update", id, source: source2 }))
        const updated = yield* Effect.promise(() => service.commit(update.operationId, update.token))
        expect(updated).toMatchObject({ committed: true, synced: true })
        const row = (yield* Effect.promise(() => ExtensionRegistry.snapshot(id))).row
        expect(row?.version).toBe("2.0.0")
        expect(row?.enabled).toBe(true)
        // The previous generation was quiesced: its child must be reaped.
        expect(alive(restarted.pid)).toBe(false)
        const version = yield* Effect.promise(() => rpc("version"))
        expect(version).toBe("2.0.0")
        const echo3 = yield* Effect.promise(() => rpc("echo", { message: "v2" }))
        expect(echo3).toMatchObject({ echo: "v2", version: "2.0.0" })
        expect((yield* registry.all()).some((item) => item.id === TOOL_ID)).toBe(true)

        // ── uninstall: row removed, non-purge data retained ────────────────
        const remove = yield* Effect.promise(() => service.prepare({ kind: "uninstall", id }))
        const removed = yield* Effect.promise(() => service.commit(remove.operationId, remove.token))
        expect(removed.committed).toBe(true)
        const snapshot = yield* Effect.promise(() => ExtensionRegistry.snapshot(id))
        expect(snapshot.row).toBeUndefined()
        // The default uninstall keeps a retained tombstone (settings/data lineage).
        expect(snapshot.retained).toBeDefined()
        const gone = yield* Effect.promise(() =>
          rpc("echo").then(
            () => "ok",
            () => "rejected",
          ),
        )
        expect(gone).toBe("rejected")
        // Non-purge uninstall must not have touched the extension's data dir.
        expect(yield* Effect.promise(() => Bun.file(env.dataFile).exists())).toBe(true)
      } finally {
        yield* Effect.promise(() => env.teardown())
      }
    }),
  120_000,
)
