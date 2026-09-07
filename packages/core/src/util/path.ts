import { base64Decode, base64Encode } from "./encode"

/** The operating system whose filesystem owns a path. */
export type PathPlatform = "win32" | "darwin" | "linux"

/** The namespace in which a path is interpreted. */
export type PathKind = "local-filesystem" | "remote-filesystem" | "virtual" | "url"

export type PathContext = {
  platform: PathPlatform
  kind: PathKind
}

/** A path suitable for APIs, routes, logs, UI and display. */
export type LogicalPath = string & { readonly __pathBrand: "logical" }

/** A path suitable only for identity comparisons and keyed collections. */
export type PathIdentity = string & { readonly __pathBrand: "identity" }

/** A path suitable for filesystem, shell and watcher boundaries. */
export type NativePath = string & { readonly __pathBrand: "native" }

/** A URL-safe route segment, never a filesystem path. */
export type RouteSlug = string & { readonly __pathBrand: "route-slug" }

const logical = (value: string): LogicalPath => value as LogicalPath
const identity = (value: string): PathIdentity => value as PathIdentity
const native = (value: string): NativePath => value as NativePath
const routeSlug = (value: string): RouteSlug => value as RouteSlug

/**
 * Return whether a value is an absolute Windows drive path. The check is
 * deliberately syntactic: it does not read the host process platform.
 */
export function isWindowsDrivePath(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z]:[\\/]/.test(value)
}

/** Return whether a value is an absolute Windows UNC path. */
export function isWindowsUNCPath(value: string | undefined): boolean {
  return value !== undefined && /^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(value)
}

function canFoldWindowsCase(input: string, context: PathContext) {
  return (
    context.platform === "win32" &&
    context.kind === "local-filesystem" &&
    (isWindowsDrivePath(input) || isWindowsUNCPath(input))
  )
}

function stripTrailingForwardSlashes(value: string) {
  if (value === "/" || /^\/{2}[^/]+\/[^/]+$/.test(value)) return value
  const drive = value.match(/^([A-Za-z]):\/+$/)
  if (drive) return `${drive[1]}:/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

function logicalPath(input: string, context: PathContext): LogicalPath {
  if (!input || context.kind === "url" || context.kind === "virtual") return logical(input)

  // A file URL names a local filesystem path. Decode it while we still have
  // the owning platform; URL/virtual namespaces remain opaque above.
  const decoded = context.kind === "local-filesystem" ? decodeFileUrl(input, context.platform) : input
  // Backslash is a separator only for a Windows filesystem. On POSIX it is a
  // valid filename character and must remain observable in the logical form.
  const value = context.platform === "win32" ? decoded.replace(/\\/g, "/") : decoded
  return logical(stripTrailingForwardSlashes(value))
}

function decodeFileUrl(value: string, platform: PathPlatform) {
  if (!/^file:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol.toLowerCase() !== "file:") return value
    const pathname = decodeURIComponent(url.pathname)
    if (platform === "win32") {
      if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
        return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`
      }
      const drivePath = pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:")
      return drivePath.replace(/\//g, "\\")
    }
    return pathname
  } catch {
    // A malformed file URL is still safer to pass through than to silently
    // turn into a different filesystem path.
    return value
  }
}

type ParsedPath = {
  root: string
  segments: string[]
  absolute: boolean
}

function parsePath(value: string, context: PathContext): ParsedPath {
  const normalized = logicalPath(value, context) as string
  if (context.kind === "url" || context.kind === "virtual") return { root: "", segments: [normalized], absolute: false }

  if (context.platform === "win32") {
    const drive = normalized.match(/^([A-Za-z]:)\/(.*)$/)
    if (drive) return { root: `${drive[1]}/`, segments: splitSegments(drive[2], true), absolute: true }
    const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/)
    if (unc) return { root: `//${unc[1]}/${unc[2]}`, segments: splitSegments(unc[3] ?? "", true), absolute: true }
  }

  if (normalized.startsWith("/")) return { root: "/", segments: splitSegments(normalized.slice(1), true), absolute: true }
  return { root: "", segments: splitSegments(normalized, false), absolute: false }
}

function splitSegments(value: string, absolute: boolean) {
  const result: string[] = []
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === ".." && (result.length > 0 || !absolute)) {
      if (result[result.length - 1] && result[result.length - 1] !== "..") result.pop()
      else if (!absolute) result.push(segment)
      continue
    }
    result.push(segment)
  }
  return result
}

function sameRoot(a: ParsedPath, b: ParsedPath, context: PathContext) {
  if (a.absolute !== b.absolute) return false
  if (a.root === b.root) return true
  if (!a.root || !b.root) return false
  if (context.platform === "win32" && context.kind === "local-filesystem" && isWindowsDrivePath(a.root) && isWindowsDrivePath(b.root)) {
    return a.root.toLowerCase() === b.root.toLowerCase()
  }
  if (context.platform === "win32" && context.kind === "local-filesystem" && isWindowsUNCPath(a.root) && isWindowsUNCPath(b.root)) {
    return a.root.toLowerCase() === b.root.toLowerCase()
  }
  return false
}

