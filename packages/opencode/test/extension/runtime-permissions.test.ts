import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { ExtensionRuntime } from "../../src/extension/runtime"

/**
 * Coarse permission enforcement (T5.6, process-isolation-design.md §6):
 * the process backend gates `tools` at instance.start descriptor intake and
 * `process:spawn` at host.call admission — both host-side, so a worker
 * cannot bypass either. The inline backend keeps declaration-only
 * semantics (D3) and is pinned unchanged here.
 */

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-perm-"))
const registry = path.join(root, "registry.json")

// `bun test` cannot re-exec the test file as the extension-host entrypoint.
process.env.OPENCODE_EXTENSION_HOST_ARGV = JSON.stringify([
  process.execPath,
  path.join(import.meta.dir, "../../src/index.ts"),
  "extension-host",
])

const SERVER = `
export default {
  id: "__ID__",
  async activate(host) {
    return {
      rpc: {
        echo: async (input) => ({ echo: input?.message ?? null }),
        "spawn.try": async () => {
          let child
          try {
            child = host.spawn(process.execPath, ["-e", "process.stdout.write('spawn-ok')"], {
              stdio: ["ignore", "pipe", "ignore"],
            })
          } catch (error) {
            return { error: String(error?.message ?? error) }
          }
          return await new Promise((resolve) => {
            let buf = ""
            child.onError((error) => resolve({ error: error.message }))
            child.stdout?.on("data", (chunk) => { buf += chunk.toString() })
            child.onExit((code) => resolve({ code, out: buf }))
          })
        },
      },
    }
  },
  async server(input) {
    return {
      rpc: {
        whoami: () => ({ directory: input.directory }),
      },
      tool: {
        probe: {
          description: "probe tool",
          args: {},
          execute: async () => ({ title: "probe", output: "probed" }),
        },
      },
    }
  },
}
`

const directory = path.join(root, "instance")

function pluginInput(): PluginInput {
  return {
    client: {},
    project: { id: "perm-project" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: Object.assign(() => {}, { env: {} }),
  } as unknown as PluginInput
}

function toolCtx(): ToolContext {
  return {
    sessionID: "ses_perm",
    messageID: "msg_perm",
    agent: "perm-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as ToolContext
}

async function writePackage(id: string, input: { isolation?: "inline" | "process"; permissions?: string[] }) {
  const dir = path.join(root, id.replaceAll(".", "-"))
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
          displayName: "Permission Fixture",
          ...(input.permissions ? { permissions: input.permissions } : {}),
          ...(input.isolation ? { server: { isolation: input.isolation } } : {}),
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

const rpc = (id: string, method: string, input: Record<string, unknown> = {}) =>
  ExtensionRuntime.rpc({ id, method, input }) as Promise<Record<string, unknown>>

async function hooksOf(id: string) {
  const list = await ExtensionRuntime.instanceHooks(pluginInput())
  return list.find((item) => item.id === id)?.hooks
}

describe("extension permission enforcement", () => {
  beforeEach(async () => {
    await ExtensionRuntime.testing.reset()
    process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
    await rm(registry, { force: true })
  })

  test("process backend drops tools when the manifest lacks the tools permission", async () => {
    const id = "test.perm-notools"
    await link(id, await writePackage(id, { isolation: "process", permissions: ["process:spawn"] }))
    const hooks = await hooksOf(id)
    expect(hooks).toBeDefined()
    // The instance itself is healthy: rpc hooks registered, no error state.
    expect(Object.keys(hooks!.tool ?? {})).toEqual([])
    expect(typeof hooks!.rpc!.whoami).toBe("function")
    expect(ExtensionRuntime.describe(id).runtime).toBe("ready")
  }, 30_000)

  test("process backend denies host.spawn when the manifest lacks process:spawn", async () => {
    const id = "test.perm-nospawn"
    await link(id, await writePackage(id, { isolation: "process", permissions: ["tools"] }))
    const outcome = (await rpc(id, "spawn.try")) as { error?: string; code?: number }
    expect(outcome.error).toBeDefined()
    expect(outcome.error).toContain("denied")
    expect(outcome.error).toContain("process:spawn")
    // A denied spawn is not a crash: the same worker still answers requests.
    expect(await rpc(id, "echo", { message: "still-alive" })).toMatchObject({ echo: "still-alive" })
    // The tools permission alone still registers the tool hook.
    const hooks = await hooksOf(id)
    expect(Object.keys(hooks!.tool ?? {})).toEqual(["probe"])
  }, 30_000)

  test("process backend registers tools and spawn when both permissions are declared", async () => {
    const id = "test.perm-granted"
    await link(id, await writePackage(id, { isolation: "process", permissions: ["tools", "process:spawn"] }))
    const hooks = await hooksOf(id)
    const result = (await hooks!.tool!.probe.execute({}, toolCtx())) as { output: string }
    expect(result.output).toBe("probed")
    expect(await rpc(id, "spawn.try")).toEqual({ code: 0, out: "spawn-ok" })
  }, 30_000)

  test("inline backend keeps declaration-only semantics for both permissions", async () => {
    const id = "test.perm-inline"
    await link(id, await writePackage(id, { isolation: "inline" }))
    const hooks = await hooksOf(id)
    const result = (await hooks!.tool!.probe.execute({}, toolCtx())) as { output: string }
    expect(result.output).toBe("probed")
    expect(await rpc(id, "spawn.try")).toEqual({ code: 0, out: "spawn-ok" })
  }, 30_000)
})

afterAll(async () => {
  await ExtensionRuntime.testing.reset()
  delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  await rm(root, { recursive: true, force: true })
})
