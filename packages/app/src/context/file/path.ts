import type { PathContext } from "@opencode-ai/core/util/path"

/**
 * Path handling for the file panel follows an explicit source contract:
 *
 *  - raw: a filesystem path as produced by the backend (list/read/watcher/vcs).
 *      `#`, `?`, `%` and `\` are filename characters on POSIX and must never be
 *      decoded, stripped or quoted away.
 *  - git: git output that may still carry C-style quoting (`"a/\303\251.txt"`).
 *      Unquoting happens only at the git syntax boundary, never twice.
 *  - tab: the internal `file://src/app.ts` tab id produced by `tab()`. The
 *      first authority-looking segment is a relative path segment. Encoded
 *      once per segment, decoded once per segment.
 *  - file-url: a standard `file:///C:/...` or `file://server/share/...` URL.
 *      Parsed with the URL grammar, drive slash and UNC host handled.
 *
 * The legacy `normalize()` keeps working as a temporary compatibility wrapper
 * that guesses the source from the `file:` prefix; new code should call the
 * explicit `fromRaw` / `fromGit` / `fromTab` / `fromFileUrl` entries.
 */

export function stripFileProtocol(input: string) {
  if (!input.startsWith("file://")) return input
  return input.slice("file://".length)
}

export function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")

  if (hashIndex !== -1 && queryIndex !== -1) {
    return input.slice(0, Math.min(hashIndex, queryIndex))
  }

  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

/**
 * Unquote a git C-style quoted path. Octal escapes are bytes; every other
 * character (including multi-byte Unicode) is a literal character. Invalid
 * escapes keep their backslash instead of silently mapping to another file.
 */
export function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []
  let out = ""

  const flushBytes = () => {
    if (bytes.length === 0) return
    out += new TextDecoder().decode(new Uint8Array(bytes))
    bytes.length = 0
  }

  const pushChar = (value: string) => {
    if (value.charCodeAt(0) < 0x80) {
      bytes.push(value.charCodeAt(0))
      return
    }
    flushBytes()
    out += value
  }

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      pushChar(char)
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    if (escaped !== undefined) {
      pushChar(escaped)
      i++
      continue
    }

    // An invalid escape keeps its backslash: silently dropping it would name
    // a different file than the one git reported.
    pushChar("\\")
    pushChar(next)
    i++
  }

  flushBytes()
  return out
}

export function decodeFilePath(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function encodeFilePath(filepath: string, options?: { foldBackslash?: boolean }): string {
  const fold = options?.foldBackslash ?? true
  // On Windows-owning contexts (and by legacy default) backslash is a
  // separator; on POSIX it is a filename character and must be encoded as %5C
  // so the tab round-trip preserves it.
  let normalized = fold ? filepath.replace(/\\/g, "/") : filepath

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = "/" + normalized
  }

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

/**
 * Decode the internal tab format `file://<encoded workspace-relative path>`.
 * The authority-looking first segment is a relative path segment, query and
 * hash are stripped on the ENCODED form, and each segment is decoded exactly
 * once. Returns undefined for inputs without the `file://` prefix.
 */
export function parseTabPath(input: string): string | undefined {
  if (!input.startsWith("file://")) return undefined
  const rest = stripQueryAndHash(input.slice("file://".length))
  return rest
    .split("/")
    .map((segment) => decodeFilePath(segment))
    .join("/")
}

/**
 * Parse a standard file URL with the URL grammar. `file:///C:/repo/x` becomes
 * `C:/repo/x`, `file:///home/x` stays `/home/x`, and with `allowHost` a UNC
 * URL `file://server/share/x` becomes `//server/share/x`. The internal tab
 * format (`file://src/app.ts`) is NOT a standard file URL and returns
 * undefined here; parse it with {@link parseTabPath}.
 */
export function parseStandardFileUrl(
  input: string,
  options?: { allowHost?: boolean },
): string | undefined {
  if (!/^file:/i.test(input)) return undefined
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol.toLowerCase() !== "file:") return undefined

  const host = url.hostname
  if (host) {
    if (!options?.allowHost) return undefined
    // A drive in the host position is the legacy `file://C:/...` tab spelling.
    if (/^[A-Za-z]:$/.test(host)) return undefined
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeFilePath(segment))
    return `//${decodeFilePath(host)}/${segments.join("/")}`
  }

  const pathname = url.pathname
  // file:///C:/repo keeps a single extra leading slash before the drive.
  const drive = pathname.match(/^\/([A-Za-z]:)(\/.*)$/)
  if (drive) return `${drive[1]}${drive[2]}`
  return pathname
}

