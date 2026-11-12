import path from "node:path"
import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import ignore from "ignore"
import { Schema } from "effect"
import { Log } from "@opencode-ai/core/util/log"
import { readPluginPackage, type PluginPackage } from "@/plugin/shared"
import { extractArchive, packPathParts } from "./archive"
import { load, type Loaded } from "./manifest"
import { ExtensionID } from "./schema"

const log = Log.create({ service: "extension" })

// Templates shipped to authors. Files live in templates/extensions/<name> when
// running from source; release builds embed the same tree as
// opencode-extension-templates.gen.ts (see script/build.ts).
export const TEMPLATES = ["server-only", "web-and-server"] as const
export type TemplateName = (typeof TEMPLATES)[number]

// Basenames npm never packs (and extractArchive forbids anyway). They are
// skipped during the packed-file prediction instead of being flagged.
const NPM_IGNORED = new Set([
  ".git",
  ".hg",
  ".svn",
  "cvs",
  ".npmrc",
  "config.gypi",
  "node_modules",
  "npm-debug.log",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
])
const NPM_IGNORED_PATTERN = /^(?:\.ds_store|\._.*|.*\.swp|\.lock-wscript|\.wafpickle-.*)$/i

function npmIgnoredName(name: string) {
  return NPM_IGNORED.has(name.toLowerCase()) || NPM_IGNORED_PATTERN.test(name)
}

// Filenames npm includes even when package.json declares a files whitelist.
const ALWAYS_INCLUDED = /^(?:package\.json|(?:readme|licen[cs]e|notice|changes|changelog|history)(?:\.[^/]+)?)$/i

function posix(value: string) {
  return value.replaceAll("\\", "/")
}

function packPath(name: string, directory = false) {
  try {
    return packPathParts(name, directory)
  } catch (error) {
    throw new Error(`Packed path ${name} is invalid for an extension archive: ${(error as Error).message}`)
  }
}

