import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { gzipSync } from "node:zlib"
import tar from "tar-stream"

const repository = path.resolve(import.meta.dir, "../../../..")
const script = path.join(repository, "script/extension-release.ts")
const root = await mkdtemp(path.join(await realpath(tmpdir()), "oc-release-author-test-"))
afterAll(() => rm(root, { recursive: true, force: true }))
let serial = 0

const packageJSON = {
  name: "release-author-fixture",
  version: "1.2.3",
  exports: { "./web": "./dist/web.js", "./server": "./dist/server.js" },
  opencode: {
    manifestVersion: 1,
    id: "test.release-author",
    displayName: "Release author fixture",
    web: { apiVersion: 1 },
  },
}

type Entry = Partial<tar.Headers> & { name: string; body?: string | Buffer }
async function tgz(entries: Entry[]) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collected = (async () => {
    for await (const chunk of pack) chunks.push(chunk)
  })()
  for (const { body = "", ...header } of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(header, body, (error) => (error ? reject(error) : resolve()))
    })
  }
  pack.finalize()
  await collected
  return gzipSync(Buffer.concat(chunks))
}

async function fixture(extra: Entry[] = [], json: Record<string, unknown> = packageJSON) {
  const directory = path.join(root, `case-${serial++}`)
  await mkdir(directory)
  const marker = path.join(directory, "extension-executed")
  const entry = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); throw new Error("must not execute");`
  const bytes = await tgz([
    {
      name: "package/package.json",
      body: JSON.stringify({
        ...json,
        scripts: {
          preinstall: `${process.execPath} -e ${JSON.stringify(entry)}`,
          install: `${process.execPath} -e ${JSON.stringify(entry)}`,
          postinstall: `${process.execPath} -e ${JSON.stringify(entry)}`,
          build: `${process.execPath} -e ${JSON.stringify(entry)}`,
        },
      }),
    },
    { name: "package/dist/web.js", body: entry },
    { name: "package/dist/server.js", body: entry },
    ...extra,
  ])
  const archive = path.join(directory, "extension.tgz")
  const output = path.join(directory, "stable.json")
  await writeFile(archive, bytes)
  return { directory, archive, output, marker, bytes }
}

async function cli(args: string[], cwd = repository) {
  // No shell, package manager, network, build, or extension entry execution.
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function args(input: { archive: string; output: string }, url = "https://artifacts.example.invalid/viewer/v1.2.3.tgz") {
  return ["--archive", input.archive, "--artifact-url", url, "--output", input.output]
}

async function absent(file: string) {
  expect(await lstat(file).catch(() => undefined)).toBeUndefined()
}

describe("local extension release authoring CLI", () => {
  test("hashes final tgz bytes, validates real package, writes v1 JSON and never runs entries or scripts", async () => {
    const input = await fixture()
    const result = await cli(args(input))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(await readFile(input.output, "utf8"))).toEqual({
      schemaVersion: 1,
      id: packageJSON.opencode.id,
      version: packageJSON.version,
      artifact: {
        url: "https://artifacts.example.invalid/viewer/v1.2.3.tgz",
        sha256: createHash("sha256")
          .update(await readFile(input.archive))
          .digest("hex"),
      },
    })
    expect(await readFile(input.archive)).toEqual(input.bytes)
    await absent(input.marker)
  }, 30_000)

  test("supports relative local paths and a matching optional package manifest", async () => {
    const input = await fixture()
    await writeFile(path.join(input.directory, "package.json"), JSON.stringify(packageJSON))
    const result = await cli(
      [
        "--archive",
        "extension.tgz",
        "--artifact-url",
        "https://artifacts.example.invalid/v1.2.3.tgz?download=1",
        "--output",
        "stable.json",
        "--manifest",
        "package.json",
      ],
      input.directory,
    )
    expect(result.code).toBe(0)
    const descriptor = JSON.parse(await readFile(input.output, "utf8"))
    expect(descriptor.artifact.url).toBe("https://artifacts.example.invalid/v1.2.3.tgz?download=1")
    await absent(input.marker)
  }, 30_000)

  test.each(["id", "version", "name"] as const)(
    "rejects a supplied manifest with a forged %s",
    async (field) => {
      const input = await fixture()
      const json = structuredClone(packageJSON)
      if (field === "id") json.opencode.id = "test.forged"
      if (field === "version") json.version = "9.9.9"
      if (field === "name") json.name = "forged-package"
      const manifest = path.join(input.directory, "claimed-package.json")
      await writeFile(manifest, JSON.stringify(json))
      const result = await cli([...args(input), "--manifest", manifest])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("must match the actual archive")
      await absent(input.output)
      await absent(input.marker)
    },
    30_000,
  )

  test.each([
    "http://artifacts.example.invalid/file.tgz",
    "/relative.tgz",
    "file:///tmp/file.tgz",
    "https://user:secret@artifacts.example.invalid/file.tgz",
    "https://@artifacts.example.invalid/file.tgz",
    "https://artifacts.example.invalid/file.tgz#fragment",
    " https://artifacts.example.invalid/file.tgz",
    "https://artifacts.example.invalid/a b.tgz",
    "https://artifacts.example.invalid\\file.tgz",
    "https://artifacts.example.invalid/\nfile.tgz",
    "https://0x08080808/file.tgz",
  ])(
    "rejects an unsafe artifact URL without writing output: %s",
    async (url) => {
      const input = await fixture()
      const result = await cli(args(input, url))
      expect(result.code).not.toBe(0)
      expect(result.stderr).not.toContain("user:secret")
      await absent(input.output)
      await absent(input.marker)
    },
    30_000,
  )

  test("never overwrites an existing output; --force is explicitly unsupported", async () => {
    const input = await fixture()
    await writeFile(input.output, "preserve this release\n")
    for (const extra of [[], ["--force"]]) {
      const result = await cli([...args(input), ...extra])
      expect(result.code).not.toBe(0)
      expect(await readFile(input.output, "utf8")).toBe("preserve this release\n")
    }
    await absent(input.marker)
  }, 30_000)

  test.each(["target", "dangling", "directory"] as const)(
    "rejects %s output without changing existing content",
    async (kind) => {
      const input = await fixture()
      const target = path.join(input.directory, "target.json")
      if (kind === "directory") await mkdir(input.output)
      else {
        if (kind === "target") await writeFile(target, "original")
        await symlink(target, input.output)
      }
      const result = await cli(args(input))
      expect(result.code).not.toBe(0)
      if (kind === "target") expect(await readFile(target, "utf8")).toBe("original")
      if (kind === "dangling") await absent(target)
      if (kind === "directory") expect((await lstat(input.output)).isDirectory()).toBe(true)
      else expect((await lstat(input.output)).isSymbolicLink()).toBe(true)
    },
    30_000,
  )

  test("rejects symbolic links in archive, manifest and output-parent paths", async () => {
    const input = await fixture()
    const linkedArchive = path.join(input.directory, "linked.tgz")
    await symlink(input.archive, linkedArchive)
    expect((await cli(args({ ...input, archive: linkedArchive }))).code).not.toBe(0)
    const manifest = path.join(input.directory, "package.json")
    const linkedManifest = path.join(input.directory, "linked.json")
    await writeFile(manifest, JSON.stringify(packageJSON))
    await symlink(manifest, linkedManifest)
    expect((await cli([...args(input), "--manifest", linkedManifest])).code).not.toBe(0)
    const linkedDirectory = path.join(input.directory, "linked-dir")
    await symlink(input.directory, linkedDirectory)
    expect((await cli(args({ ...input, output: path.join(linkedDirectory, "stable.json") }))).code).not.toBe(0)
    expect((await cli(args({ ...input, archive: path.join(linkedDirectory, "extension.tgz") }))).code).not.toBe(0)
    await absent(input.output)
  }, 30_000)

  test.each(["file.zip", "disguised.tgz"])(
    "rejects ZIP bytes, including disguised .tgz: %s",
    async (name) => {
      const input = await fixture()
      const archive = path.join(input.directory, name)
      await writeFile(archive, Buffer.from("PK\x03\x04not a gzip tar"))
      const result = await cli(args({ ...input, archive }))
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("ZIP is not supported")
      await absent(input.output)
    },
    30_000,
  )

  test.each([
    { name: "package/../../escape", body: "bad" },
    { name: "package/link", type: "symlink", linkname: "../../escape" },
    { name: "package/hardlink", type: "link", linkname: "package/package.json" },
    { name: "package/node_modules/dependency/index.js", body: "bad" },
  ] satisfies Entry[])(
    "rejects unsafe archive entry $name",
    async (entry) => {
      const input = await fixture([entry])
      const result = await cli(args(input))
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("Invalid extension archive")
      await absent(input.output)
      await absent(input.marker)
    },
    30_000,
  )

  test("validates the archive manifest even without --manifest", async () => {
    const input = await fixture([], { ...packageJSON, opencode: { ...packageJSON.opencode, id: "Invalid" } })
    expect((await cli(args(input))).code).not.toBe(0)
    await absent(input.output)
    await absent(input.marker)
  }, 30_000)
})