function sameSegment(a: string, b: string, context: PathContext, root: string) {
  const fold = context.platform === "win32" && context.kind === "local-filesystem" && (isWindowsDrivePath(root) || isWindowsUNCPath(root))
  return fold ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Context-aware path operations. Every operation is explicit about the
 * filesystem namespace so a Windows client cannot accidentally fold a remote
 * POSIX workspace.
 */
export const Path = {
  logical(input: string, context: PathContext): LogicalPath {
    return logicalPath(input, context)
  },

  identity(input: string, context: PathContext): PathIdentity {
    const value = logicalPath(input, context) as string
    return identity(canFoldWindowsCase(value, context) ? value.toLowerCase() : value)
  },

  native(input: string, context: PathContext): NativePath {
    const value = logicalPath(input, context) as string
    if (context.kind === "url" || context.kind === "virtual") return native(value)
    const decoded = decodeFileUrl(value, context.platform)
    if (context.platform === "win32") return native(decoded.replace(/\//g, "\\"))
    return native(decoded)
  },

  equals(a: string, b: string, context: PathContext): boolean {
    return (Path.identity(a, context) as string) === (Path.identity(b, context) as string)
  },

  isInside(root: string, child: string, context: PathContext): boolean {
    const parent = parsePath(root, context)
    const descendant = parsePath(child, context)
    if (!sameRoot(parent, descendant, context)) return false
    if (parent.segments.length > descendant.segments.length) return false
    return parent.segments.every((segment, index) => sameSegment(segment, descendant.segments[index]!, context, parent.root))
  },

  relative(root: string, child: string, context: PathContext): LogicalPath {
    const parent = parsePath(root, context)
    const descendant = parsePath(child, context)
    if (!sameRoot(parent, descendant, context)) return logical(logicalPath(child, context) as string)

    let common = 0
    while (
      common < parent.segments.length &&
      common < descendant.segments.length &&
      sameSegment(parent.segments[common]!, descendant.segments[common]!, context, parent.root)
    ) {
      common++
    }
    const result = [
      ...parent.segments.slice(common).map(() => ".."),
      ...descendant.segments.slice(common),
    ]
    return logical(result.join("/"))
  },

  route: {
    encode(path: string): RouteSlug {
      return routeSlug(base64Encode(path))
    },
    decode(slug: string): LogicalPath {
      return logical(base64Decode(slug))
    },
  },
} as const

/**
 * Canonical logical-path form used as identity for directories across the
 * codebase (SDK wire, Instance cache, session/project DB columns, app store
 * keys, channel mapping, UI comparisons).
 *
 * Rules:
 *  - backslashes -> forward slashes (Windows `\` normalization)
 *  - trailing slashes collapsed (but `C:/` and `/` keep their trailing slash
 *    so drive-rooted or posix-root keys remain distinguishable from relative
 *    segments)
 *  - case preserved (use {@link pathIdentityKey} for Map/Set keys and equality)
 *
 * Anything that touches the real filesystem (fs.*, spawn, Electron shell)
 * should convert to native separators at that boundary, not beforehand.
 */
export function toLogicalPath(p: string | undefined): string {
  if (!p) return ""
  const value = p.replace(/\\/g, "/")
  const drive = value.match(/^([A-Za-z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

/**
 * Stable identity key for logical filesystem paths.
 *
 * Windows drive and UNC paths are case-insensitive, including when they are
 * received by a web renderer connected to a Windows backend. POSIX and remote
 * paths retain case because their filesystem can be case-sensitive.
 */
export function pathIdentityKey(p: string | undefined): string {
  if (!p) return ""
  if (isWindowsDrivePath(p) || isWindowsUNCPath(p)) {
    return Path.identity(p, { platform: "win32", kind: "local-filesystem" }) as string
  }
  return Path.identity(p, { platform: "linux", kind: "local-filesystem" }) as string
}

/**
 * Directory identity equality. Two paths are the same directory when they
 * share the same logical-path form. Prefer this over raw `===` for any
 * comparison involving session.directory / project.worktree / channel
 * directories, since SDK always sends `/` while Windows stores may hold `\`.
 */
export function directoryEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b
  return pathIdentityKey(a) === pathIdentityKey(b)
}

export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ""
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

export function getFileExtension(path: string | undefined) {
  if (!path) return ""
  const parts = path.split(".")
  return parts[parts.length - 1]
}

export function getFilenameTruncated(path: string | undefined, maxLength: number = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  const lastDot = filename.lastIndexOf(".")
  const ext = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - ext.length - 1 // -1 for ellipsis
  if (available <= 0) return filename.slice(0, maxLength - 1) + "…"
  return filename.slice(0, available) + "…" + ext
}

export function truncateMiddle(text: string, maxLength: number = 20) {
  if (text.length <= maxLength) return text
  const available = maxLength - 1 // -1 for ellipsis
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return text.slice(0, start) + "…" + text.slice(-end)
}
