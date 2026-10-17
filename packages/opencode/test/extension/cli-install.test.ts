import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import tar from "tar-stream"

const root = path.resolve(import.meta.dir, "../..")
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "oc-cli-install-")))
  roots.push(directory)
  return { directory, registry: path.join(directory, "registry.json") }
}

type Context = Awaited<ReturnType<typeof setup>>
async function archive(context: Context, version = "1.0.0", permissions = ["read-files"]) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const completed = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk))
  })()
  const pkg = {
    name: "cli-extension",
    version,
    exports: { "./web": "./web.js", "./server": "./server.js" },
    opencode: { manifestVersion: 1, id: "test.cli", displayName: "CLI fixture", web: { apiVersion: 1 }, permissions },
  }
  pack.entry({ name: "package/package.json" }, JSON.stringify(pkg))
  pack.entry({ name: "package/web.js" }, "throw new Error('CLI_ENTRY_MUST_NOT_EXECUTE')")
  pack.entry({ name: "package/server.js" }, "throw new Error('CLI_ENTRY_MUST_NOT_EXECUTE')")
  pack.finalize()
  await completed
  const bytes = gzipSync(Buffer.concat(chunks))
  const file = path.join(context.directory, "fixture.tgz")
  await writeFile(file, bytes)
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") }
}

