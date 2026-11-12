import path from "node:path"
import { pathToFileURL } from "node:url"
import { cp, lstat, mkdir, readlink, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import type { ServerExtension } from "@opencode-ai/extension-kit/server"
import { Hash } from "@/util/hash"

/**
 * Context needed to materialize an importable copy of the extension package.
 * `dir` is the package root (the manifest directory), `source` the server
 * entry inside it.
 */
export type ImporterContext = { id: string; dir: string }

/**
 * Imports a bundled server entry. Overridable so tests can simulate module
 * replacement.
 *
 * The default implementation copies the whole package into
 * `Global.Path.tmp/extension-modules/<id>/<fingerprint>/` and imports from
 * that fresh real path. Bun normalizes file URL query/hash fragments, so a
 * fixed source URL always returns the cached module and hot reload would
 * never observe new code; only a changed real path produces a fresh module.
 */
export type Importer = (
  source: string,
  fingerprint: string | undefined,
  context: ImporterContext,
) => Promise<ServerExtension>

/** Directory names never copied into the module cache. */
const MODULE_COPY_SKIP = new Set(["node_modules", ".git"])
/** Number of fingerprint copies retained per extension id (current + recent). */
const MODULE_COPY_KEEP = 3
/** Upper bound for a single path segment of the module cache location. */
const MODULE_SEGMENT_MAX = 120

function safeSegment(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MODULE_SEGMENT_MAX)
  if (!cleaned || cleaned === "." || cleaned === "..") return "_"
  return cleaned
}

function moduleCopyRoot(id: string) {
  return path.join(Global.Path.tmp, "extension-modules", safeSegment(id))
}

/**
 * Fallback fingerprint for manifests without a `serverFingerprint`: a content
 * hash of the package manifest and server entry, mirroring the integrated
 * contract closely enough to give every version its own copy directory.
 */
