import { readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { app, session } from "electron"
import { sidecarDataHome } from "./server-env"

export type ResourceUsageTarget = {
  id: ResourceUsageTargetId
  path: string
  bytes: number
}

export type ResourceUsageTargetId = "opencode-cache" | "opencode-logs" | "desktop-cache" | "desktop-logs"

export type ResourceUsage = {
  /** Total working set of the Electron app and its child processes, in bytes. */
  memoryBytes: number
  /** Summed CPU usage percent across all app processes (can exceed 100). */
  cpuPercent: number
  targets: ResourceUsageTarget[]
}

const CHROMIUM_CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Service Worker/CacheStorage",
]

/** Mirrors Global.Path.cache for the sidecar: $XDG_CACHE_HOME/opencode, else ~/.cache/opencode. */
function opencodeCacheDir() {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
  return join(base, "opencode")
}

function opencodeLogDir() {
  return join(sidecarDataHome({ userDataPath: app.getPath("userData") }), "opencode", "log")
}

async function measurePath(path: string): Promise<number> {
  let info
  try {
    info = await stat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, so this walk never follows them.
    if (entry.isDirectory()) total += await measurePath(join(path, entry.name))
    else if (entry.isFile())
      total += await stat(join(path, entry.name))
        .then((file) => file.size)
        .catch(() => 0)
  }
  return total
}

function appMetrics() {
  let memoryBytes = 0
  let cpuPercent = 0
  for (const metric of app.getAppMetrics()) {
    memoryBytes += metric.memory.workingSetSize * 1024
    cpuPercent += metric.cpu.percentCPUUsage
  }
  return { memoryBytes, cpuPercent }
}

async function measureTargets(): Promise<ResourceUsageTarget[]> {
  const userData = app.getPath("userData")
  const desktopCachePaths = CHROMIUM_CACHE_DIRS.map((dir) => join(userData, dir))
  const targets = [
    { id: "opencode-cache" as const, path: opencodeCacheDir() },
    { id: "opencode-logs" as const, path: opencodeLogDir() },
    { id: "desktop-cache" as const, path: userData },
    { id: "desktop-logs" as const, path: join(userData, "logs") },
  ]
  return Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      path: target.path,
      bytes:
        target.id === "desktop-cache"
          ? (
              await Promise.all(desktopCachePaths.map((path) => measurePath(path)))
            ).reduce((sum, bytes) => sum + bytes, 0)
          : await measurePath(target.path),
    })),
  )
}

export async function getResourceUsage(): Promise<ResourceUsage> {
  return { ...appMetrics(), targets: await measureTargets() }
}

export async function cleanResourceTarget(id: string): Promise<ResourceUsage | null> {
  const userData = app.getPath("userData")
  if (id === "opencode-cache") {
    await removeContents(opencodeCacheDir())
  } else if (id === "opencode-logs") {
    await removeContents(opencodeLogDir())
  } else if (id === "desktop-logs") {
    await removeContents(join(userData, "logs"))
  } else if (id === "desktop-cache") {
    await Promise.all([
      ...CHROMIUM_CACHE_DIRS.map((dir) =>
        rm(join(userData, dir), { recursive: true, force: true }).catch(() => {}),
      ),
      session.defaultSession.clearCache().catch(() => {}),
    ])
  } else {
    return null
  }
  return getResourceUsage()
}

/** Empty a directory but keep the directory itself. */
async function removeContents(path: string) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries.map((entry) =>
      rm(join(path, entry.name), { recursive: true, force: true }).catch((error) => {
        console.error(`[resource-usage] failed to remove ${join(path, entry.name)}`, error)
      }),
    ),
  )
}
