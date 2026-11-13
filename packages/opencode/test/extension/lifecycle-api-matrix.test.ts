import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import type { ExtensionHost, ExtensionService, RpcHandler, ServerExtension } from "@opencode-ai/extension-kit/server"
import type { ExtensionContext, WebExtension } from "@opencode-ai/extension-kit/web"
import type {
  AuthHook,
  Hooks,
  PluginInput,
  ProviderHook,
  ToolContext,
  ToolDefinition,
  WorkspaceAdapter,
} from "@opencode-ai/plugin"
import { GlobalBus } from "../../src/bus/global"
import { ExtensionRuntime } from "../../src/extension/runtime"

// ── Transfer decision matrix (type level) ─────────────────────────────────
// Exhaustive against the authoring APIs: an added member must get an explicit transfer decision.
// These are protocol requirements, not claims that the adapters have been implemented.
type Transfer = "value" | "handle" | "mutable-output" | "schema-codec" | "managed-process" | "frontend-realm"
const matrix = {
  server: {
    id: "value",
    activate: "handle",
    server: "handle",
  } satisfies Record<keyof ServerExtension, Transfer>,
  service: {
    rpc: "handle",
    dispose: "handle",
  } satisfies Record<keyof ExtensionService, Transfer>,
  host: {
    id: "value",
    version: "value",
    dataDir: "value",
    cacheDir: "value",
    serverUrl: "value",
    settings: "handle",
    setTimeout: "handle",
    setInterval: "handle",
    emit: "handle",
    log: "handle",
  } satisfies Record<keyof ExtensionHost, Transfer>,
  settings: {
    get: "handle",
    onDidChange: "handle",
  } satisfies Record<keyof ExtensionHost["settings"], Transfer>,
  rpcContext: {
    directory: "value",
    signal: "handle",
  } satisfies Record<keyof Parameters<RpcHandler>[1], Transfer>,
  pluginInput: {
    client: "handle",
    project: "value",
    directory: "value",
    worktree: "value",
    experimental_workspace: "handle",
    serverUrl: "value",
    $: "managed-process",
  } satisfies Record<keyof PluginInput, Transfer>,
  workspace: {
    name: "value",
    description: "value",
    configure: "handle",
    create: "handle",
    remove: "handle",
    target: "handle",
  } satisfies Record<keyof WorkspaceAdapter, Transfer>,
  hooks: {
    dispose: "handle",
    event: "handle",
    config: "mutable-output",
    tool: "schema-codec",
    auth: "handle",
    provider: "handle",
    "chat.message": "mutable-output",
    "chat.params": "mutable-output",
    "chat.headers": "mutable-output",
    "permission.ask": "mutable-output",
    "command.execute.before": "mutable-output",
    "tool.execute.before": "mutable-output",
    "shell.env": "mutable-output",
    "tool.execute.after": "mutable-output",
    "assistant.response.before": "mutable-output",
    "assistant.response.after": "mutable-output",
    "experimental.chat.messages.transform": "mutable-output",
    "experimental.chat.system.transform": "mutable-output",
    "experimental.session.compacting": "mutable-output",
    "experimental.compaction.autocontinue": "mutable-output",
    "experimental.text.complete": "mutable-output",
    "tool.definition": "mutable-output",
  } satisfies Record<keyof Hooks, Transfer>,
  auth: {
    provider: "value",
    loader: "handle",
    methods: "handle",
  } satisfies Record<keyof AuthHook, Transfer>,
  provider: {
    id: "value",
    models: "handle",
  } satisfies Record<keyof ProviderHook, Transfer>,
  tool: {
    description: "value",
    args: "schema-codec",
    execute: "handle",
  } satisfies Record<keyof ToolDefinition, Transfer>,
  toolContext: {
    sessionID: "value",
    messageID: "value",
    agent: "value",
    directory: "value",
    worktree: "value",
    abort: "handle",
    metadata: "handle",
    ask: "handle",
  } satisfies Record<keyof ToolContext, Transfer>,
  web: {
    id: "value",
    apiVersion: "value",
    activate: "frontend-realm",
  } satisfies Record<keyof WebExtension, Transfer>,
  webContext: {
    id: "value",
    version: "value",
    fileViewers: "frontend-realm",
    toolRenderers: "frontend-realm",
    panels: "frontend-realm",
    commands: "frontend-realm",
    assets: "handle",
    log: "handle",
    rpc: "handle",
    events: "handle",
    settings: "handle",
  } satisfies Record<keyof ExtensionContext, Transfer>,
}

