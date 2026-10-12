import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import semver from "semver"

// electron-builder already depends on js-yaml; resolve through it rather than adding a dependency.
// Use Node's workspace-relative resolver: Bun 1.3.9 on Windows cannot reliably
// resolve import.meta.resolve(package, fileURL) even when the package is installed.
const desktopRequire = createRequire(new URL("../packages/desktop/package.json", import.meta.url))
const require = createRequire(desktopRequire.resolve("electron-builder"))
const yaml = require("js-yaml") as { load(text: string): unknown; dump(value: unknown): string }
if (import.meta.main) console.log(`[desktop-artifacts] YAML parser ready platform=${process.platform}`)

export type Contract = {
  repo: string
  commit: string
  version: string
  platform: "macos" | "windows"
  arch: "x64" | "arm64"
  runId: string
  runAttempt: string
}
export type ArtifactFile = { basename: string; size: number; sha512: string }
export type Manifest = Contract & { schemaVersion: 1; files: ArtifactFile[] }

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "Expected object")
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: string[]) {
  check(Object.keys(value).sort().join(",") === expected.sort().join(","), "Unexpected or missing fields")
}

export function validateContract(value: Contract) {
  check(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo), "Invalid repo")
  check(/^[a-f0-9]{40}$/.test(value.commit), "Invalid commit SHA")
  check(semver.valid(value.version) === value.version, "Invalid version")
  check(value.platform === "macos" || value.platform === "windows", "Invalid platform")
  check(value.arch === "x64" || value.arch === "arm64", "Invalid arch")
  check(value.platform !== "windows" || value.arch === "x64", "Windows only supports x64")
  check(/^[1-9][0-9]*$/.test(value.runId) && /^[1-9][0-9]*$/.test(value.runAttempt), "Invalid run provenance")
}

export function filenames(contract: Contract) {
  validateContract(contract)
  const { platform, arch, version } = contract
  return platform === "macos"
    ? [
        `OpenCode_${version}_${arch === "arm64" ? "aarch64" : "x64"}.dmg`,
        `opencode-desktop-mac-${arch}.zip`,
        `latest-mac-${arch}.yml`,
      ]
    : [`OpenCode_${version}_x64-setup.exe`, "latest.yml"]
}

export function manifestName(contract: Contract) {
  return `manifest-${contract.platform}-${contract.arch}.json`
}

function safeName(value: unknown): asserts value is string {
  check(
    typeof value === "string" && /^[A-Za-z0-9_.+-]+$/.test(value) && value !== "." && value !== "..",
    "Unsafe filename or external URL",
  )
}