async function fallbackFingerprint(context: ImporterContext, source: string) {
  const [pkg, entry] = await Promise.all([
    readFile(path.join(context.dir, "package.json")).catch(() => undefined),
    readFile(source).catch(() => undefined),
  ])
  return Hash.fast(
    Buffer.concat([
      Buffer.from(context.dir),
      Buffer.from("\0"),
      pkg ?? Buffer.alloc(0),
      Buffer.from("\0"),
      entry ?? Buffer.alloc(0),
    ]),
  )
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/**
 * Removes old fingerprint copies for an extension, keeping the current one
 * plus the `MODULE_COPY_KEEP - 1` most recently touched siblings. Copying can
 * be concurrent across processes, so pruning never touches the current copy
 * and ignores all failures.
 */
async function pruneModuleCopies(idDir: string, keep: string) {
  const siblings = await readdir(idDir, { withFileTypes: true }).catch(() => undefined)
  if (!siblings) return
  const others: { name: string; mtime: number }[] = []
  for (const sibling of siblings) {
    if (!sibling.isDirectory() || sibling.name === keep) continue
    const info = await stat(path.join(idDir, sibling.name)).catch(() => undefined)
    if (info?.isDirectory()) others.push({ name: sibling.name, mtime: info.mtimeMs })
  }
  others.sort((a, b) => b.mtime - a.mtime)
  for (const victim of others.slice(MODULE_COPY_KEEP - 1)) {
    await rm(path.join(idDir, victim.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Copies the package into `target` (a unique temp dir renamed into place) so
 * concurrent copiers — within this process and across processes — end up with
 * a complete directory no matter who wins the rename. `node_modules` is
 * excluded from the copy but re-linked to the original so bare specifiers
 * keep resolving against the real installed dependencies.
 */
async function copyModule(context: ImporterContext, target: string, relativeEntry: string) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await cp(context.dir, temp, {
      recursive: true,
      dereference: true,
      filter: (source) => !MODULE_COPY_SKIP.has(path.basename(source)),
    })
    const nodeModules = path.join(context.dir, "node_modules")
    if (
      await stat(nodeModules).then(
        (info) => info?.isDirectory() ?? false,
        () => false,
      )
    ) {
      await symlink(nodeModules, path.join(temp, "node_modules"), "dir")
    }
    if (!(await exists(path.join(temp, relativeEntry)))) {
      throw new Error(`Extension module copy is missing its server entry: ${context.id}`)
    }
    try {
      await rename(temp, target)
    } catch (error) {
      // Only reuse a concurrent winner when its entry is present. A directory
      // left by an interrupted copy is not a valid module cache.
      if (await exists(path.join(target, relativeEntry))) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      } else {
        const stale = `${target}.${process.pid}.${randomUUID()}.stale`
        try {
          await rename(target, stale)
        } catch {
          if (!(await exists(path.join(target, relativeEntry)))) throw error
          await rm(temp, { recursive: true, force: true }).catch(() => undefined)
          return
        }
        try {
          await rename(temp, target)
        } finally {
          await rm(stale, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await pruneModuleCopies(path.dirname(target), path.basename(target)).catch(() => undefined)
}

/** In-flight copy deduplication keyed by the target directory. */
const moduleCopies = new Map<string, Promise<void>>()

function copyModuleOnce(context: ImporterContext, target: string, relativeEntry: string) {
  const pending = moduleCopies.get(target)
  if (pending) return pending
  const copy = copyModule(context, target, relativeEntry).finally(() => {
    if (moduleCopies.get(target) === copy) moduleCopies.delete(target)
  })
  moduleCopies.set(target, copy)
  return copy
}

/**
 * Reuse-path repair: a copy made by an earlier process carries a node_modules
 * symlink aimed at that process's package, which may have moved or vanished.
 * Re-point dangling or stale links at the current source so bare specifiers
 * keep resolving against the real installed dependencies.
 */
async function refreshNodeModulesLink(context: ImporterContext, target: string) {
  const link = path.join(target, "node_modules")
  const wanted = path.join(context.dir, "node_modules")
  const info = await lstat(link).catch(() => undefined)
  if (!info?.isSymbolicLink()) {
    // Nothing to repair for real directories, and create the link when an
    // older copy predates the symlink step.
    if (
      !info &&
      (await stat(wanted).then(
        (found) => found?.isDirectory() ?? false,
        () => false,
      ))
    ) {
      await symlink(wanted, link, "dir").catch(() => undefined)
    }
    return
  }
  const current = await readlink(link).catch(() => undefined)
  if (
    current === wanted &&
    (await stat(link).then(
      () => true,
      () => false,
    ))
  )
    return
  await rm(link, { force: true }).catch(() => undefined)
  await symlink(wanted, link, "dir").catch(() => undefined)
}

/**
 * Materializes the importable entry path for a server source: a real copy of
 * the package under the fingerprint's own directory. Reuses an intact copy
 * from a previous process when the entry file is already present.
 */
async function moduleEntryPath(context: ImporterContext, source: string, fingerprint: string) {
  const relative = path.relative(context.dir, source)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Extension server entry is outside the package directory: ${context.id}`)
  }
  const target = path.join(moduleCopyRoot(context.id), safeSegment(fingerprint))
  const entry = path.join(target, relative)
  if (await exists(entry)) {
    await refreshNodeModulesLink(context, target)
    return entry
  }
  try {
    await copyModuleOnce(context, target, relative)
  } catch (error) {
    // The winner of a concurrent copy already provides the entry.
    if (await exists(entry)) return entry
    throw error
  }
  return entry
}

export async function defaultImporter(source: string, fingerprint: string | undefined, context: ImporterContext) {
  const resolved = fingerprint ?? (await fallbackFingerprint(context, source))
  const entry = await moduleEntryPath(context, source, resolved)
  const module = (await import(pathToFileURL(entry).href)) as { default?: unknown }
  return module.default as ServerExtension
}
