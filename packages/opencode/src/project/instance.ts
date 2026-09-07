import { Filesystem } from "@/util/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { Path, type LogicalPath, type NativePath, type PathIdentity } from "@opencode-ai/core/util/path"
import { Context } from "../util/context"
import { localPathContext } from "./instance-context"
import { Project } from "./project"
import { State } from "./state"
import { InstanceRuntime } from "./instance-runtime"
import type { ProjectLocation } from "./location"

export interface Shape {
  /** Case-preserving logical path exposed to APIs and events. */
  directory: LogicalPath
  /** Identity-only key used for caches and disposal. */
  directoryKey: PathIdentity
  /** Native separator form used at filesystem/process boundaries. */
  nativeDirectory: NativePath
  worktree: string
  project: Project.Info
  location: ProjectLocation.Info
}
const context = Context.create<Shape>("instance")
const cache = new Map<PathIdentity, Promise<Shape>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}
const log = Log.create({ service: "instance" })

function normalizeDirectory(input: string) {
  // Resolve only at the filesystem boundary so relative paths and symlinks
  // retain the existing Instance cache semantics. All cache operations then
  // use the explicit identity form, never the display/logical path.
  // Let Filesystem.resolve translate Git Bash/Cygwin/MSYS drive prefixes
  // before converting to the explicit logical/native path forms.
  const resolved = Path.logical(Filesystem.resolve(input), localPathContext)
  return {
    logical: resolved,
    identity: Path.identity(resolved, localPathContext),
    native: Path.native(resolved, localPathContext),
  }
}

function boot(input: {
  directory: ReturnType<typeof normalizeDirectory>
  init?: () => Promise<any>
  project?: Project.Info
  worktree?: string
  location?: ProjectLocation.Info
}, options?: { reload?: boolean }) {
  return iife(async () => {
    const at = Date.now()
    const ctx = await (options?.reload ? InstanceRuntime.reloadInstance : InstanceRuntime.load)({
      directory: input.directory.logical,
      project: input.project,
      worktree: input.worktree,
      location: input.location,
    })
    log.info("instance.boot", {
      directory: ctx.directory,
      projectID: ctx.project.id,
      vcs: ctx.project.vcs,
      duration: Date.now() - at,
      phase: "context",
    })
    const bt = Date.now()
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    log.info("instance.boot", {
      directory: ctx.directory,
      projectID: ctx.project.id,
      vcs: ctx.project.vcs,
      duration: Date.now() - bt,
      phase: "bootstrap",
    })
    log.info("instance.boot", {
      directory: ctx.directory,
      projectID: ctx.project.id,
      vcs: ctx.project.vcs,
      duration: Date.now() - at,
      phase: "total",
    })
    return ctx
  })
}

function track(directory: PathIdentity, next: Promise<Shape>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    const normalized = normalizeDirectory(input.directory)
    const directory = normalized.identity
    let existing = cache.get(directory)
    if (!existing) {
      log.info("instance.create", {
        rawPath: input.directory,
        logicalPath: normalized.logical,
        identityKey: normalized.identity,
        nativePath: normalized.native,
        platform: localPathContext.platform,
        workspaceKind: localPathContext.kind,
        cache: "miss",
      })
      existing = track(
        directory,
        boot({
          directory: normalized,
          init: input.init,
        }),
      )
    } else {
      log.info("instance.create", {
        rawPath: input.directory,
        logicalPath: normalized.logical,
        identityKey: normalized.identity,
        nativePath: normalized.native,
        platform: localPathContext.platform,
        workspaceKind: localPathContext.kind,
        cache: "hit",
      })
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  get location() {
    return context.use().location
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    const ctx = Instance.current
    const nativeFilepath = Path.native(filepath, localPathContext)
    if (Filesystem.contains(ctx.nativeDirectory, nativeFilepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Path.native(ctx.worktree, localPathContext), nativeFilepath)
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.current.directoryKey, init, dispose)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const normalized = normalizeDirectory(input.directory)
    const directory = normalized.identity
    Log.Default.info("reloading instance", {
      rawPath: input.directory,
      logicalPath: normalized.logical,
      identityKey: normalized.identity,
      nativePath: normalized.native,
      platform: localPathContext.platform,
      workspaceKind: localPathContext.kind,
    })
    await State.dispose(directory)
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory: normalized }, { reload: true }))
    return await next
  },
  async dispose() {
    const ctx = Instance.current
    Log.Default.info("disposing instance", {
      rawPath: ctx.directory,
      logicalPath: ctx.directory,
      identityKey: ctx.directoryKey,
      nativePath: ctx.nativeDirectory,
      platform: localPathContext.platform,
      workspaceKind: localPathContext.kind,
    })
    await State.dispose(ctx.directoryKey)
    await InstanceRuntime.disposeInstance(ctx)
    cache.delete(ctx.directoryKey)
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
