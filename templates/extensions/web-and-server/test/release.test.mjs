import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { promisify } from "node:util"
import { release } from "../scripts/release.mjs"

const execute = promisify(execFile)
const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url))
const url = "https://downloads.example.com/starter.tgz?token=keep-private"

async function npmEntry() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "npm")),
  ]
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const path = await realpath(candidate)
      if (path.endsWith("npm-cli.js")) return path
    } catch {}
  }
  throw new Error("Tests require a real npm installation (npm_execpath must point to npm-cli.js)")
}
const npm = await npmEntry()

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "standalone-release-test-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "src"))
  await copyFile(script, join(root, "scripts/release.mjs"))
  const pkg = {
    name: "opencode-web-extension-starter",
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { "./web": "./src/web.js", "./server": "./src/server.js" },
    files: ["src"],
    opencode: { id: "example.web-extension-starter", web: { apiVersion: 1 } },
    scripts: {
      release: "node scripts/release.mjs",
      pack: "node scripts/release.mjs --pack-only",
      prepare: "node -e \"require('node:fs').writeFileSync('UNSAFE-LIFECYCLE', 'ran')\"",
    },
    ...overrides,
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(
    join(root, "src/server.js"),
    "export default { activate() { return { rpc: { ping() { return 'ok' } } } } }\n",
  )
  await writeFile(
    join(root, "src/web.js"),
    "export default { id: 'example.web-extension-starter', apiVersion: 1, activate() {} }\n",
  )
  await writeFile(join(root, ".env"), "SECRET=not-in-archive\n")
  return root
}

async function cli(root, args, throughNpm = false) {
  try {
    const result = await execute(
      process.execPath,
      throughNpm ? [npm, "run", ...args] : [join(root, "scripts/release.mjs"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          npm_execpath: npm,
          npm_config_cache: join(root, "test-npm-cache"),
          npm_config_logs_dir: join(root, "test-npm-logs"),
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    )
    return { ...result, code: 0 }
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code }
  }
}

async function missing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" })
}

test("real npm run release produces an exclusive archive and digest from an unchanged package snapshot", async (t) => {
  const root = await fixture(t, {
    name: "@authors/renamed",
    version: "2.3.4-beta.1+build.2",
    opencode: { id: "author.renamed", web: { apiVersion: 1 } },
    author: "New Author",
  })
  const before = await readFile(join(root, "package.json"))
  const result = await cli(root, ["release", "--", "--artifact-url", url, "--output", "artifacts/stable.json"], true)
  assert.equal(result.code, 0, result.stderr)
  const returned = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.equal(returned.archive, join(root, "artifacts/authors-renamed-2.3.4-beta.1+build.2.tgz"))
  const archive = await readFile(returned.archive)
  const descriptor = JSON.parse(await readFile(returned.output, "utf8"))
  assert.deepEqual(descriptor, {
    schemaVersion: 1,
    id: "author.renamed",
    version: "2.3.4-beta.1+build.2",
    artifact: { url, sha256: createHash("sha256").update(archive).digest("hex") },
  })
  assert.deepEqual(returned.descriptor, descriptor)
  assert.deepEqual(await readFile(join(root, "package.json")), before)
  await missing(join(root, "UNSAFE-LIFECYCLE"))
  assert.deepEqual((await readdir(join(root, "artifacts"))).sort(), [
    "authors-renamed-2.3.4-beta.1+build.2.tgz",
    "stable.json",
  ])
})