function fileRoots(pkg: PluginPackage) {
  const raw = pkg.json.files
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string"))
    throw new Error('package.json "files" must be an array of path strings')
  return (raw as string[]).map((entry) => {
    const value = posix(entry.replace(/^\.?\//, "").replace(/\/+$/, ""))
    if (!value) throw new Error(`package.json "files" has an invalid entry: ${entry}`)
    packPath(value)
    return value
  })
}

function covered(rel: string, roots: string[]) {
  return roots.some((root) => rel === root || rel.startsWith(`${root}/`))
}

async function ignoreMatcher(dir: string) {
  for (const name of [".npmignore", ".gitignore"]) {
    const text = await readFile(path.join(dir, name), "utf8").catch(() => undefined)
    if (text === undefined) continue
    return ignore().add(text)
  }
  return undefined
}

function ignoredBy(matcher: ReturnType<typeof ignore> | undefined, rel: string, directory: boolean) {
  if (!matcher || !rel) return false
  if (matcher.ignores(rel)) return true
  // dir-only ignore patterns ("artifacts/") match the trailing-slash form.
  return directory && matcher.ignores(`${rel}/`)
}

async function scanPackable(dir: string, rel: string, matcher: ReturnType<typeof ignore> | undefined) {
  const collected: string[] = []
  const walk = async (absolute: string, value: string) => {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`Packed path ${value || rel} must be a regular file or directory, not a symbolic link`)
    if (ignoredBy(matcher, value, stat.isDirectory())) return
    if (stat.isDirectory()) {
      for (const entry of await readdir(absolute)) {
        if (npmIgnoredName(entry)) continue
        const next = value ? `${value}/${entry}` : entry
        await walk(path.join(absolute, entry), next)
      }
      return
    }
    packPath(value)
    const base = path.basename(value)
    if (/^\.env(?:\.|$)/i.test(base) && !/^\.env\.example$/i.test(base))
      throw new Error(`Packed path ${value} looks like a local environment file; secrets must not ship in an archive`)
    collected.push(value)
  }
  const stat = await lstat(dir)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(`Packed path ${rel || dir} must be a regular file or directory, not a symbolic link`)
  await walk(dir, rel)
  return collected
}

export type PackageValidation = {
  loaded: Loaded
  files: string[]
  warnings: string[]
}

/**
 * Validates an extension package directory with the same rules installation
 * applies (manifest.load), plus authoring-side checks: every file the npm
 * pack would ship is predicted and checked against the archive path rules,
 * and declared entry/style/icon files must be covered by a "files" whitelist.
 * No extension code is executed.
 */
export async function validatePackage(directory: string): Promise<PackageValidation> {
  const started = Date.now()
  const dir = await realpath(directory).catch(() => path.resolve(directory))
  const loaded = await load(dir)
  const pkg = await readPluginPackage(dir)
  const warnings: string[] = []
  const matcher = await ignoreMatcher(dir)
  const roots = fileRoots(pkg)

  const files: string[] = []
  if (roots) {
    for (const root of roots) {
      const absolute = path.join(dir, root)
      const stat = await lstat(absolute).catch(() => undefined)
      if (!stat) throw new Error(`package.json "files" entry does not exist: ${root}`)
      files.push(...(await scanPackable(absolute, root, matcher)))
    }
    for (const entry of await readdir(dir)) {
      if (!ALWAYS_INCLUDED.test(entry)) continue
      const stat = await lstat(path.join(dir, entry))
      if (stat.isFile()) files.push(entry)
    }
  } else {
    warnings.push(
      'package.json has no "files" whitelist; every unignored file in the directory will be packed',
    )
    files.push(...(await scanPackable(dir, "", matcher)))
  }

  // Declared runtime files must survive packing when a whitelist exists.
  if (roots) {
    const webPrefix = posix(path.relative(dir, loaded.webRoot))
    const required: string[] = []
    if (loaded.serverEntry) required.push(loaded.serverEntry)
    if (loaded.entry) required.push(webPrefix ? `${webPrefix}/${loaded.entry}` : loaded.entry)
    for (const style of loaded.styles) required.push(webPrefix ? `${webPrefix}/${style}` : style)
    if (loaded.icon) required.push(webPrefix ? `${webPrefix}/${loaded.icon}` : loaded.icon)
    for (const rel of required) {
      if (!covered(rel, roots))
        throw new Error(`Required extension file ${rel} is not covered by package.json "files" and would be missing from the archive`)
    }
  }

  warnings.push(...loaded.warnings.map((code) => `manifest warning: ${code}`))
  const result = { loaded, files: files.sort(), warnings }
  log.info("extension package validated", {
    extension: loaded.id,
    phase: "validate",
    files: files.length,
    elapsedMs: Date.now() - started,
  })
  return result
}

export type PackResult = {
  id: string
  version: string
  archive: string
  sha256: string
  files: number
}

/**
 * Validates the directory, runs `npm pack` without lifecycle scripts into a
 * private directory, verifies npm's reported identity/integrity, re-extracts
 * and re-validates the archive exactly like an install would, then copies the
 * final .tgz into the package directory. Existing archives are never
 * overwritten.
 */
export async function packPackage(directory: string): Promise<PackResult> {
  const started = Date.now()
  const dir = await realpath(directory).catch(() => path.resolve(directory))
  const validated = await validatePackage(dir)
  const loaded = validated.loaded
  const pkg = await readPluginPackage(dir)
  const filename = `${String(pkg.json.name).replace(/^@/, "").replace("/", "-")}-${loaded.version}.tgz`
  const destination = path.join(dir, filename)
  if (await lstat(destination).catch(() => undefined))
    throw new Error(`Archive already exists and will not be overwritten: ${destination}`)
  const npm = Bun.which("npm")
  if (!npm) throw new Error("npm is required to pack an extension archive")
  const snapshot = await readFile(path.join(dir, "package.json"))

  const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "opencode-extension-pack-"))
  try {
    const packDir = path.join(temporary, "pack")
    await mkdir(packDir)
    const child = Bun.spawn(["npm", "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", packDir], {
      cwd: dir,
      env: {
        ...process.env,
        npm_config_cache: path.join(temporary, "cache"),
        npm_config_logs_dir: path.join(temporary, "logs"),
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 120_000)
    let stdout: string
    let stderr: string
    let code: number
    try {
      ;[stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    } finally {
      clearTimeout(timer)
    }
    if (code !== 0)
      throw new Error(`npm pack failed: ${stderr.trim().split(/\r?\n/).at(-1) || `exit code ${code}`}`)
    if (!(await readFile(path.join(dir, "package.json"))).equals(snapshot))
      throw new Error("package.json changed during npm pack; release aborted")

    let items: unknown
    try {
      items = JSON.parse(stdout)
    } catch {
      throw new Error("npm pack did not return valid JSON")
    }
    if (!Array.isArray(items) || items.length !== 1) throw new Error("npm pack must return exactly one package")
    const item = items[0] as { name?: unknown; version?: unknown; filename?: unknown; integrity?: unknown; files?: unknown }
    if (item.name !== pkg.json.name || item.version !== loaded.version || item.filename !== filename)
      throw new Error("npm pack identity does not match the package.json metadata")
    if (typeof item.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity))
      throw new Error("npm pack must report SHA-512 integrity")
    if (!Array.isArray(item.files) || !item.files.length) throw new Error("npm pack must report the packaged files")
    for (const file of item.files as { path?: unknown }[]) {
      if (typeof file?.path !== "string") throw new Error("npm pack reported an invalid file list")
      packPath(file.path)
    }

    const bytes = await readFile(path.join(packDir, filename))
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== item.integrity)
      throw new Error("npm pack integrity does not match the archive bytes")

    // Prove the archive installs: extract with the production rules and run
    // the same manifest validation a real install applies.
    const unpacked = path.join(temporary, "package")
    await extractArchive({ input: bytes, directory: unpacked, policy: "npm" })
    const repacked = await load(unpacked)
    if (repacked.id !== loaded.id || repacked.version !== loaded.version)
      throw new Error("Packed archive identity does not match the source directory")

    await copyFile(path.join(packDir, filename), destination, constants.COPYFILE_EXCL)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    log.info("extension package packed", {
      extension: loaded.id,
      phase: "pack",
      files: item.files.length,
      sha256,
      elapsedMs: Date.now() - started,
    })
    return { id: loaded.id, version: loaded.version, archive: destination, sha256, files: item.files.length }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// templates

type TemplateFiles = ReadonlyMap<string, string>

let embeddedPromise: Promise<Record<string, Record<string, string>> | null> | undefined
function embeddedTemplates() {
  return (embeddedPromise ??=
    // @ts-expect-error - generated file at build time (script/build.ts)
    import("opencode-extension-templates.gen.ts").then((module) => module.default).catch(() => null))
}

async function templateFiles(name: TemplateName): Promise<TemplateFiles> {
  const embedded = await embeddedTemplates()
  if (embedded?.[name]) return new Map(Object.entries(embedded[name]))
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../templates/extensions", name)
  const files = new Map<string, string>()
  try {
    const walk = async (absolute: string, rel: string) => {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        const target = path.join(absolute, entry.name)
        if (entry.isDirectory()) await walk(target, next)
        else if (entry.isFile()) files.set(next, target)
      }
    }
    await walk(root, "")
  } catch {
    // The compiled binary has no repository tree; it must use the embedded map.
  }
  if (!files.has("package.json")) throw new Error(`Extension template is unavailable: ${name}`)
  return files
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeName(base: string) {
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-{2,}/g, "-")
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error("Cannot derive a package name from the directory name; pass --name")
  return name
}

function sanitizeID(base: string) {
  const segment = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-{2,}/g, "-")
  if (!segment) throw new Error("Cannot derive an extension id from the directory name; pass --id")
  try {
    return Schema.decodeUnknownSync(ExtensionID)(`example.${segment}`)
  } catch {
    throw new Error("Cannot derive a valid extension id from the directory name; pass --id")
  }
}

