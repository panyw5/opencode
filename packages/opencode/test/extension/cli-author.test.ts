import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extractArchive } from "../../src/extension/archive"
import { load } from "../../src/extension/manifest"

const root = path.resolve(import.meta.dir, "../..")
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

// Packing requires a real npm executable, same as the standalone template tests.
const npm = Bun.which("npm")
if (!npm) throw new Error("Authoring CLI tests require a real npm executable")

async function setup() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "oc-cli-author-")))
  roots.push(directory)
  return { directory, registry: path.join(directory, "registry.json") }
}

// The authoring subcommands (create/validate/pack) run no extension code and
// touch no registry, so the isolated process needs no module mocks: it only
// drives the real ExtensionCommand through yargs.
async function cli(context: { directory: string }, args: string[]) {
  const script = path.join(context.directory, "runner.ts")
  await writeFile(
    script,
    `
import { mock } from "bun:test"
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import yargs from ${JSON.stringify(import.meta.resolve("yargs"))}
globalThis.fetch = (() => { throw new Error("CLI_TEST_NETWORK_FORBIDDEN") }) as any
// Bypass the application runtimes: authoring commands yield no services and
// starting NoInstanceRuntime would keep background fibers (e.g. the models.dev
// fetch) alive past the command's completion.
mock.module(${JSON.stringify(path.join(root, "src/cli/effect-cmd.ts"))}, () => ({
  fail: (message: string) => Effect.fail(new Error(message)),
  effectCmd: (options: any) => ({ ...options, handler: (args: any) => Effect.runPromise(Effect.scoped(options.handler(args))) }),
}))
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
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr, output: stdout + stderr }
  } finally {
    clearTimeout(timer)
  }
}

// Same runner as cli-install.test.ts: the real installation service and
// registry, only the application-wide command runner is replaced.
async function installCli(context: { directory: string; registry: string }, args: string[]) {
  const script = path.join(context.directory, "install-runner.ts")
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
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr, output: stdout + stderr }
  } finally {
    clearTimeout(timer)
  }
}

// The produced tgz must satisfy the same extraction and manifest rules a real
// installation applies; this mirrors the local archive install path.
async function inspect(context: { directory: string }, archive: string, expected: { id: string; version: string }) {
  const bytes = await readFile(archive)
  const directory = path.join(await mkdtemp(path.join(context.directory, "unpack-")), "package")
  await extractArchive({ input: bytes, directory, policy: "npm" })
  const loaded = await load(directory)
  expect(loaded.id).toBe(expected.id)
  expect(loaded.version).toBe(expected.version)
  return { bytes, loaded }
}

describe("extension authoring CLI (isolated offline processes)", () => {
  test("create -> validate -> pack produces an installable server-only tgz", async () => {
    const context = await setup()
    const target = path.join(context.directory, "my-tool")
    let result = await cli(context, ["create", target, "--template", "server-only"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("example.my-tool in ")
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8"))).toMatchObject({
      name: "my-tool",
      opencode: { id: "example.my-tool", displayName: "My Tool" },
    })

    result = await cli(context, ["validate", target])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("example.my-tool@0.1.0 is valid")
    expect(result.output).toContain("server=src/server.js")
    result = await cli(context, ["validate", "--json", target])
    expect(result.code, result.output).toBe(0)
    const validation = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
    expect(validation.id).toBe("example.my-tool")
    expect(validation.server).toBe("src/server.js")
    expect(validation.files).toContain("src/server.js")

    result = await cli(context, ["pack", target])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("example.my-tool@0.1.0 packed")
    const archive = path.join(target, "my-tool-0.1.0.tgz")
    expect(result.output).toContain(`Archive: ${archive}`)
    const { bytes, loaded } = await inspect(context, archive, { id: "example.my-tool", version: "0.1.0" })
    expect(loaded.serverEntry).toBe("src/server.js")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    expect(result.output).toContain(`sha256: ${sha256}`)

    // A second pack never overwrites the published artifact.
    result = await cli(context, ["pack", target])
    expect(result.code).toBe(1)
    expect(result.output).toContain("already exists")
    expect(await readFile(archive)).toEqual(bytes)

    // The packed tgz installs through the real installation path.
    result = await installCli(context, ["install", archive, "--sha256", sha256, "--yes"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("committed=true")
    const registry = JSON.parse(await readFile(context.registry, "utf8"))
    expect(registry.extensions["example.my-tool"]).toBeDefined()
    result = await installCli(context, ["uninstall", "example.my-tool", "--yes"])
    expect(result.code, result.output).toBe(0)
  }, 120_000)

  test("create --template web-and-server validates and packs with web resources", async () => {
    const context = await setup()
    const target = path.join(context.directory, "web-ext")
    let result = await cli(context, [
      "create",
      target,
      "--template",
      "web-and-server",
      "--id",
      "acme.web-ext",
      "--name",
      "acme-web-ext",
    ])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("acme.web-ext in ")
    const pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"))
    expect(pkg.name).toBe("acme-web-ext")
    expect(pkg.opencode.id).toBe("acme.web-ext")
    // Substitution reached every file that carries the id placeholder.
    expect(await readFile(path.join(target, "src/web.js"), "utf8")).toContain('id: "acme.web-ext"')
    expect(await readFile(path.join(target, "src/web.css"), "utf8")).toContain('[data-extension="acme.web-ext"]')
    expect(pkg.opencode.displayName).toBe("Web Ext")

    result = await cli(context, ["validate", target])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("web=web.js")

    result = await cli(context, ["pack", target])
    expect(result.code, result.output).toBe(0)
    const { loaded } = await inspect(context, path.join(target, "acme-web-ext-0.1.0.tgz"), {
      id: "acme.web-ext",
      version: "0.1.0",
    })
    expect(loaded.entry).toBe("web.js")
    expect(loaded.styles).toEqual(["web.css"])
    expect(loaded.serverEntry).toBe("src/server.js")
  }, 120_000)

  test("validate rejects broken manifests and files the whitelist drops", async () => {
    const context = await setup()
    const target = path.join(context.directory, "broken-ext")
    let result = await cli(context, ["create", target, "--template", "server-only"])
    expect(result.code, result.output).toBe(0)

    const pkgPath = path.join(target, "package.json")
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
    await writeFile(pkgPath, JSON.stringify({ ...pkg, opencode: { ...pkg.opencode, id: "INVALID" } }))
    result = await cli(context, ["validate", target])
    expect(result.code).toBe(1)

    // A required entry missing from the files whitelist must be rejected.
    await writeFile(pkgPath, JSON.stringify({ ...pkg, files: ["test"] }))
    result = await cli(context, ["validate", target])
    expect(result.code).toBe(1)
    expect(result.output).toContain("files")

    // A symlink inside the packed set is rejected by the archive path rules.
    await writeFile(pkgPath, JSON.stringify(pkg))
    await symlink(path.join(target, "package.json"), path.join(target, "src/link.js"))
    result = await cli(context, ["validate", target])
    expect(result.code).toBe(1)
    expect(result.output).toContain("symbolic link")
  }, 120_000)

  test("create rejects invalid ids, unknown templates and non-empty targets", async () => {
    const context = await setup()
    let result = await cli(context, ["create", path.join(context.directory, "!!!"), "--template", "server-only"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("Cannot derive")
    result = await cli(context, [
      "create",
      path.join(context.directory, "x"),
      "--template",
      "server-only",
      "--name",
      "BAD-NAME",
    ])
    expect(result.code).toBe(1)
    expect(result.output).toContain("--name")
    result = await cli(context, [
      "create",
      path.join(context.directory, "x"),
      "--template",
      "server-only",
      "--id",
      "INVALID",
    ])
    expect(result.code).toBe(1)
    expect(result.output).toContain("extension id")
    result = await cli(context, ["create", path.join(context.directory, "x"), "--template", "bogus"])
    expect(result.code).toBe(1)
    result = await cli(context, ["create", context.directory, "--template", "server-only"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("not empty")
  }, 120_000)
})
