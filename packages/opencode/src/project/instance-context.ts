import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Path, type LogicalPath, type NativePath, type PathContext, type PathIdentity } from "@opencode-ai/core/util/path"
import type * as Project from "./project"
import type { ProjectLocation } from "./location"

export const localPathContext: PathContext = {
  platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
  kind: "local-filesystem",
}

export interface InstanceContext {
  /** Case-preserving logical path used in APIs, events and persistence values. */
  directory: LogicalPath
  /** Case-folded only for Windows local drive/UNC paths; used for keyed state. */
  directoryKey: PathIdentity
  /** Native separator form used at filesystem/process boundaries. */
  nativeDirectory: NativePath
  worktree: string
  project: Project.Info
  location: ProjectLocation.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (AppFileSystem.contains(ctx.nativeDirectory, Path.native(filepath, localPathContext))) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return AppFileSystem.contains(ctx.worktree, filepath)
}