function titleize(base: string) {
  const words = base.split(/[-_\s]+/).filter(Boolean)
  const value = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(" ")
  return value || "Extension"
}

export type CreateResult = {
  id: string
  name: string
  displayName: string
  dir: string
  files: string[]
}

/**
 * Copies an authoring template into a new directory and substitutes the
 * template's package name, opencode.id and display name placeholders. The
 * target must not exist or be empty; existing files are never overwritten.
 */
export async function createFromTemplate(
  target: string,
  options: { template: string; id?: string; name?: string; displayName?: string },
): Promise<CreateResult> {
  const started = Date.now()
  const template = TEMPLATES.find((name) => name === options.template)
  if (!template) throw new Error(`Unknown extension template: ${options.template}`)
  const files = await templateFiles(template)
  const source = files.get("package.json")!
  const pkg: unknown = JSON.parse(await readFile(source, "utf8"))
  if (!record(pkg) || !record(pkg.opencode) || typeof pkg.opencode.id !== "string")
    throw new Error(`Extension template ${template} has an invalid package.json`)
  const placeholders = {
    name: String(pkg.name),
    id: pkg.opencode.id,
    displayName: typeof pkg.opencode.displayName === "string" ? pkg.opencode.displayName : "",
  }

  const dir = path.resolve(target)
  const base = path.basename(dir)
  const name = options.name ?? sanitizeName(base)
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new Error("--name must be a valid lowercase npm package name")
  let id: ExtensionID
  try {
    id = options.id ? Schema.decodeUnknownSync(ExtensionID)(options.id.trim()) : sanitizeID(base)
  } catch {
    throw new Error("Extension id must match ^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)+$ (at most 64 chars)")
  }
  const displayName = options.displayName ?? titleize(base)

  const existing = await lstat(dir).catch(() => undefined)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("Extension target exists and is not an ordinary directory")
    if ((await readdir(dir)).length) throw new Error(`Extension target is not empty: ${dir}`)
  } else {
    await mkdir(dir, { recursive: true })
  }

  const written: string[] = []
  for (const [rel, file] of files) {
    const parts = packPath(rel)
    const destination = path.join(dir, ...parts)
    await mkdir(path.dirname(destination), { recursive: true })
    let text = await readFile(file, "utf8")
    text = text.replaceAll(placeholders.id, id).replaceAll(placeholders.name, name)
    if (placeholders.displayName) text = text.replaceAll(placeholders.displayName, displayName)
    await writeFile(destination, text, { flag: "wx" })
    written.push(rel)
  }
  log.info("extension project created", {
    extension: id,
    phase: "create",
    template,
    files: written.length,
    elapsedMs: Date.now() - started,
  })
  return { id, name, displayName, dir, files: written.sort() }
}

export * as ExtensionReleaseAuthor from "./release-author"
