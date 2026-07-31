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
 *  - case preserved (case-folding is a separate concern; callers that need
 *    case-insensitive identity on Windows should lowercase the result)
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
 * Directory identity equality. Two paths are the same directory when they
 * share the same logical-path form. Prefer this over raw `===` for any
 * comparison involving session.directory / project.worktree / channel
 * directories, since SDK always sends `/` while Windows stores may hold `\`.
 */
export function directoryEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b
  return toLogicalPath(a) === toLogicalPath(b)
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