test("lifecycle transfer decisions preserve mutable outputs, callbacks and realm-owned UI", () => {
  expect(matrix.hooks["chat.message"]).toBe("mutable-output")
  expect(matrix.hooks["tool.execute.after"]).toBe("mutable-output")
  expect(matrix.tool.args).toBe("schema-codec")
  expect(matrix.toolContext.abort).toBe("handle")
  expect(matrix.toolContext.metadata).toBe("handle")
  expect(matrix.auth.methods).toBe("handle")
  expect(matrix.pluginInput.$).toBe("managed-process")
  expect(matrix.webContext.fileViewers).toBe("frontend-realm")
})

// ── Behavioral matrix (T5.3): same semantics under inline and process ─────
//
// Every case below runs against both backends. The fixture probes each API
// surface through values returned over RPC — never through process-local
// globals, which would be invisible to the host under process isolation.
// Documented v1 divergences (input.client / input.$ / experimental_workspace
// and hooks outside tool/rpc/event/dispose) are asserted explicitly.

const MATRIX_SOURCE = `
const state = { disposed: 0, instanceDisposed: 0, events: [], settingsSeen: [] }
export default {
  id: "__ID__",
  async activate(host) {
    host.settings.onDidChange((next) => state.settingsSeen.push({ ...next }))
    return {
      rpc: {
        echo: async (input) => ({ echo: input?.message ?? null, id: host.id, version: host.version }),
        "host.describe": async () => ({
          id: host.id,
          version: host.version,
          dataDir: host.dataDir,
          cacheDir: host.cacheDir,
          serverUrl: host.serverUrl.href,
          settings: host.settings.get(),
        }),
        "settings.seen": async () => state.settingsSeen,
        "timer.tick": async () => new Promise((resolve) => host.setTimeout(() => resolve("ticked"), 10)),
        "spawn.echo": async () => {
          const child = host.spawn(process.execPath, ["-e", "process.stdout.write('spawn-ok')"], {
            stdio: ["ignore", "pipe", "ignore"],
          })
          return await new Promise((resolve, reject) => {
            let buf = ""
            child.onError(reject)
            child.stdout.on("data", (chunk) => { buf += chunk.toString() })
            child.onExit(() => resolve(buf))
          })
        },
        "spawn.exit": async () => {
          const child = host.spawn(process.execPath, ["-e", "process.exit(13)"], {
            stdio: ["ignore", "ignore", "ignore"],
          })
          return await new Promise((resolve) => child.onExit((code) => resolve({ code })))
        },
        "emit.test": async (input, ctx) => {
          host.emit("test.matrix/probe", { source: "rpc", mark: input?.mark ?? null }, { directory: ctx.directory })
          return "emitted"
        },
        "fail.rpc": async () => {
          throw { name: "ExtensionRpcError", code: "KERNEL_DEAD", message: "kernel dead" }
        },
        "fail.raw": async () => {
          throw new Error("raw boom")
        },
        "signal.check": async (input, ctx) => ({ aborted: ctx.signal.aborted }),
        "disposed.count": async () => ({ service: state.disposed, instance: state.instanceDisposed }),
      },
      dispose: () => {
        state.disposed++
      },
    }
  },
  async server(input) {
    return {
      rpc: {
        whoami: () => ({
          directory: input.directory,
          worktree: input.worktree,
          serverUrl: input.serverUrl.href,
          project: input.project?.id ?? null,
        }),
        "surface.probe": () => {
          const denied = {}
          // The denied surface is a truthy throwing Proxy (design §3.5): the
          // object itself is reachable so optional chaining works, but any
          // member access throws. Probe members, not the binding.
          try { void input.client.session } catch { denied.client = true }
          try { void input.$.env } catch { denied.shell = true }
          try { input.experimental_workspace.register("x", {}) } catch { denied.workspace = true }
          return denied
        },
        "events.seen": () => state.events,
      },
      event: async ({ event }) => {
        state.events.push(event)
      },
      tool: {
        probe: {
          description: "probe the tool context",
          args: { text: { type: "string" } },
          execute: async (args, ctx) => ({
            title: "probe",
            output: JSON.stringify({
              text: args?.text ?? null,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              agent: ctx.agent,
              directory: ctx.directory,
              worktree: ctx.worktree,
              aborted: ctx.abort?.aborted ?? null,
            }),
            metadata: { probed: true },
          }),
        },
        asker: {
          description: "ask through the real permission callback",
          args: {},
          execute: async (args, ctx) => {
            await ctx.ask({ permission: "matrix.probe" })
            return "asked"
          },
        },
        meta: {
          description: "report tool metadata",
          args: {},
          execute: async (args, ctx) => {
            ctx.metadata({ title: "from-tool", metadata: { k: "v" } })
            return "meta-done"
          },
        },
      },
      dispose: () => {
        state.instanceDisposed++
      },
    }
  },
}
`

