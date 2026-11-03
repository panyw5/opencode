import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { extractArchive } from "../../src/extension/archive"
import { load } from "../../src/extension/manifest"

const repository = path.resolve(import.meta.dir, "../../../..")
const template = path.join(repository, "templates/extensions/server-only")
const author = path.join(repository, "script/extension-release.ts")
const root = await mkdtemp(path.join(await realpath(tmpdir()), "oc-standalone-template-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// Bun is the host test runner, not the Node runtime required by the copied template.
const nodePath = Bun.which("node")
const npmPath = Bun.which("npm")
if (!nodePath || !npmPath) throw new Error("Standalone template tests require real node and npm executables")
const node = await realpath(nodePath)
const npm = await realpath(npmPath)
const env = {
  ...process.env,
  PATH: [path.dirname(node), process.env.PATH].filter(Boolean).join(path.delimiter),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  npm_execpath: npm,
  npm_node_execpath: node,
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_offline: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
}

async function run(command: string[], cwd: string, environment: NodeJS.ProcessEnv = env) {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Command failed (${code}): ${command.join(" ")}\n${stdout}\n${stderr}`)
  return { stdout, stderr }
}

async function copy() {
  const directory = await mkdtemp(path.join(root, "project-"))
  expect(await realpath(directory)).toBe(directory)
  const relative = path.relative(repository, directory)
  expect(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true)
  await cp(template, directory, { recursive: true })
  expect(await lstat(path.join(directory, "node_modules")).catch(() => undefined)).toBeUndefined()
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
  ])
    expect(pkg[field]).toBeUndefined()
  return { directory, pkg }
}

function result(stdout: string) {
  // npm run prints its own banner before the release script's final JSON line.
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(path.join(directory, entry.name), path.posix.join(prefix, entry.name))
          : path.posix.join(prefix, entry.name),
      ),
    )
  )
    .flat()
    .sort()
}

async function inspect(archive: string, expected: { name: string; version: string; opencode: { id: string } }) {
  const bytes = await readFile(archive)
  const directory = path.join(await mkdtemp(path.join(root, "unpack-")), "package")
  await extractArchive({ input: bytes, directory, policy: "npm" })
  // Only runtime files and npm's standard package metadata/documentation may ship.
  expect(await files(directory)).toEqual(["README.md", "package.json", "src/server.js"])
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
  expect(pkg.name).toBe(expected.name)
  expect(pkg.version).toBe(expected.version)
  expect(pkg.opencode.id).toBe(expected.opencode.id)
  const loaded = await load(directory)
  expect(loaded).toMatchObject({
    name: expected.name,
    version: expected.version,
    id: expected.opencode.id,
    serverEntry: "src/server.js",
  })
  expect(loaded.entry).toBeUndefined()
  const execution = await run(
    [
      node,
      "--input-type=module",
      "--eval",
      'import extension from "./src/server.js"; process.stdout.write(JSON.stringify({ id: extension.id }))',
    ],
    directory,
  )
  expect(JSON.parse(execution.stdout)).toEqual({ id: expected.opencode.id })
  return bytes
}

describe("standalone server-only extension template", () => {
  test("runs npm test outside the repository with real Node and no installed dependencies", async () => {
    const input = await copy()
    expect(input.pkg).toMatchObject({
      name: "opencode-extension-starter",
      version: "0.1.0",
      type: "module",
      exports: { "./server": "./src/server.js" },
      files: ["src"],
      scripts: {
        test: "node --test",
        pack: "node scripts/release.mjs --pack-only",
        release: "node scripts/release.mjs",
      },
    })
    const runtime = await run(
      [node, "--eval", "process.stdout.write(JSON.stringify({name:process.release.name,bun:!!process.versions.bun}))"],
      input.directory,
    )
    expect(JSON.parse(runtime.stdout)).toEqual({ name: "node", bun: false })
    const tested = await run([node, npm, "test"], input.directory)
    // Accept both TAP and Node's spec reporter, and npm's surrounding output.
    expect(tested.stdout).toMatch(/\btests\s+[1-9]\d*\b/)
    expect(await lstat(path.join(input.directory, "node_modules")).catch(() => undefined)).toBeUndefined()
  }, 120_000)

  test("releases a real npm tgz whose descriptor agrees with the host authoring CLI", async () => {
    const input = await copy()
    await writeFile(path.join(input.directory, ".env"), "PRIVATE_TEMPLATE_TEST_TOKEN=must-not-ship\n")
    const url = "https://artifacts.example.test/starter/v0.1.0.tgz"
    const released = result(
      (
        await run(
          [node, npm, "run", "release", "--", "--artifact-url", url, "--output", "artifacts/stable.json"],
          input.directory,
        )
      ).stdout,
    )
    expect(released.archive).toBe(path.join(input.directory, "artifacts/opencode-extension-starter-0.1.0.tgz"))
    expect(released.output).toBe(path.join(input.directory, "artifacts/stable.json"))
    const bytes = await inspect(released.archive, input.pkg)
    const descriptor = JSON.parse(await readFile(released.output, "utf8"))
    expect(descriptor).toEqual({
      schemaVersion: 1,
      id: input.pkg.opencode.id,
      version: input.pkg.version,
      artifact: { url, sha256: createHash("sha256").update(bytes).digest("hex") },
    })
    expect(released.descriptor).toEqual(descriptor)

    const output = path.join(input.directory, "artifacts/host-stable.json")
    // Deliberately omit --manifest: the host must discover identity in the same real tgz.
    await run(
      [process.execPath, author, "--archive", released.archive, "--artifact-url", url, "--output", output],
      input.directory,
      { ...env, BUN_BE_BUN: "1" },
    )
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(descriptor)
    expect(await readFile(released.archive)).toEqual(bytes)
    expect(await lstat(path.join(input.directory, "node_modules")).catch(() => undefined)).toBeUndefined()
  }, 60_000)

  test("packs renamed and versioned metadata and keeps the exported server ID in sync", async () => {
    const input = await copy()
    const pkg = {
      ...input.pkg,
      name: "@standalone-fixture/renamed-server",
      version: "2.3.4",
      opencode: { ...input.pkg.opencode, id: "test.renamed-server" },
    }
    await writeFile(path.join(input.directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
    const packed = result((await run([node, npm, "run", "pack"], input.directory)).stdout)
    expect(packed.archive).toBe(path.join(input.directory, "artifacts/standalone-fixture-renamed-server-2.3.4.tgz"))
    expect(packed.output).toBeNull()
    expect(packed.descriptor).toBeNull()
    await inspect(packed.archive, pkg)
    expect((await readdir(path.join(input.directory, "artifacts"))).sort()).toEqual([
      "standalone-fixture-renamed-server-2.3.4.tgz",
    ])
    expect(await lstat(path.join(input.directory, "node_modules")).catch(() => undefined)).toBeUndefined()
  }, 60_000)
})
