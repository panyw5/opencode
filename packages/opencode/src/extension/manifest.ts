import path from "path"
import { lstat, readFile, realpath } from "fs/promises"
import semver from "semver"
import { Schema } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Log } from "@opencode-ai/core/util/log"
import { Hash } from "@/util/hash"
import { Filesystem } from "@/util/filesystem"
import { ConfigParse } from "@/config/parse"
import { checkPluginCompatibility, extractExportValue, readPluginPackage, resolvePackageFile } from "@/plugin/shared"
import {
  Manifest,
  PERMISSIONS,
  SERVER_API_VERSION,
  WEB_API_VERSION,
  type Contributes,
  type ExtensionID,
  type IsolationMode,
} from "./schema"

const log = Log.create({ service: "extension" })

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
  entry?: string
  styles: string[]
  icon?: string
  serverEntry?: string
  versionSegment: string
  webFingerprint: string
  serverFingerprint?: string
  /**
   * Declared server execution backend from `opencode.server.isolation`.
   * Undefined means the manifest said nothing — the runtime resolves the
   * `inline` default and any environment override.
   */
  isolation?: IsolationMode
  // Stable machine-oriented warning codes surfaced through Info.warnings.
  warnings: string[]
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

function packageExport(json: Record<string, unknown>, key: string) {
  const exports = json.exports
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return
  return extractExportValue((exports as Record<string, unknown>)[key])
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS)

// Declared permissions are self-reported. Unknown values are tolerated for
// forward compatibility: warn here, mark them in the UI, never block install.
function warnUnknownPermissions(manifest: Manifest) {
  for (const permission of unique(manifest.permissions ?? [])) {
    if (!KNOWN_PERMISSIONS.has(permission))
      log.warn("extension declares an unknown permission", { extension: manifest.id, permission })
  }
}

async function contentFingerprint(root: string, files: string[]) {
  const parts = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file)
      return Buffer.concat([Buffer.from(`${path.relative(root, file)}\0`), content, Buffer.from("\0")])
    }),
  )
  return Hash.fast(Buffer.concat(parts))
}