// Only replace the application-wide Effect command runner, not the installer, registry or runtime.
// All module mocks live in separate processes so importing cli.test.ts remains unaffected.
async function cli(context: Context, args: string[], flags: Record<string, string> = {}, mode = "real") {
  const script = path.join(context.directory, "runner.ts")
  await writeFile(
    script,
    `
import { mock } from "bun:test"
import { Effect, Layer } from ${JSON.stringify(import.meta.resolve("effect"))}
import yargs from ${JSON.stringify(import.meta.resolve("yargs"))}
import { RuntimeFlags } from ${JSON.stringify(path.join(root, "src/effect/runtime-flags.ts"))}
import { Extension } from ${JSON.stringify(path.join(root, "src/extension/index.ts"))}
const flags = { pure: process.env.OPENCODE_PURE === "true", disableExtensions: process.env.OPENCODE_DISABLE_EXTENSIONS === "true" }
const layer = Layer.merge(Extension.layer.pipe(Layer.provide(RuntimeFlags.layer(flags))), RuntimeFlags.layer(flags))
mock.module(${JSON.stringify(path.join(root, "src/cli/effect-cmd.ts"))}, () => ({
  fail: (message: string) => Effect.fail(new Error(message)),
  effectCmd: (options: any) => ({ ...options, handler: (args: any) => Effect.runPromise(Effect.scoped(options.handler(args).pipe(Effect.provide(layer)))) }),
}))
if (${JSON.stringify(mode)} === "format") {
  const { formatExtensionList, formatInstallPreview, formatInstallResult, extensionInstallSource } = await import(${JSON.stringify(path.join(root, "src/cli/cmd/extension.ts"))})
  const source = { type: "archive", location: "https://example.test/pkg.tgz?signature=SIGNED_SECRET#PRIVATE", sha256: "a".repeat(64) }
  const preview = { operationId: "operation", token: "CAPABILITY_SECRET", kind: "update", id: "test.cli", name: "cli-extension", oldVersion: "2.0.0", version: "1.0.0", versionChange: "downgrade", source, permissions: ["read"], permissionsAdded: [], permissionsRemoved: ["write"], enable: false }
  console.log(formatInstallPreview(preview as any))
  console.log(formatExtensionList([{ ...preview, state: "disabled" }] as any))
  console.log(formatExtensionList([{ ...preview, state: "disabled", source: { type: "npm", spec: "pkg@1.0.0", registry: "https://registry.npmjs.org/?token=REGISTRY_SECRET" } }] as any))
  console.log(formatInstallResult({ ...preview, state: "committed", committed: true, synced: false, cleanupPending: true, warnings: ["WARNING_SECRET"] } as any))
  console.log(JSON.stringify(extensionInstallSource("@scope/pkg@1.2.3")))
  process.exit(0)
}
if (${JSON.stringify(mode)} === "failed") {
  mock.module(${JSON.stringify(path.join(root, "src/extension/install-service.ts"))}, () => ({ observeInstallations: async () => async () => {}, installation: () => ({ prepare: async () => { throw Object.assign(new Error("https://example.test/pkg.tgz?token=ERROR_SECRET"), { code: "failed" }) } }) }))
}
globalThis.fetch = (() => { throw new Error("CLI_TEST_NETWORK_FORBIDDEN") }) as any
const { ExtensionCommand } = await import(${JSON.stringify(path.join(root, "src/cli/cmd/extension.ts"))})
try {
  await yargs(process.argv.slice(2)).scriptName("opencode").exitProcess(false).help(false).version(false).command(ExtensionCommand as any).demandCommand().parseAsync()
} catch (error) {
  console.error(error instanceof Error ? error.message : "CLI failed")
  process.exitCode = 1
}
`,
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")),
  )
  const child = Bun.spawn([process.execPath, script, "extension", ...args], {
    cwd: context.directory,
    env: {
      ...env,
      HOME: context.directory,
      XDG_DATA_HOME: path.join(context.directory, "data"),
      XDG_CONFIG_HOME: path.join(context.directory, "config"),
      XDG_CACHE_HOME: path.join(context.directory, "cache"),
      XDG_STATE_HOME: path.join(context.directory, "state"),
      OPENCODE_EXTENSION_REGISTRY_FILE: context.registry,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      ...flags,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, output: stdout + stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function store(context: Context) {
  return JSON.parse(await readFile(context.registry, "utf8").catch(() => '{"extensions":{}}'))
}

describe("extension installation CLI (isolated offline processes)", () => {
  test("non-TTY prints a no-exec preview and cancels without hanging or committing", async () => {
    const context = await setup()
    const pkg = await archive(context)
    const result = await cli(context, ["install", path.basename(pkg.file), "--sha256", pkg.sha256])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("no extension code has run")
    expect(result.output).toContain("ID: test.cli")
    expect(result.output).toContain("Permissions added: read-files")
    expect(result.output).toContain("disabled by default")
    expect(result.output).toContain("committed=false")
    expect(result.output).toContain("state=cancelled")
    expect(result.output).not.toContain("CLI_ENTRY_MUST_NOT_EXECUTE")
    expect((await store(context)).extensions).toEqual({})
    expect(await readdir(path.join(context.directory, "staging"))).toEqual([])
  }, 30_000)

  test("confirmed archive install/update/uninstall preserves enabled state and completes safe unused cleanup", async () => {
    const context = await setup()
    const first = await archive(context)
    let result = await cli(context, ["install", first.file, "--sha256", first.sha256, "--yes"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("committed=true")
    expect(result.output).toContain("cleanupPending=false")
    expect((await store(context)).extensions["test.cli"].enabled).toBe(false)
    const second = await archive(context, "2.0.0", ["write-files"])
    result = await cli(context, ["update", "test.cli", "--source", second.file, "--sha256", second.sha256, "--yes"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("1.0.0 -> 2.0.0")
    expect(result.output).toContain("Permissions added: write-files")
    expect(result.output).toContain("Permissions removed: read-files")
    expect((await store(context)).extensions["test.cli"].enabled).toBe(false)
    result = await cli(context, ["uninstall", "test.cli", "--purge-data", "--yes"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("purge requested")
    expect(result.output).toContain("cleanupPending=false")
    expect((await store(context)).extensions["test.cli"]).toBeUndefined()
  }, 90_000)

  test("--enable opts in explicitly; --yes still rejects hash mismatches", async () => {
    const context = await setup()
    const pkg = await archive(context)
    let result = await cli(context, ["install", pkg.file, "--sha256", "0".repeat(64), "--yes", "--enable"])
    expect(result.code).toBe(1)
    expect((await store(context)).extensions).toEqual({})
    result = await cli(context, ["install", pkg.file, "--sha256", pkg.sha256, "--yes", "--enable"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("Enable explicitly requested")
    expect((await store(context)).extensions["test.cli"].enabled).toBe(true)
  }, 60_000)

  test("validates unsupported sources and ambiguous or non-exact update options before preparing", async () => {
    const context = await setup()
    for (const args of [
      ["install", "https://example.test/pkg.tgz?token=DO_NOT_PRINT", "--yes"],
      ["install", "http://example.test/pkg.tgz", "--sha256", "a".repeat(64), "--yes"],
      ["install", "https://example.test/pkg.zip", "--yes"],
      ["install", "git+https://example.test/repo.git", "--yes"],
      ["install", "npm:some-package@1.0.0", "--yes"],
      ["update", "test.cli", "--yes"],
      ["update", "test.cli", "--version", "^1.0.0", "--yes"],
      ["update", "test.cli", "--version", "1.0.0", "--source", "/tmp/pkg.tgz", "--yes"],
      ["update", "test.cli", "--source", "package@1.0.0", "--yes"],
    ]) {
      const result = await cli(context, args)
      expect(result.code).toBe(1)
      expect(result.output).not.toContain("DO_NOT_PRINT")
      expect(result.output).not.toContain("CLI_TEST_NETWORK_FORBIDDEN")
    }
    expect((await store(context)).extensions).toEqual({})
  }, 180_000)

  test("pure and disabled flags prevent all mutation paths", async () => {
    const context = await setup()
    const pkg = await archive(context)
    for (const flag of ["OPENCODE_PURE", "OPENCODE_DISABLE_EXTENSIONS"]) {
      for (const args of [
        ["install", pkg.file, "--sha256", pkg.sha256, "--yes"],
        ["update", "test.cli", "--version", "2.0.0", "--yes"],
        ["uninstall", "test.cli", "--yes"],
        ["link", context.directory],
        ["enable", "test.cli"],
        ["disable", "test.cli"],
      ]) {
        const result = await cli(context, args, { [flag]: "true" })
        expect(result.code).toBe(1)
        expect(result.output).toContain("Extensions are disabled")
      }
    }
    expect((await store(context)).extensions).toEqual({})
  }, 240_000)

  test("formatters redact query strings/capabilities and retain truthful pending outcomes", async () => {
    const context = await setup()
    const result = await cli(context, [], {}, "format")
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("Version change: downgrade")
    expect(result.output).toContain("npm:pkg@1.0.0")
    expect(result.output).toContain('"type":"npm"')
    expect(result.output).toContain("committed=true synced=false cleanupPending=true")
    for (const secret of ["SIGNED_SECRET", "PRIVATE", "CAPABILITY_SECRET", "REGISTRY_SECRET", "WARNING_SECRET"])
      expect(result.output).not.toContain(secret)
  }, 30_000)

  test("service errors never echo raw signed URLs", async () => {
    const context = await setup()
    const result = await cli(
      context,
      ["install", "https://example.test/pkg.tgz?token=INPUT_SECRET", "--sha256", "a".repeat(64), "--yes"],
      {},
      "failed",
    )
    expect(result.code).toBe(1)
    expect(result.output).toContain("Extension installation failed")
    expect(result.output).not.toContain("INPUT_SECRET")
    expect(result.output).not.toContain("ERROR_SECRET")
  }, 30_000)
})