/**
 * Context-aware path helpers for one workspace. `context` describes the
 * filesystem that owns the workspace; when omitted the helpers keep the
 * legacy behavior of folding backslashes unconditionally.
 */
export function createPathHelpers(scope: () => string, context?: () => PathContext) {
  const foldSeparators = () => {
    const platform = context?.().platform
    return platform === undefined ? true : platform === "win32"
  }

  const logical = (value: string) => (foldSeparators() ? value.replace(/\\/g, "/") : value)

  const stripWorkspaceRoot = (path: string) => {
    const root = scope()
    if (!path) return path
    if (!root) return path

    const windowsRoot = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\")
    const canonRoot = windowsRoot ? root.replace(/\\/g, "/").toLowerCase() : root.replace(/\\/g, "/")
    const canonPath = windowsRoot ? path.replace(/\\/g, "/").toLowerCase() : path.replace(/\\/g, "/")
    if (
      canonPath.startsWith(canonRoot) &&
      (canonRoot.endsWith("/") || canonPath === canonRoot || canonPath[canonRoot.length] === "/")
    ) {
      return path.slice(root.length)
    }
    return path
  }

  const stripRelativeAffixes = (path: string) => {
    let value = path
    if (value.startsWith("./") || (foldSeparators() && value.startsWith(".\\"))) value = value.slice(2)
    if (value.startsWith("/")) value = value.slice(1)
    else if (foldSeparators() && value.startsWith("\\")) value = value.slice(1)
    return value
  }

  /**
   * Legacy compatibility wrapper: resolves any input (raw path, internal tab
   * or standard file URL) to a workspace-relative logical path. Raw inputs are
   * no longer decoded, hash-stripped or git-unquoted; only `file:` inputs go
   * through an encoding-aware parser.
   */
  const resolvePath = (path: string) => {
    const folded = logical(path)
    const root = scope()
    if (!root) return stripRelativeAffixes(folded)
    const stripped = stripWorkspaceRoot(folded)
    if (stripped !== folded) return stripRelativeAffixes(stripped)
    // No workspace-root match: absolute paths stay absolute so an input can
    // never silently name a different file; only a "./" prefix is dropped.
    return folded.startsWith("./") ? folded.slice(2) : folded
  }

  const normalize = (input: string) => {
    let path = input
    if (input.startsWith("file:")) {
      path = parseStandardFileUrl(input) ?? parseTabPath(input) ?? input
    }
    return resolvePath(path)
  }

  /** Raw backend path (list/read/watcher/vcs): no decoding of any kind. */
  const fromRaw = (input: string) => resolvePath(input)

  /** Git output: unquote only at the git syntax boundary, then resolve. */
  const fromGit = (input: string) => resolvePath(unquoteGitPath(input))

  /** Internal tab id; returns undefined when the input is not a tab. */
  const fromTab = (input: string): string | undefined => {
    const decoded = parseTabPath(input)
    if (decoded === undefined) return undefined
    return resolvePath(decoded)
  }

  /** Standard file URL (including UNC hosts); undefined when not one. */
  const fromFileUrl = (input: string): string | undefined => {
    const decoded = parseStandardFileUrl(input, { allowHost: true })
    if (decoded === undefined) return undefined
    return resolvePath(decoded)
  }

  const tab = (input: string) => `file://${encodeFilePath(normalize(input), { foldBackslash: foldSeparators() })}`

  const pathFromTab = (tabValue: string) => fromTab(tabValue)

  const normalizeDir = (input: string) => normalize(input).replace(/\/+$/, "")

  return {
    normalize,
    fromRaw,
    fromGit,
    fromTab,
    fromFileUrl,
    tab,
    pathFromTab,
    normalizeDir,
  }
}