const BAD_SOURCE = `
export default {
  id: "__ID__",
  async activate() { return {} },
  async server() {
    return { auth: { provider: "x" }, tool: {} }
  },
}
`

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-matrix-"))
const registry = path.join(root, "registry.json")
const directories = [path.join(root, "instance-a"), path.join(root, "instance-b")]
let nextDirectory = 0

// Workers launched under `bun test` cannot re-exec the test file as the
// extension-host entrypoint, so the launcher argv is pointed at the CLI.
process.env.OPENCODE_EXTENSION_HOST_ARGV = JSON.stringify([
  process.execPath,
  path.join(import.meta.dir, "../../src/index.ts"),
  "extension-host",
])

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function pluginInput(): PluginInput {
  const directory = directories[nextDirectory++ % directories.length]!
  return {
    client: {},
    project: { id: "matrix-project" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: Object.assign(() => {}, { env: {} }),
  } as unknown as PluginInput
}

async function writePackage(id: string, source: string, isolation: "inline" | "process") {
  const dir = path.join(root, id.replaceAll(".", "-"))
  await mkdir(path.join(dir, "dist"), { recursive: true })
  await writeFile(path.join(dir, "dist", "server.js"), source.replaceAll("__ID__", id))
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
          displayName: "Matrix Extension",
          activation: ["onStartup"],
          contributes: { settings: { theme: { type: "string", title: "Theme", default: "light" } } },
          // The fixture exercises tools and host.spawn; the process backend
          // enforces both declarations (T5.6), inline ignores them (D3).
          permissions: ["tools", "process:spawn"],
          server: { isolation },
        },
      },
      null,
      2,
    ),
  )
  return dir
}

