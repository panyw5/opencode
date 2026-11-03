#!/usr/bin/env bun
import path from "node:path"
import { constants } from "node:fs"
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { archiveLimits, extractArchive } from "../packages/opencode/src/extension/archive"
import { load } from "../packages/opencode/src/extension/manifest"
import { parseReleaseDescriptor } from "../packages/opencode/src/extension/release"

const usage = `Generate a release descriptor from a local, prebuilt extension archive.

Usage:
  bun run script/extension-release.ts --archive <local.tgz> --artifact-url <https://...> --output <release.json> [--manifest <package.json>]

Paths may be absolute or relative to the current directory. The output parent must
already exist. Existing outputs are never overwritten; --force is not supported.
This command does not fetch, upload, build, install, or execute extension code.
`

async function ordinaryParents(directory: string): Promise<void> {
  const parent = path.dirname(directory)
  if (parent !== directory) await ordinaryParents(parent)
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Path has a non-directory or symbolic-link parent")
}

/** Read one bounded snapshot; never follow links or open a FIFO/device as an input. */
async function readOrdinary(file: string, limit: number, label: string) {
  await ordinaryParents(path.dirname(file))
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`${label} must be a regular file, not a symbolic link`)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      throw new Error(`${label} changed while being opened`)
    if (stat.size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`)
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size))
      const { bytesRead } = await handle.read(chunk)
      if (!bytesRead) break
      size += bytesRead
      if (size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error(`${label} changed while being read`)
    return Buffer.concat(chunks, size)
  } finally {
    await handle.close()
  }
}

function artifactURL(value: string) {
  // Reject values URL() would silently trim/repair; do not print possibly sensitive input.
  if (!/^https:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/u.test(value) || value.includes("#"))
    throw new Error(
      "Artifact URL must be an absolute HTTPS URL without credentials, whitespace, backslashes or fragments",
    )
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Artifact URL must be an absolute HTTPS URL")
  }
  if (!url.hostname || url.username || url.password || /^https:\/\/[^/?#]*@/i.test(value))
    throw new Error("Artifact URL must not contain credentials")
  // Keep the original spelling for the shared parser (e.g. obfuscated IP rejection).
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function checkManifest(file: string, actual: { id: string; version: string; name: string }) {
  const bytes = await readOrdinary(file, 1024 * 1024, "Manifest")
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (!record(value) || !record(value.opencode))
    throw new Error("--manifest must be a package.json with an opencode manifest")
  if (value.name !== actual.name || value.version !== actual.version || value.opencode.id !== actual.id)
    throw new Error("Supplied manifest name, version and opencode.id must match the actual archive")
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      archive: { type: "string" },
      "artifact-url": { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    process.stdout.write(usage)
    return
  }
  if (!values.archive || !values["artifact-url"] || !values.output)
    throw new Error("Required arguments: --archive, --artifact-url and --output (see --help)")
  const archive = path.resolve(values.archive)
  if (!archive.toLowerCase().endsWith(".tgz"))
    throw new Error("Archive must be a local .tgz file; ZIP is not supported")
  const url = artifactURL(values["artifact-url"])
  const bytes = await readOrdinary(archive, archiveLimits.compressedBytes, "Archive")
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8)
    throw new Error("Archive must contain a gzip-compressed .tgz; ZIP is not supported")

  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "opencode-extension-release-"))
  try {
    const directory = path.join(temporary, "package")
    await extractArchive({ input: bytes, directory, policy: "archive" })
    // load reads JSON and entry bytes for validation/fingerprints; it does not import entries.
    const manifest = await load(directory)
    if (values.manifest) await checkManifest(path.resolve(values.manifest), manifest)
    const descriptor = parseReleaseDescriptor({
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      artifact: { url, sha256: createHash("sha256").update(bytes).digest("hex") },
    })
    const output = path.resolve(values.output)
    await ordinaryParents(path.dirname(output))
    // Exclusive creation is the final gate, including for dangling links and directories.
    const file = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8")
    } finally {
      await file.close()
    }
    process.stdout.write(`Created release descriptor: ${output}\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`extension-release: ${error instanceof Error ? error.message : "Generation failed"}\n`)
  process.exitCode = 1
})
