import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { createNativeOwnershipDriver } from "./ownership-native.ts"

const MARKER = Buffer.from("opencode.extension-ownership:1\n")

/** Failure to establish or retain OS-backed ownership; callers must stop dependent work. */
export class OwnershipError extends Error {
  readonly code: "unsupported" | "unsafe" | "lost" | "io"

  constructor(code: OwnershipError["code"], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ExtensionOwnershipError"
    this.code = code
  }
}

/** The original file descriptor holds the lock, not a heartbeat, timestamp or PID file. */
export type OwnershipLease = {
  readonly mode: "shared" | "exclusive"
  /** Verify the lease and its original directory/file identity before dependent mutations. */
  assertHeld(): Promise<void>
  /** Close the lock descriptor and await release. Repeated calls share the same outcome. */
  release(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/** Nonblocking ownership result. A busy result authorizes no mutation or cleanup. */
export type OwnershipResult = { status: "busy" } | { status: "acquired"; lease: OwnershipLease }

function same(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino
}

function privateOwner(stat: Stats) {
  return (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0
}

function regular(stat: Stats) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateOwner(stat)
}

async function closeDescriptor(handle: FileHandle | undefined) {
  try {
    await handle?.close()
  } catch (cause) {
    throw new OwnershipError("io", "Extension ownership descriptor could not be closed", { cause })
  }
}

async function nativeDriver() {
  try {
    return await createNativeOwnershipDriver()
  } catch (cause) {
    throw new OwnershipError("unsupported", "Native extension ownership support could not be loaded", { cause })
  }
}

/**
 * Try a shared runtime reference or exclusive mutation guard in a host-private local directory.
 * The guard is not a lifecycle store. Never unlink or replace it to release ownership.
 * Cooperating callers must preserve its path, revalidate admission and retain the lease during dependent work.
 * @param file Absolute canonical guard path inside an existing owner-only directory.
 * @param mode Shared readers coexist; an exclusive holder excludes every other descriptor.
 * @returns A native-descriptor lease, or busy without waiting or inferring another owner's death.
 * @throws OwnershipError for unsafe paths, unknown markers or unavailable native/platform support.
 */
export async function tryAcquireOwnership(file: string, mode: OwnershipLease["mode"]): Promise<OwnershipResult> {
  if (process.platform !== "darwin") {
    throw new OwnershipError("unsupported", "Extension ownership has not been validated on this platform")
  }
  const native = await nativeDriver()
  let handle: FileHandle | undefined
  let transferred = false
  try {
    const directory = path.dirname(file)
    if (!path.isAbsolute(file) || path.resolve(file) !== file || (await realpath(directory)) !== directory) {
      throw new OwnershipError("unsafe", "Extension ownership requires a canonical private directory")
    }
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || !privateOwner(parent)) {
      throw new OwnershipError("unsafe", "Extension ownership directory is not owner-only")
    }
    handle = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600).catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ELOOP")
          throw new OwnershipError("unsafe", "Extension ownership file is a symbolic link", { cause })
        throw cause
      },
    )
    const owned = await handle.stat()
    if (!regular(owned)) throw new OwnershipError("unsafe", "Unsafe extension ownership file")

    // An empty guard needs exclusive initialization even when the requested lease is shared.
    const initializing = owned.size === 0
    if (!native.tryLock(handle.fd, !initializing && mode === "shared")) return { status: "busy" }
    const current = await handle.stat()
    if (current.size === 0) {
      if (!initializing) throw new OwnershipError("lost", "Extension ownership marker was removed")
      const { bytesWritten } = await handle.write(MARKER, 0, MARKER.length, 0)
      if (bytesWritten !== MARKER.length)
        throw new OwnershipError("io", "Extension ownership marker write was incomplete")
      await handle.sync()
    } else {
      if (current.size !== MARKER.length) throw new OwnershipError("unsafe", "Unknown extension ownership marker")
      const bytes = Buffer.alloc(MARKER.length)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== MARKER.length || !bytes.equals(MARKER)) {
        throw new OwnershipError("unsafe", "Unknown extension ownership marker")
      }
    }
    if (initializing && mode === "shared") {
      native.unlock(handle.fd)
      if (!native.tryLock(handle.fd, true)) return { status: "busy" }
    }
    const [currentPath, currentParent] = await Promise.all([lstat(file), lstat(directory)])
    if (
      !same(owned, currentPath) ||
      !regular(currentPath) ||
      !same(parent, currentParent) ||
      !privateOwner(currentParent)
    ) {
      throw new OwnershipError("lost", "Extension ownership storage was replaced")
    }

    const descriptor = handle
    let released = false
    let releasing: Promise<void> | undefined
    const release = () => {
      if (releasing) return releasing
      released = true
      releasing = closeDescriptor(descriptor).finally(() => native.close())
      return releasing
    }
    const lease: OwnershipLease = {
      mode,
      async assertHeld() {
        if (released) throw new OwnershipError("lost", "Extension ownership has been released")
        const [currentParent, current] = await Promise.all([lstat(directory), lstat(file)]).catch((cause) => {
          throw new OwnershipError("lost", "Extension ownership storage is unavailable", { cause })
        })
        if (
          released ||
          !same(parent, currentParent) ||
          !privateOwner(currentParent) ||
          !same(owned, current) ||
          !regular(current)
        ) {
          throw new OwnershipError("lost", "Extension ownership storage identity changed")
        }
      },
      release,
      [Symbol.asyncDispose]: release,
    }
    transferred = true
    return { status: "acquired", lease }
  } catch (error) {
    if (error instanceof OwnershipError) throw error
    throw new OwnershipError("io", "Extension ownership could not be established", { cause: error })
  } finally {
    if (!transferred) {
      try {
        await closeDescriptor(handle)
      } finally {
        native.close()
      }
    }
  }
}