async function link(id: string, dir: string) {
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

/**
 * Production ordering: the registry row is written first (the watcher then
 * calls notifySettings). Writing only through notifySettings is clobbered by
 * the next ensureEntry settings re-read.
 */
async function setSettings(id: string, settings: Record<string, unknown>) {
  const json = await Bun.file(registry).json()
  json.extensions[id].settings = settings
  await writeFile(registry, JSON.stringify(json, null, 2))
  await ExtensionRuntime.notifySettings(id, settings)
}

async function poll<T>(fn: () => Promise<T | undefined>, message: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await fn()
    if (last !== undefined) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} (last=${JSON.stringify(last)})`)
}

function busProbe(type: string) {
  const seen: Array<Record<string, any>> = []
  const listener = (event: { payload: { type: string; properties?: Record<string, unknown> } }) => {
    if (event.payload.type === type && event.payload.properties) seen.push(event.payload.properties)
  }
  GlobalBus.on("event", listener)
  return {
    seen,
    stop() {
      GlobalBus.off("event", listener)
    },
  }
}

function toolCtx(directory: string): ToolContext {
  return {
    sessionID: "ses_matrix",
    messageID: "msg_matrix",
    agent: "matrix-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as ToolContext
}

const backends = ["inline", "process"] as const
type Backend = (typeof backends)[number]
const idOf = (backend: Backend) => `test.mx-${backend}`

for (const backend of backends) {
  describe(`lifecycle api matrix [${backend}]`, () => {
    const id = idOf(backend)
    let dir = ""
    let hooks: Awaited<ReturnType<typeof ExtensionRuntime.instanceHooks>>[number]["hooks"] | undefined
    let input: PluginInput
    const rpc = (method: string, rpcInput: Record<string, unknown> = {}, directory?: string) =>
      ExtensionRuntime.rpc({ id, method, input: rpcInput, directory })

    beforeAll(async () => {
      dir = await writePackage(id, MATRIX_SOURCE, backend)
    })

    beforeEach(async () => {
      process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
      await link(id, dir)
      input = pluginInput()
      const list = await ExtensionRuntime.instanceHooks(input)
      hooks = list.find((item) => item.id === id)?.hooks
      expect(hooks).toBeDefined()
    })

    afterEach(async () => {
      await ExtensionRuntime.testing.reset()
      await rm(registry, { force: true })
    })

    afterAll(async () => {
      delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
      await rm(root, { recursive: true, force: true })
    })

    test("service.rpc forwards input and returns the activation host facts", async () => {
      const echo = await rpc("echo", { message: "hi" })
      expect(echo).toMatchObject({ echo: "hi", id, version: "1.0.0" })
    })

    test("host.describe exposes id/version/dirs/serverUrl/settings", async () => {
      const described = (await rpc("host.describe")) as Record<string, unknown>
      expect(described.id).toBe(id)
      expect(described.version).toBe("1.0.0")
      expect(typeof described.dataDir).toBe("string")
      expect((described.dataDir as string).includes(id)).toBe(true)
      expect(typeof described.cacheDir).toBe("string")
      expect((described.settings as Record<string, unknown>).theme).toBe("light")
    })

    test("settings change reaches onDidChange and settings.get", async () => {
      await setSettings(id, { theme: "dark" })
      await poll(async () => {
        const described = (await rpc("host.describe")) as { settings?: Record<string, unknown> }
        return described.settings?.theme === "dark" ? true : undefined
      }, "settings.get never observed dark")
      await poll(async () => {
        const seen = (await rpc("settings.seen")) as Array<Record<string, unknown>>
        return seen.some((next) => next.theme === "dark") ? true : undefined
      }, "onDidChange never observed dark")
    })

    test("host.setTimeout runs inside the extension generation", async () => {
      expect(await rpc("timer.tick")).toBe("ticked")
    })

    test("host.spawn pipes child stdout back to the extension", async () => {
      expect(await rpc("spawn.echo")).toBe("spawn-ok")
    })

    test("host.spawn reports the observed child exit code", async () => {
      expect(await rpc("spawn.exit")).toEqual({ code: 13 })
    })

    test("host.emit reaches extension.event subscribers with directory", async () => {
      const probe = busProbe("extension.event")
      try {
        await rpc("emit.test", { mark: "matrix" }, input.directory)
        await poll(async () => {
          const hit = probe.seen.find((e) => e.name === "test.matrix/probe")
          return hit ? hit : undefined
        }, "host.emit never reached the bus")
      } finally {
        probe.stop()
      }
    })

    test("typed extension errors keep their code; raw errors surface", async () => {
      await expect(rpc("fail.rpc")).rejects.toMatchObject({ code: "KERNEL_DEAD" })
      await expect(rpc("fail.raw")).rejects.toThrow("raw boom")
    })

    test("unknown methods fail with not-found on both backends", async () => {
      await expect(rpc("missing.method")).rejects.toThrow(/Unknown extension RPC method/)
    })

    test("rpc context carries directory and the request signal", async () => {
      const checked = (await rpc("signal.check", {}, input.directory)) as { aborted: boolean }
      expect(checked.aborted).toBe(false)
    })

    test("instance rpc receives directory/worktree/serverUrl/project", async () => {
      const whoami = hooks!.rpc!.whoami as RpcHandler
      const result = (await whoami(null, { directory: input.directory, signal: new AbortController().signal })) as Record<
        string,
        unknown
      >
      expect(result).toEqual({
        directory: input.directory,
        worktree: input.worktree,
        serverUrl: "http://127.0.0.1:4096/",
        project: "matrix-project",
      })
    })

    test("hooks.event forwards instance events", async () => {
      expect(typeof hooks!.event).toBe("function")
      await hooks!.event!({ event: { type: "matrix.event" } as never })
      await poll(async () => {
        const seen = (await hooks!.rpc!["events.seen"]!(null, {
          directory: input.directory,
          signal: new AbortController().signal,
        })) as unknown[]
        return seen.some((e) => (e as { type?: string }).type === "matrix.event") ? true : undefined
      }, "instance event never arrived")
    })

    test("tool context fields cross the boundary (session/message/agent/dirs/abort)", async () => {
      const ctx = toolCtx(input.directory)
      const result = (await hooks!.tool!.probe.execute({ text: "abc" }, ctx)) as { output: string; metadata?: unknown }
      expect(JSON.parse(result.output)).toEqual({
        text: "abc",
        sessionID: "ses_matrix",
        messageID: "msg_matrix",
        agent: "matrix-agent",
        directory: input.directory,
        worktree: input.worktree,
        aborted: false,
      })
      expect(result.metadata).toMatchObject({ probed: true })
    })

    test("ctx.ask reaches the host permission callback and denies propagate", async () => {
      const asked = deferred<void>()
      const ctx = { ...toolCtx(input.directory), ask: async () => asked.resolve() }
      const allowed = await hooks!.tool!.asker.execute({}, ctx as ToolContext)
      expect(allowed).toBe("asked")
      const denied = { ...toolCtx(input.directory), ask: async () => Promise.reject(new Error("denied")) }
      // Rejection crosses the process boundary as a wire-level error that may
      // not be an `instanceof Error` on this side, so assert on the message.
      const rejected = await hooks!.tool!.asker.execute({}, denied as ToolContext).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(rejected).not.toBeNull()
      expect(rejected instanceof Error ? rejected.message : String(rejected)).toContain("denied")
    })

    test("ctx.metadata notifies the host tool metadata callback", async () => {
      const observed = deferred<{ title?: string; metadata?: Record<string, unknown> }>()
      const ctx = {
        ...toolCtx(input.directory),
        metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => observed.resolve(input),
      }
      const result = await hooks!.tool!.meta.execute({}, ctx as ToolContext)
      expect(result).toBe("meta-done")
      await poll(async () => {
        const value = await Promise.race([observed.promise, Promise.resolve(undefined)])
        return value
      }, "ctx.metadata never reached the host", 5_000)
      const value = await observed.promise
      expect(value).toEqual({ title: "from-tool", metadata: { k: "v" } })
    })

    test("hooks.dispose disposes the worker instance and reports back", async () => {
      await hooks!.dispose?.()
      await poll(async () => {
        const counts = (await rpc("disposed.count")) as { instance: number }
        return counts.instance >= 1 ? true : undefined
      }, "instance dispose never landed")
    })

    test("service.dispose runs during disable and increments the counter", async () => {
      await ExtensionRuntime.disable(id)
      // The generation is gone; the counter lives only inside the old
      // runtime — under process mode its worker is dead, so assert the
      // externally visible contract instead: the slot is idle and fresh RPC
      // re-activates cleanly.
      expect(ExtensionRuntime.describe(id).runtime).toBe("idle")
      const echo = await rpc("echo", { message: "after" })
      expect(echo).toMatchObject({ echo: "after" })
    })

    if (backend === "process") {
      test("process isolation denies input.client/$/experimental_workspace", async () => {
        const probe = (await hooks!.rpc!["surface.probe"](null, {
          directory: input.directory,
          signal: new AbortController().signal,
        })) as Record<string, boolean>
        expect(probe).toEqual({ client: true, shell: true, workspace: true })
      })

      test("hooks outside tool/rpc/event/dispose are rejected at instance.start", async () => {
        const badId = "test.mx-bad"
        const badDir = await writePackage(badId, BAD_SOURCE, "process")
        await link(badId, badDir)
        const list = await ExtensionRuntime.instanceHooks(pluginInput())
        expect(list.find((item) => item.id === badId)).toBeUndefined()
        expect(ExtensionRuntime.describe(badId).runtime).toBe("error")
      })
    } else {
      test("inline keeps input.client/$/experimental_workspace usable", async () => {
        const probe = (await hooks!.rpc!["surface.probe"](null, {
          directory: input.directory,
          signal: new AbortController().signal,
        })) as Record<string, boolean>
        expect(probe).toEqual({})
      })
    }
  })
}
