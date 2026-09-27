import path from "path"
import { lstat, realpath } from "fs/promises"
import semver from "semver"
import { Schema } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Hash } from "@/util/hash"
import { Filesystem } from "@/util/filesystem"
import { ConfigParse } from "@/config/parse"
import { checkPluginCompatibility, extractExportValue, readPluginPackage, resolvePackageFile } from "@/plugin/shared"
import { Manifest, type Contributes, type ExtensionID } from "./schema"

export class CompatibilityError extends Error {
  override readonly name = "ExtensionCompatibilityError"
}

export type Loaded = {
  id: ExtensionID
  name: string
  version: string
  displayName: string
  description?: string
  permissions: string[]
  activation: string[]
  contributes: Contributes
  dir: string
  webRoot: string
  entry: string
  styles: string[]
  icon?: string
  versionSegment: string
}

async function ordinaryFile(file: string, label: string) {
  const stat = await lstat(file).catch(() => undefined)
  if (!stat?.isFile()) throw new Error(`Extension ${label} is not a regular file: ${file}`)
  return stat
}

async function inside(root: string, file: string, label: string) {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)])
  if (!Filesystem.contains(canonicalRoot, canonicalFile)) {
    throw new Error(`Extension ${label} resolves outside web root`)
  }
  await ordinaryFile(file, label)
  return canonicalFile
}

function packageWebExport(json: Record<string, unknown>) {
  const exports = json.exports
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return
  return extractExportValue((exports as Record<string, unknown>)["./web"])
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function validateContributions(manifest: Manifest) {
  const viewers = manifest.contributes?.fileViewers ?? []
  const ids = new Set<string>()
  for (const viewer of viewers) {
    if (ids.has(viewer.id)) throw new Error(`Extension has duplicate file viewer id: ${viewer.id}`)
    ids.add(viewer.id)
    const matchers = [viewer.extensions?.length, viewer.filenames?.length, viewer.mime?.length]
    if (!matchers.some(Boolean)) throw new Error(`Extension file viewer ${viewer.id} has no matchers`)
  }
  for (const activation of manifest.activation ?? ["onStartup"]) {
    if (!activation.startsWith("onFileViewer:")) continue
    const id = activation.slice("onFileViewer:".length)
    if (!ids.has(id)) throw new Error(`Extension activation references unknown file viewer: ${id}`)
  }
}

export async function load(directory: string, options: { opencodeVersion?: string } = {}): Promise<Loaded> {
  const dir = await realpath(directory).catch(() => path.resolve(directory))
  const pkg = await readPluginPackage(dir).catch((error) => {
    throw new Error(`Extension directory is missing a readable package.json: ${dir}`, { cause: error })
  })
  if (Filesystem.resolve(pkg.dir) !== Filesystem.resolve(dir)) {
    throw new Error(`Extension path must point to a package directory: ${dir}`)
  }

  const name = typeof pkg.json.name === "string" ? pkg.json.name.trim() : ""
  if (!name) throw new Error("Extension package is missing name")
  const version = typeof pkg.json.version === "string" ? pkg.json.version.trim() : ""
  if (!semver.valid(version)) throw new Error(`Extension package has invalid version: ${version || "missing"}`)

  const raw = pkg.json.opencode
  if (!raw) throw new Error("Extension package is missing opencode manifest")
  const manifest = ConfigParse.schema(Manifest, raw, pkg.pkg)
  validateContributions(manifest)

  try {
    await checkPluginCompatibility(dir, options.opencodeVersion ?? InstallationVersion, pkg)
  } catch (error) {
    throw new CompatibilityError(error instanceof Error ? error.message.replace(/^Plugin/, "Extension") : String(error))
  }

  const exported = packageWebExport(pkg.json)
  if (!exported) throw new Error('Extension package does not expose exports["./web"]')
  const entry = resolvePackageFile(manifest.id, exported, "web", pkg)
  await ordinaryFile(entry, "web entry")
  const webRoot = path.dirname(await realpath(entry))

  const styles = await Promise.all(
    unique(manifest.web.styles ?? []).map(async (raw) => {
      const file = resolvePackageFile(manifest.id, raw, "web style", pkg)
      return inside(webRoot, file, "web style")
    }),
  )
  const icon = manifest.icon
    ? await inside(webRoot, resolvePackageFile(manifest.id, manifest.icon, "web icon", pkg), "web icon")
    : undefined

  const packageFile = path.join(dir, "package.json")
  const fingerprintFiles = [packageFile, entry, ...styles, ...(icon ? [icon] : [])]
  const fingerprint = await Promise.all(
    fingerprintFiles.map(async (file) => {
      const stat = await lstat(file)
      return `${path.relative(dir, file)}:${stat.size}:${Math.floor(stat.mtimeMs)}`
    }),
  )
  const versionSegment = `${version}-${Hash.fast(fingerprint.join("\0")).slice(0, 12)}`

  return {
    id: manifest.id,
    name,
    version,
    displayName: manifest.displayName,
    description: manifest.description,
    permissions: unique(manifest.permissions ?? []),
    activation: unique(manifest.activation ?? ["onStartup"]),
    contributes: manifest.contributes ?? {},
    dir,
    webRoot,
    entry: path.relative(webRoot, entry).replaceAll("\\", "/"),
    styles: styles.map((file) => path.relative(webRoot, file).replaceAll("\\", "/")),
    icon: icon ? path.relative(webRoot, icon).replaceAll("\\", "/") : undefined,
    versionSegment,
  }
}

export * as ExtensionManifest from "./manifest"
