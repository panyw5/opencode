import { createRequire } from "node:module"
import path from "node:path"
import { getSystemErrorName } from "node:util"
import { fileURLToPath } from "node:url"

/** Whole-file descriptor locks shared by the Node/Electron and Bun adapters. */
export type NativeOwnershipDriver = {
  tryLock(fd: number, shared: boolean): boolean
  unlock(fd: number): void
  close(): void
}

type Binding = {
  tryLock(fd: number, offset: number, length: number, exclusive: boolean): void
  unlock(fd: number, offset: number, length: number): void
}

/**
 * Load the BSD flock protocol used by both runtimes on macOS.
 * Bun calls libSystem directly because its NAPI libuv descriptor/error adapters are unavailable.
 * @returns A descriptor-lock driver whose library must remain loaded until its lease is released.
 * @throws When the pinned prebuild, C symbols or Node addon ABI cannot be loaded.
 */
export async function createNativeOwnershipDriver(): Promise<NativeOwnershipDriver> {
  if (process.platform !== "darwin")
    throw new Error("Native descriptor ownership requires a validated platform adapter")
  if (process.versions.bun) {
    const { dlopen, read } = await import("bun:ffi")
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: ["i32", "i32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    })
    function status(result: number) {
      if (result === 0) return true
      const pointer = library.symbols.__error()
      if (!pointer) throw new Error("Native extension ownership errno is unavailable")
      const code = getSystemErrorName(-read.i32(pointer))
      if (code === "EAGAIN") return false
      throw new Error(`Native extension ownership operation failed: ${code}`)
    }
    return {
      // LOCK_SH=1, LOCK_EX=2, LOCK_NB=4 and LOCK_UN=8 are macOS flock protocol constants.
      tryLock: (fd, shared) => status(library.symbols.flock(fd, (shared ? 1 : 2) | 4)),
      unlock(fd) {
        if (!status(library.symbols.flock(fd, 8))) throw new Error("Native extension ownership unlock was refused")
      },
      close: () => library.close(),
    }
  }
  // Resolve through this prototype's dependencies, including when bundled into a temporary probe.
  const manifest = fileURLToPath(import.meta.resolve("fs-native-extensions/package.json"))
  const require = createRequire(manifest)
  const binary = path.join(
    path.dirname(manifest),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "fs-native-extensions.node",
  )
  // Select the pinned NAPI prebuild explicitly for both Node and Electron.
  const value: unknown = require(binary)
  if (
    !value ||
    typeof value !== "object" ||
    !("tryLock" in value) ||
    typeof value.tryLock !== "function" ||
    !("unlock" in value) ||
    typeof value.unlock !== "function"
  ) {
    throw new Error("Native extension ownership binding has no descriptor-lock functions")
  }
  const binding = value as Binding
  return {
    tryLock(fd, shared) {
      try {
        binding.tryLock(fd, 0, 0, !shared)
        return true
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EAGAIN") return false
        throw error
      }
    },
    unlock: (fd) => binding.unlock(fd, 0, 0),
    // The Node addon loader owns its library mapping for the runtime's lifetime.
    close: () => undefined,
  }
}