function validateContributions(manifest: Manifest) {
  const contributes = manifest.contributes ?? {}
  const viewers = new Set<string>()
  const commands = new Set<string>()
  const panels = new Set<string>()
  const ids = new Set<string>()
  for (const viewer of contributes.fileViewers ?? []) {
    if (ids.has(viewer.id)) throw new Error(`Extension has duplicate file viewer id: ${viewer.id}`)
    ids.add(viewer.id)
    viewers.add(viewer.id)
    const matchers = [viewer.extensions?.length, viewer.filenames?.length, viewer.mime?.length]
    if (!matchers.some(Boolean)) throw new Error(`Extension file viewer ${viewer.id} has no matchers`)
  }
  const tools = new Set<string>()
  for (const renderer of contributes.toolRenderers ?? []) {
    if (tools.has(renderer.tool)) throw new Error(`Extension has duplicate tool renderer: ${renderer.tool}`)
    tools.add(renderer.tool)
  }
  for (const command of contributes.commands ?? []) {
    if (ids.has(command.id)) throw new Error(`Extension has duplicate command id: ${command.id}`)
    ids.add(command.id)
    commands.add(command.id)
  }
  for (const panel of contributes.panels ?? []) {
    if (ids.has(panel.id)) throw new Error(`Extension has duplicate panel id: ${panel.id}`)
    ids.add(panel.id)
    panels.add(panel.id)
  }
  for (const activation of manifest.activation ?? ["onStartup"]) {
    if (activation === "onStartup") continue
    const separator = activation.indexOf(":")
    const kind = activation.slice(0, separator)
    const reference = activation.slice(separator + 1)
    if (kind === "onFileViewer" && !viewers.has(reference))
      throw new Error(`Extension activation references unknown file viewer: ${reference}`)
    if (kind === "onCommand" && !commands.has(reference))
      throw new Error(`Extension activation references unknown command: ${reference}`)
    if (kind === "onPanel" && !panels.has(reference))
      throw new Error(`Extension activation references unknown panel: ${reference}`)
    if (kind === "onTool" && !tools.has(reference))
      throw new Error(`Extension activation references unknown tool: ${reference}`)
  }
  // Activation events other than onStartup are declarative hints, not gates:
  // every declared contribution activates implicitly on use, so a missing
  // event only earns an informational note (design.md §7.4, D2).
  const declared = new Set(manifest.activation ?? ["onStartup"])
  if (!declared.has("onStartup")) {
    for (const [kind, references] of [
      ["onFileViewer", viewers],
      ["onTool", tools],
      ["onCommand", commands],
      ["onPanel", panels],
    ] as const) {
      for (const reference of references) {
        if (declared.has(`${kind}:${reference}`)) continue
        log.info("extension contribution has no matching activation event", {
          extension: manifest.id,
          event: `${kind}:${reference}`,
        })
      }
    }
  }
  for (const [key, setting] of Object.entries(contributes.settings ?? {})) {
    if (setting.enum) {
      if (setting.type === "boolean")
        throw new Error(`Extension setting ${key} must not declare enum values for boolean type`)
      if (setting.enum.some((value) => typeof value !== setting.type))
        throw new Error(`Extension setting ${key} has enum values that do not match its type`)
    }
    if (setting.default === undefined) continue
    if (typeof setting.default !== setting.type)
      throw new Error(`Extension setting ${key} has a default that does not match its type`)
    if (setting.enum && !setting.enum.some((value) => value === setting.default))
      throw new Error(`Extension setting ${key} has a default that is not one of its enum values`)
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
  warnUnknownPermissions(manifest)

  try {
    await checkPluginCompatibility(dir, options.opencodeVersion ?? InstallationVersion, pkg)
  } catch (error) {
    throw new CompatibilityError(error instanceof Error ? error.message.replace(/^Plugin/, "Extension") : String(error))
  }

  // Graceful degradation: an unsupported web apiVersion only discards the web
  // part — the server part stays usable and a stable warning code is reported
  // through Info.warnings. `manifestVersion` stays a hard reject via the
  // schema literal.
  const warnings: string[] = []
  let webSkipped = false
  if (manifest.web && manifest.web.apiVersion !== WEB_API_VERSION) {
    webSkipped = true
    warnings.push(`web.apiVersion:${manifest.web.apiVersion}`)
    log.warn("extension web apiVersion is not supported; skipping web part", {
      extension: manifest.id,
      apiVersion: manifest.web.apiVersion,
    })
    manifest.web = undefined
  }

  // Same Q10 contract for the server half: an unknown apiVersion drops the
  // whole server contribution — entry, isolation declaration and fingerprint —
  // while the web part stays usable and a stable warning code is reported.
  let serverSkipped = false
  if (manifest.server && manifest.server.apiVersion !== undefined && manifest.server.apiVersion !== SERVER_API_VERSION) {
    serverSkipped = true
    warnings.push(`server.apiVersion:${manifest.server.apiVersion}`)
    log.warn("extension server apiVersion is not supported; skipping server part", {
      extension: manifest.id,
      apiVersion: manifest.server.apiVersion,
    })
    manifest.server = undefined
  }

  const webExported = packageExport(pkg.json, "./web")
  const serverExported = packageExport(pkg.json, "./server")
  const serverPart = serverSkipped ? undefined : serverExported
  if (!webExported && !serverPart)
    throw new Error('Extension package must expose exports["./web"] or exports["./server"]')
  if (webExported && !manifest.web && !webSkipped)
    throw new Error('Extension manifest requires opencode.web when exports["./web"] is present')
  if (!webExported && manifest.web)
    throw new Error('Extension manifest declares opencode.web but the package does not expose exports["./web"]')

  let entry: string | undefined
  let entryAbsolute: string | undefined
  let webRoot = dir
  let icon: string | undefined
  let iconAbsolute: string | undefined
  let styleAbsolute: string[] = []
  if (webExported && manifest.web) {
    const webEntry = resolvePackageFile(manifest.id, webExported, "web", pkg)
    await ordinaryFile(webEntry, "web entry")
    webRoot = path.dirname(await realpath(webEntry))
    entry = path.relative(webRoot, webEntry).replaceAll("\\", "/")
    entryAbsolute = webEntry

    styleAbsolute = await Promise.all(
      unique(manifest.web.styles ?? []).map(async (raw) => {
        const file = resolvePackageFile(manifest.id, raw, "web style", pkg)
        return inside(webRoot, file, "web style")
      }),
    )
    if (manifest.icon) {
      iconAbsolute = await inside(webRoot, resolvePackageFile(manifest.id, manifest.icon, "web icon", pkg), "web icon")
      icon = path.relative(webRoot, iconAbsolute).replaceAll("\\", "/")
    }
  } else if (manifest.icon) {
    iconAbsolute = await inside(dir, resolvePackageFile(manifest.id, manifest.icon, "web icon", pkg), "web icon")
    icon = path.relative(dir, iconAbsolute).replaceAll("\\", "/")
  }

  let serverEntry: string | undefined
  let serverEntryAbsolute: string | undefined
  if (serverPart) {
    serverEntryAbsolute = resolvePackageFile(manifest.id, serverPart, "server", pkg)
    await ordinaryFile(serverEntryAbsolute, "server entry")
    serverEntry = path.relative(dir, serverEntryAbsolute).replaceAll("\\", "/")
  }

  const packageFile = path.join(dir, "package.json")
  const webFingerprint = await contentFingerprint(dir, [
    packageFile,
    ...(entryAbsolute ? [entryAbsolute] : []),
    ...styleAbsolute,
    ...(iconAbsolute ? [iconAbsolute] : []),
  ])
  const versionSegment = `${version}-${webFingerprint.slice(0, 12)}`
  const serverFingerprint = serverEntryAbsolute
    ? await contentFingerprint(dir, [packageFile, serverEntryAbsolute])
    : undefined

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
    entry,
    styles: styleAbsolute.map((file) => path.relative(webRoot, file).replaceAll("\\", "/")),
    icon,
    serverEntry,
    versionSegment,
    webFingerprint,
    serverFingerprint,
    ...(serverPart ? { isolation: manifest.server?.isolation } : {}),
    warnings,
  }
}

export * as ExtensionManifest from "./manifest"
