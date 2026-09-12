import { Path, isWindowsDrivePath, isWindowsUNCPath, type PathContext } from "@opencode-ai/core/util/path"

/**
 * Workspace-relative file identity for the right-side panels.
 *
 * The contract (specs/performance/right-side-panels-optimization.md §3.5):
 *  - `path` is the workspace-relative logical path with the authoritative
 *    spelling kept (case, POSIX backslash filenames); it is what requests use.
 *  - `fileKey` is the comparison identity for Map/Set/keys/request dedup. Only
 *    Windows workspaces on a local filesystem fold case; macOS volumes that
 *    happen to be case-insensitive do NOT fold here, and remote workspaces
 *    keep the conservative case-sensitive strategy until the backend reports
 *    explicit capabilities.
 *  - Ambiguous Windows spellings (`C:foo` drive-relative, `\foo`
 *    rooted-relative) are rejected instead of guessed.
 *
 * Lexical containment is a routing rule, not a security proof: symlink and
 * `..` resolution on the real filesystem remains the backend's decision.
 */

export type ResolvedWorkspaceFile = {
  fileKey: string
  path: string
  name: string
}

export type ResolveFailureReason = "empty" | "ambiguous" | "outside-root" | "escape"

export type ResolveWorkspaceFileResult =
  | ({ ok: true } & ResolvedWorkspaceFile)
  | { ok: false; reason: ResolveFailureReason }

export type FileIdentityContext = PathContext

/** Whether this workspace's filesystem folds path case for identity. */
export function workspaceFoldsCase(context: FileIdentityContext): boolean {
  return context.platform === "win32" && context.kind === "local-filesystem"
}

/** Comparison identity for a workspace-relative logical path. */
export function fileIdentityKey(path: string, context: FileIdentityContext): string {
  return workspaceFoldsCase(context) ? path.toLowerCase() : path
}

const isAbsolutePath = (value: string, context: FileIdentityContext) => {
  if (context.platform === "win32") return isWindowsDrivePath(value) || isWindowsUNCPath(value)
  return value.startsWith("/")
}

const splitRelativeSegments = (input: string, context: FileIdentityContext) => {
  // Backslash is a separator only for a Windows-owning filesystem; on POSIX it
  // is a filename character and must survive as part of a segment.
  const logical = context.platform === "win32" ? input.replace(/\\/g, "/") : input
  const segments: string[] = []
  for (const segment of logical.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments
}

/**
 * Resolve an input path (absolute within the workspace, or workspace-relative)
 * to a workspace-relative file identity. Absolute paths outside the workspace
 * and ambiguous Windows spellings are rejected; relative `..` may not escape
 * the workspace root.
 */
export function resolveWithinWorkspace(
  input: string,
  options: { root: string; context: FileIdentityContext },
): ResolveWorkspaceFileResult {
  const { root, context } = options
  if (!input) return { ok: false, reason: "empty" }

  if (context.kind === "virtual" || context.kind === "url") {
    // Opaque namespaces: no separator or case rules apply.
    const name = input.slice(input.lastIndexOf("/") + 1)
    return { ok: true, fileKey: input, path: input, name }
  }

  if (context.platform === "win32") {
    // C:foo is drive-relative, not C:/foo; \foo is rooted-relative. Protocol
    // entries require an explicit absolute path or a workspace-relative one.
    if (/^[A-Za-z]:[^/\\]/.test(input)) return { ok: false, reason: "ambiguous" }
    if (/^\\(?![\\])/.test(input)) return { ok: false, reason: "ambiguous" }
  }

  const logicalRoot = Path.logical(root, context) as string
  const logicalInput = Path.logical(input, context) as string

  if (isAbsolutePath(logicalInput, context)) {
    if (!Path.isInside(logicalRoot, logicalInput, context)) return { ok: false, reason: "outside-root" }
    if (Path.equals(logicalRoot, logicalInput, context)) return { ok: false, reason: "empty" }
    const relative = Path.relative(logicalRoot, logicalInput, context) as string
    if (!relative) return { ok: false, reason: "empty" }
    return finish(relative, context)
  }

  const segments = splitRelativeSegments(logicalInput, context)
  if (segments === undefined) return { ok: false, reason: "escape" }
  if (segments.length === 0) return { ok: false, reason: "empty" }
  return finish(segments.join("/"), context)
}

function finish(relative: string, context: FileIdentityContext): ResolveWorkspaceFileResult {
  const name = relative.slice(relative.lastIndexOf("/") + 1)
  if (!name) return { ok: false, reason: "empty" }
  return {
    ok: true,
    path: relative,
    name,
    fileKey: fileIdentityKey(relative, context),
  }
}