async function regular(directory: string, name: string) {
  safeName(name)
  const stat = await lstat(join(directory, name))
  check(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${name}`)
}

async function inspectDirectory(directory: string, allowed: string[]) {
  check((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), "Unsafe directory")
  for (const name of await readdir(directory)) {
    check(allowed.includes(name), `Unexpected file: ${name}`)
    await regular(directory, name)
  }
}

async function digest(directory: string, basename: string): Promise<ArtifactFile> {
  await regular(directory, basename)
  const hash = createHash("sha512")
  let size = 0
  for await (const bytes of createReadStream(join(directory, basename))) {
    size += bytes.length
    hash.update(bytes)
  }
  return { basename, size, sha512: hash.digest("base64") }
}

function metadata(value: unknown, contract: Contract, files: ArtifactFile[], oldDmg?: string) {
  const data = object(value)
  for (const key of Object.keys(data))
    check(
      ["version", "files", "path", "sha512", "releaseDate", "releaseName", "releaseNotes"].includes(key),
      `Unexpected metadata field: ${key}`,
    )
  check(data.version === contract.version, "Metadata version mismatch")
  check(Array.isArray(data.files) && data.files.length === files.length, "Metadata files mismatch")
  const seen = new Set<string>()
  for (const value of data.files) {
    const entry = object(value)
    keys(entry, ["url", "sha512", "size", ...(entry.blockMapSize === undefined ? [] : ["blockMapSize"])])
    if (entry.blockMapSize !== undefined) {
      check(
        typeof entry.blockMapSize === "number" && Number.isSafeInteger(entry.blockMapSize) && entry.blockMapSize > 0,
        "Invalid metadata blockMapSize",
      )
    }
    safeName(entry.url)
    check(typeof entry.sha512 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(entry.sha512), "Invalid metadata SHA-512")
    check(typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size > 0, "Invalid metadata size")
    check(!seen.has(entry.url), "Duplicate metadata entry")
    seen.add(entry.url)
    const file = files.find(
      (file) => file.basename === entry.url || (oldDmg === entry.url && file.basename.endsWith(".dmg")),
    )
    check(file, `Unexpected metadata URL: ${entry.url}`)
    // A stapled DMG changes size/hash. Only create may replace its builder metadata.
    if (oldDmg && file.basename.endsWith(".dmg")) continue
    check(entry.sha512 === file.sha512 && entry.size === file.size, `Metadata hash/size mismatch: ${entry.url}`)
  }
  const primary = files.find((file) => file.basename.endsWith(contract.platform === "macos" ? ".zip" : ".exe"))!
  check(data.path === primary.basename && data.sha512 === primary.sha512, "Metadata top-level path/hash mismatch")
  check(data.packages === undefined, "Unexpected metadata packages")
}

function makeMetadata(contract: Contract, files: ArtifactFile[]) {
  const primary = files.find(
    (file) =>
      file.basename ===
      (contract.platform === "macos"
        ? `opencode-desktop-mac-${contract.arch}.zip`
        : `OpenCode_${contract.version}_x64-setup.exe`),
  )!
  return {
    version: contract.version,
    files: files.map((file) => ({ url: file.basename, sha512: file.sha512, size: file.size })),
    path: primary.basename,
    sha512: primary.sha512,
  }
}

async function loadMetadata(directory: string, name: string) {
  await regular(directory, name)
  return yaml.load(await readFile(join(directory, name), "utf8"))
}

export async function createManifest(directory: string, contract: Contract): Promise<Manifest> {
  const names = filenames(contract)
  await inspectDirectory(directory, [...names, manifestName(contract)])
  const binaries = await Promise.all(names.slice(0, -1).map((name) => digest(directory, name)))
  const name = names.at(-1)!
  const input = await loadMetadata(directory, name)
  if (contract.platform === "macos") {
    const oldDmg = `opencode-desktop-mac-${contract.arch}.dmg`
    metadata(input, contract, binaries, oldDmg)
    await writeFile(join(directory, name), yaml.dump(makeMetadata(contract, binaries)))
  } else metadata(input, contract, binaries)
  const manifest: Manifest = {
    schemaVersion: 1,
    ...contract,
    files: await Promise.all(names.map((name) => digest(directory, name))),
  }
  await writeFile(join(directory, manifestName(contract)), JSON.stringify(manifest, null, 2) + "\n")
  return manifest
}

export async function verifyManifest(directory: string, expected: Contract): Promise<Manifest> {
  const names = filenames(expected)
  await inspectDirectory(directory, [...names, manifestName(expected)])
  await regular(directory, manifestName(expected))
  const raw = object(JSON.parse(await readFile(join(directory, manifestName(expected)), "utf8")))
  keys(raw, ["schemaVersion", "repo", "commit", "version", "platform", "arch", "runId", "runAttempt", "files"])
  check(raw.schemaVersion === 1, "Unsupported manifest schema")
  for (const [key, value] of Object.entries(expected)) check(raw[key] === value, `Manifest ${key} mismatch`)
  check(Array.isArray(raw.files) && raw.files.length === names.length, "Manifest file count mismatch")
  const seen = new Set<string>()
  for (const value of raw.files) {
    const file = object(value)
    keys(file, ["basename", "size", "sha512"])
    safeName(file.basename)
    check(names.includes(file.basename) && !seen.has(file.basename), "Unexpected or duplicate manifest file")
    seen.add(file.basename)
    const actual = await digest(directory, file.basename)
    check(actual.size === file.size && actual.sha512 === file.sha512, `Manifest hash/size mismatch: ${file.basename}`)
  }
  const manifest = raw as unknown as Manifest
  metadata(
    await loadMetadata(directory, names.at(-1)!),
    expected,
    manifest.files.filter((file) => !file.basename.endsWith(".yml")),
  )
  return manifest
}

export async function mergeMacMetadata(
  x64Directory: string,
  arm64Directory: string,
  outputDirectory: string,
  x64: Contract,
  arm64: Contract,
) {
  check(
    x64.platform === "macos" && arm64.platform === "macos" && x64.arch === "x64" && arm64.arch === "arm64",
    "Merge requires macOS x64 and arm64",
  )
  for (const key of ["repo", "commit", "version"] as const) check(x64[key] === arm64[key], `Merge ${key} mismatch`)
  const manifests = await Promise.all([verifyManifest(x64Directory, x64), verifyManifest(arm64Directory, arm64)])
  // electron-updater selects arm64 by the 'arm64' token in the ZIP name (DMG uses aarch64).
  const files = manifests.flatMap((manifest) => manifest.files.filter((file) => !file.basename.endsWith(".yml")))
  files.sort(
    (a, b) =>
      Number(b.basename.endsWith(".zip")) - Number(a.basename.endsWith(".zip")) ||
      a.basename.localeCompare(b.basename, "en"),
  )
  const output = join(outputDirectory, "latest-mac.yml")
  const outputStat = await lstat(outputDirectory)
  check(outputStat.isDirectory() && !outputStat.isSymbolicLink(), "Unsafe output directory")
  const entries = await readdir(outputDirectory)
  if (entries.includes("latest-mac.yml")) await regular(outputDirectory, "latest-mac.yml")
  await writeFile(output, yaml.dump(makeMetadata(x64, files)))
  return output
}

function argumentsMap(args: string[]) {
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!
    check(
      key.startsWith("--") && args[i + 1] && !args[i + 1]!.startsWith("--") && !values[key.slice(2)],
      `Invalid argument: ${key}`,
    )
    values[key.slice(2)] = args[i + 1]!
  }
  const allowed = [
    "platform",
    "arch",
    "directory",
    "repo",
    "commit",
    "version",
    "run-id",
    "run-attempt",
    "x64-directory",
    "arm64-directory",
    "output-directory",
    "x64-run-id",
    "arm64-run-id",
    "x64-run-attempt",
    "arm64-run-attempt",
  ]
  for (const key of Object.keys(values)) check(allowed.includes(key), `Unknown option: ${key}`)
  return values
}

export async function main(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const [mode, ...options] = args
  check(
    mode === "create" || mode === "verify" || mode === "merge",
    "Usage: desktop-artifacts.ts create|verify|merge --platform macos|windows --arch x64|arm64 --directory PATH",
  )
  const values = argumentsMap(options)
  const contract = (arch = values.arch): Contract => ({
    repo: values.repo ?? env.GITHUB_REPOSITORY ?? "",
    commit: values.commit ?? env.GITHUB_SHA ?? "",
    version: values.version ?? env.OPENCODE_VERSION ?? "",
    platform: (mode === "merge" ? "macos" : values.platform) as Contract["platform"],
    arch: arch as Contract["arch"],
    runId: values[`${arch}-run-id`] ?? values["run-id"] ?? env.GITHUB_RUN_ID ?? "",
    runAttempt: values[`${arch}-run-attempt`] ?? values["run-attempt"] ?? env.GITHUB_RUN_ATTEMPT ?? "",
  })
  const directory = (key: string) => {
    check(values[key], `Missing --${key}`)
    return resolve(values[key])
  }
  if (mode === "merge")
    return mergeMacMetadata(
      directory("x64-directory"),
      directory("arm64-directory"),
      directory("output-directory"),
      contract("x64"),
      contract("arm64"),
    )
  return (mode === "create" ? createManifest : verifyManifest)(directory("directory"), contract())
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
    console.log(`desktop-artifacts: ${process.argv[2]} succeeded`)
  } catch (error) {
    console.error(`desktop-artifacts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