test("URL and argument failures happen before npm pack and never disclose query values", async (t) => {
  const root = await fixture(t)
  const invalid = [
    "http://example.com/a",
    "https://@example.com/a",
    "https://user:pass@example.com/a",
    "https://example.com/a#",
    "https://example.com/a#fragment",
    "https://example.com/a b",
    "https://example.com/\\x",
    "https://example.com/a\n",
    "https:example.com/a",
    "https://0x7f000001/a",
    "https://2130706433/a",
    "https://127.1/a",
    "https://%65xample.com/a",
  ]
  for (const value of invalid) {
    const result = await cli(root, [
      "--artifact-url",
      `${value}?token=keep-private`,
      "--output",
      "artifacts/stable.json",
    ])
    assert.notEqual(result.code, 0, value)
    assert.doesNotMatch(result.stderr, /keep-private|token=/)
  }
  for (const args of [
    ["--unknown", url],
    ["--artifact-url", url],
    ["--output", "artifacts/x.json"],
    ["--pack-only", "--artifact-url", url],
    ["--artifact-url", url, "--artifact-url", url, "--output", "artifacts/x.json"],
  ]) {
    const result = await cli(root, args)
    assert.notEqual(result.code, 0)
    assert.doesNotMatch(result.stderr, /keep-private|token=/)
  }
  await missing(join(root, "artifacts"))
})

test("existing descriptors and tgz files, including dangling symlinks, are never overwritten", async (t) => {
  for (const target of ["stable.json", "opencode-web-extension-starter-0.1.0.tgz"]) {
    for (const link of [false, true]) {
      const root = await fixture(t)
      await mkdir(join(root, "artifacts"))
      const path = join(root, "artifacts", target)
      if (link) await symlink(join(root, "absent-target"), path)
      else await writeFile(path, "keep")
      await assert.rejects(
        release({ root, npmExecPath: npm, artifactUrl: url, output: "artifacts/stable.json" }),
        /already exists/,
      )
      assert.equal((await lstat(path)).isSymbolicLink(), link)
      if (!link) assert.equal(await readFile(path, "utf8"), "keep")
      assert.deepEqual(await readdir(join(root, "artifacts")), [target])
    }
  }
  const root = await fixture(t)
  await assert.rejects(release({ root, npmExecPath: npm, artifactUrl: url, output: "missing/stable.json" }))
  assert.deepEqual(await readdir(join(root, "artifacts")), [])
})

test("npm run pack needs no URL or descriptor, ignores lifecycle scripts, and refuses repeat packs", async (t) => {
  const root = await fixture(t)
  const result = await cli(root, ["pack"], true)
  assert.equal(result.code, 0, result.stderr)
  const returned = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.equal(returned.output, null)
  assert.equal(returned.descriptor, null)
  assert.ok((await readFile(returned.archive)).length > 0)
  await missing(join(root, "UNSAFE-LIFECYCLE"))
  const before = await readFile(returned.archive)
  assert.notEqual((await cli(root, ["pack"], true)).code, 0)
  assert.deepEqual(await readFile(returned.archive), before)
})

test("rejects noncanonical versions, dependencies, and wrong exports before packing", async (t) => {
  for (const override of [
    { version: "v1.0.0" },
    { version: "1.0.0-01" },
    { version: "01.0.0" },
    { dependencies: { example: "*" } },
    { workspaces: [] },
    { exports: { "./web": "./src/web.js", "./server": "./src/other.js" } },
    { exports: { "./web": "./src/other.js", "./server": "./src/server.js" } },
    { opencode: { id: "INVALID", web: { apiVersion: 1 } } },
    { opencode: { id: "author.web", web: { apiVersion: 2 } } },
  ]) {
    const root = await fixture(t, override)
    await assert.rejects(release({ root, npmExecPath: npm, packOnly: true }))
    await missing(join(root, "artifacts"))
  }
})

test("package.json byte changes during pack abort before publishing local outputs", async (t) => {
  const root = await fixture(t)
  const entry = join(root, "mutating-npm.mjs")
  // Only this failure-path test substitutes npm: the real success paths above execute npm-cli.js.
  await writeFile(
    entry,
    "import { appendFileSync } from 'node:fs'; appendFileSync('package.json', '\\n'); console.log('[]')\n",
  )
  await assert.rejects(
    release({ root, npmExecPath: entry, artifactUrl: url, output: "artifacts/stable.json" }),
    /package.json changed/,
  )
  assert.deepEqual(await readdir(join(root, "artifacts")), [])
})
