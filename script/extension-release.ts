#!/usr/bin/env bun
import path from "node:path"
import { constants } from "node:fs"
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import semver from "semver"
import { archiveLimits, extractArchive } from "../packages/opencode/src/extension/archive"
import { load } from "../packages/opencode/src/extension/manifest"
import { parseReleaseDescriptor } from "../packages/opencode/src/extension/release"
import { signDescriptor } from "../packages/opencode/src/extension/trust"
import { readPluginPackage } from "../packages/opencode/src/plugin/shared"

const usage = `Generate a release descriptor from a local, prebuilt extension archive.

Usage:
  bun run script/extension-release.ts --archive <local.tgz> --artifact-url <https://...> --output <release.json> [--manifest <package.json>] [--sequence <n>] [--signature <release.json.sig>]

Paths may be absolute or relative to the current directory. The output parent must
already exist. Existing outputs are never overwritten; --force is not supported.
This command does not fetch, upload, build, install, or execute extension code.

--sequence writes the monotonically increasing publisher counter into the
descriptor. --signature signs the exact emitted descriptor bytes with the Ed25519
key in OPENCODE_EXTENSION_SIGNING_KEY (PKCS8 PEM or base64 DER; never logged) and
writes the detached JSON signature envelope to the given path.
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

/**
 * Mirror the package's engines.opencode declaration into the descriptor. An
 * absent declaration produces no engines field: consumers treat a missing
 * range as unrestricted but may mark the release as undeclared. A declared but
 * invalid range is an authoring error, so generation fails instead of
 * publishing a meaningless constraint.
 */
function declaredEngines(json: Record<string, unknown>) {
  const engines = json.engines
  if (engines === undefined) return undefined
  if (!record(engines)) throw new Error("package.json engines must be an object")
  const range = engines.opencode
  if (range === undefined) return undefined
  if (typeof range !== "string" || semver.validRange(range) === null)
    throw new Error("package.json engines.opencode must be a valid semver range")
  return { opencode: range }
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
      sequence: { type: "string" },
      signature: { type: "string" },
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
  const sequence =
    values.sequence === undefined
      ? undefined
      : (() => {
          const parsed = Number(values.sequence)
          if (!Number.isSafeInteger(parsed) || parsed < 0)
            throw new Error("--sequence must be a non-negative integer")
          return parsed
        })()
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
    const pkg = await readPluginPackage(directory)
    const engines = declaredEngines(pkg.json)
    const descriptor = parseReleaseDescriptor({
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      ...(engines === undefined ? {} : { engines }),
      ...(sequence === undefined ? {} : { sequence }),
      artifact: { url, sha256: createHash("sha256").update(bytes).digest("hex") },
    })
    const text = `${JSON.stringify(descriptor, null, 2)}\n`
    const output = path.resolve(values.output)
    await ordinaryParents(path.dirname(output))
    // Exclusive creation is the final gate, including for dangling links and directories.
    const file = await open(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(text, "utf8")
    } finally {
      await file.close()
    }
    process.stdout.write(`Created release descriptor: ${output}\n`)
    if (values.signature) {
      // The private key comes only from the environment and is never printed.
      const material = process.env.OPENCODE_EXTENSION_SIGNING_KEY
      if (!material) throw new Error("--signature requires OPENCODE_EXTENSION_SIGNING_KEY")
      // Sign the exact bytes just written so the detached signature matches byte for byte.
      const signed = signDescriptor(new TextEncoder().encode(text), material)
      const target = path.resolve(values.signature)
      await ordinaryParents(path.dirname(target))
      const envelope = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await envelope.writeFile(signed.document, "utf8")
      } finally {
        await envelope.close()
      }
      process.stdout.write(`Created detached signature: ${target}\n`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`extension-release: ${error instanceof Error ? error.message : "Generation failed"}\n`)
  process.exitCode = 1
})
