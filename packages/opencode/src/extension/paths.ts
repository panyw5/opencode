import path from "node:path"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { constants, realpathSync } from "node:fs"
import { Global } from "@opencode-ai/core/global"
import type { RegistryRow } from "./schema"

const INSTALL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function canonicalRegistryFile(registry: string) {
  const absolute = path.resolve(registry)
  let parent = path.dirname(absolute)
  const segments = [path.basename(absolute)]
  while (true) {
    try {
      return path.join(realpathSync(parent), ...segments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      segments.unshift(path.basename(parent))
      parent = next
    }
  }
}

export function extensionPaths(registry: string) {
  const root = path.dirname(canonicalRegistryFile(registry))
  return {
    root,
    staging: path.join(root, "staging"),
    packages: path.join(root, "packages"),
    data: path.join(Global.Path.data, "extensions", "data"),
  }
}

export function generationPath(registry: string, installId: string) {
  if (!INSTALL_ID.test(installId)) throw new Error("Invalid extension installation identity")
  return path.join(extensionPaths(registry).packages, installId)
}

export async function privateDirectory(directory: string) {
  const absolute = path.resolve(directory)
  const pending: string[] = []
  let current = absolute
  while (true) {
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error("Extension storage must not contain symbolic links")
    }
    if (!stat) pending.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const target of pending.reverse()) {
    await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)) !== target) {
      throw new Error("Extension storage must not contain symbolic links")
    }
  }
  return absolute
}

export class ManagedDevelopmentLinkError extends Error {
  override readonly name = "ManagedDevelopmentLinkError"
  constructor() {
    super("Managed extension copies cannot be used as development links; link the original source directory")
  }
}

/** Recognize host-owned generations across registry roots, including links to nested packages. */
export async function assertDevelopmentDirectory(directory: string) {
  let current = await realpath(directory)
  while (true) {
    if (INSTALL_ID.test(path.basename(current)) && path.basename(path.dirname(current)) === "packages") {
      const metadata = path.join(current, "installation.json")
      const before = await lstat(metadata).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (before) {
        const generation = await lstat(current)
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          before.size > 4096 ||
          (before.mode & 0o777) !== 0o600 ||
          !generation.isDirectory() ||
          generation.isSymbolicLink() ||
          (process.getuid && (before.uid !== process.getuid() || generation.uid !== process.getuid()))
        ) {
          throw new ManagedDevelopmentLinkError()
        }
        const handle = await open(metadata, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await handle.stat()
          if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)
            throw new ManagedDevelopmentLinkError()
          const bytes = Buffer.alloc(4097)
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
          if (bytesRead !== before.size) throw new ManagedDevelopmentLinkError()
          const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Record<string, unknown>
          if (
            value.owner === "opencode.extension-host" &&
            value.kind === "generation" &&
            value.version === 1 &&
            value.installId === path.basename(current) &&
            typeof value.operationId === "string" &&
            INSTALL_ID.test(value.operationId) &&
            typeof value.registryHash === "string" &&
            /^[a-f0-9]{64}$/.test(value.registryHash) &&
            typeof value.contentHash === "string" &&
            /^[a-f0-9]{64}$/.test(value.contentHash)
          ) {
            throw new ManagedDevelopmentLinkError()
          }
        } catch (error) {
          if (error instanceof ManagedDevelopmentLinkError) throw error
          // A malformed ownership record is not a safe development source.
          throw new ManagedDevelopmentLinkError()
        } finally {
          await handle.close()
        }
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function ownedGeneration(registry: string, row: RegistryRow) {
  if (row.source.type === "path" || !row.installId) return
  const generation = generationPath(registry, row.installId)
  const expected = path.join(generation, "package")
  if (path.resolve(row.dir) !== expected) throw new Error("Extension package is outside managed storage")
  for (const target of [extensionPaths(registry).packages, generation, expected]) {
    const stat = await lstat(target).catch(() => undefined)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)) !== target) {
      throw new Error("Extension package is not an owned installation")
    }
  }
  return generation
}
