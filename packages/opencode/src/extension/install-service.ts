import { createInstaller, InstallError, type InstallerOptions } from "./install"
import { ExtensionRegistry } from "./registry"
import { ExtensionRuntime } from "./runtime"
import { createRegistryObserver } from "./registry-watch"
import { publish } from "./event"
import { ExtensionWatcher } from "./watch"
import { ExtensionLeases } from "./leases"
import { createCleanup } from "./cleanup"
import { quarantineData } from "./data"
import { track } from "./drain"
import type { ExtensionID, RegistryRow } from "./schema"

const services = new Map<string, ReturnType<typeof createInstaller>>()
const coordinated = new Map<string, Map<string, RegistryRow | undefined>>()

function remember(registry: string, id: string, row: RegistryRow | undefined) {
  let rows = coordinated.get(registry)
  if (!rows) coordinated.set(registry, (rows = new Map()))
  rows.set(id, row ? structuredClone(row) : undefined)
}

async function invalidateHooks() {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ExtensionRuntime.invalidateHooks(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Extension hooks did not stop")), 10_000)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stop(id: string) {
  const release = ExtensionRuntime.beginMutation(id)
  try {
    // Invalidation owns instance finalizers; quiesce never disposes their hooks twice.
    await invalidateHooks()
    const result = await ExtensionRuntime.quiesce(id)
    if (!result.stopped) throw new InstallError("conflict", "Extension requires a server restart before replacement")
    let released = false
    return async () => {
      if (released) return
      released = true
      release()
      // Requests can initialize caches during the fence, including a first
      // install whose id is not in the registry yet. Rebuild those caches only
      // after the final pointer is visible and the new generation may load.
      await invalidateHooks()
    }
  } catch (error) {
    await ExtensionRuntime.quiesce(id, { timeoutMs: 0 }).catch(() => {})
    release()
    throw error
  }
}

export function installationCleanup(registry = ExtensionRegistry.registryFile()) {
  return createCleanup({
    registry,
    references: ExtensionLeases,
    withGeneration: (installId, run) => ExtensionRegistry.withUnreferencedGeneration(installId, run, registry),
    withPurge: (id, revision, run) => ExtensionRegistry.withPurge(id as ExtensionID, revision, run, registry),
  })
}

export async function purgeRetainedData(registry: string, id: ExtensionID, expectedRevision?: number) {
  const exclusive = await ExtensionLeases.withExclusiveData(registry, id, async () => {
    const state = await ExtensionRegistry.snapshot(id, registry)
    if (state.row || !state.retained) return { cleanupPending: true }
    const revision = expectedRevision ?? state.retained.purgeRevision ?? state.retained.revision
    if (state.retained.revision !== revision && state.retained.purgeRevision !== revision)
      return { cleanupPending: true }
    if (state.retained.purgedAt !== undefined && !state.retained.purging) return { cleanupPending: false }
    let moved: Awaited<ReturnType<typeof quarantineData>> | undefined
    const claim = await ExtensionRegistry.withPurge(
      id,
      revision,
      async (identity) => {
        moved = await quarantineData({ ...identity, id })
        return { cleanupPending: true }
      },
      registry,
    )
    if (!claim.purged || !moved) return { cleanupPending: true }
    const complete = await moved.finish()
    if (complete) await ExtensionRegistry.finishPurge(id, revision, registry)
    return { cleanupPending: !complete }
  })
  return exclusive.status === "busy" ? { cleanupPending: true } : exclusive.value
}

export async function recoverInstallations(registry = ExtensionRegistry.registryFile()) {
  const cleanup = installationCleanup(registry)
  const report = await cleanup.recover()
  const pending = await ExtensionRegistry.pendingCleanup(registry)
  for (const item of pending.slice(0, 1000)) {
    // An active operation may still be updating its cleanup receipt. Recovery
    // never competes with it and never reruns package installation/activation.
    const exclusive = await ExtensionLeases.withExclusiveOperation(registry, item.id, async () => {
      let remaining = false
      if (item.previousInstallId)
        remaining = (await cleanup.collectGeneration(item.previousInstallId)).cleanupPending || remaining
      if (item.purgeData && !item.purgeCompleted) {
        if (item.retainedRevision === undefined) remaining = true
        else
          remaining =
            (await purgeRetainedData(registry, item.extensionID, item.retainedRevision)).cleanupPending || remaining
      }
      if (!remaining) await ExtensionRegistry.finishCleanupReceipt(item.id, registry)
      return remaining
    })
    if (exclusive.status === "busy" || exclusive.value) report.cleanupPending = true
  }
  return report
}

export function installation() {
  const registry = ExtensionRegistry.registryFile()
  let service = services.get(registry)
  if (service) return service
  service = createInstaller({
    registry,
    beforeCoordinate: ({ id }) => stop(id),
    coordinate: async ({ id, row, previous, purgeData }) => {
      remember(registry, id, row)
      let cleanupPending = false
      const warnings: string[] = []
      if (previous?.installId && previous.installId !== row?.installId) {
        const collected = await installationCleanup(registry).collectGeneration(previous.installId)
        cleanupPending ||= collected.cleanupPending
        warnings.push(...collected.warnings)
      }
      if (purgeData) {
        try {
          const purged = await purgeRetainedData(registry, id)
          cleanupPending ||= purged.cleanupPending
        } catch {
          cleanupPending = true
          warnings.push("Data purge requires reconciliation")
        }
      }
      return { synced: true, cleanupPending, warnings }
    },
  })
  services.set(registry, service)
  return service
}

export type InstallationService = ReturnType<typeof installation>
export function createInstallationService(options: InstallerOptions) {
  return createInstaller({ ...options, beforeCoordinate: options.beforeCoordinate ?? (({ id }) => stop(id)) })
}

type Monitor = {
  users: number
  starting: Promise<void>
  stop(): Promise<void>
}
const monitors = new Map<string, Monitor>()

let recoverInFlight: Promise<unknown> | undefined

export async function observeInstallations() {
  const registry = ExtensionRegistry.registryFile()
  let monitor = monitors.get(registry)
  if (!monitor) {
    let previous: Record<string, RegistryRow> | undefined
    const observer = createRegistryObserver({
      file: registry,
      refresh: async () => {
        // A failed read is not an empty registry. Leave the prior snapshot
        // untouched so polling can recover without fabricating removals.
        if (ExtensionRegistry.registryFile() !== registry) return
        const { rows } = await ExtensionRegistry.snapshotAll(registry)
        if (ExtensionRegistry.registryFile() !== registry) return
        const next: Record<string, RegistryRow> = rows
        if (!previous) {
          previous = next
          return
        }
        for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
          const before = previous[id]
          const after = next[id]
          if (JSON.stringify(before) === JSON.stringify(after)) continue
          const acknowledgements = coordinated.get(registry)
          const acknowledged =
            acknowledgements?.has(id) && JSON.stringify(acknowledgements.get(id)) === JSON.stringify(after)
          if (!acknowledged) {
            const generationChanged =
              before?.installId !== after?.installId || before?.dir !== after?.dir || before?.enabled !== after?.enabled
            if (generationChanged) {
              const release = await stop(id)
              try {
                remember(registry, id, after)
              } finally {
                await release()
              }
            } else if (after) {
              await ExtensionRuntime.notifySettings(id, after.settings ?? {})
            }
          }
          publish({
            id: id as ExtensionID,
            version: after?.version ?? before!.version,
            state: after ? "changed" : "removed",
          })
        }
        await ExtensionWatcher.refresh()
        previous = next
        // Registry writes (receipts, retained tombstones) can unblock deferred
        // cleanups; re-run recovery with in-flight deduplication so a burst of
        // writes collapses into one recovery pass.
        if (!recoverInFlight) {
          recoverInFlight = track(
            recoverInstallations(registry)
              .catch(() => undefined)
              .finally(() => {
                recoverInFlight = undefined
              }),
          )
        }
      },
      onError: () => {
        // Diagnostics must not make server startup depend on a healthy registry.
      },
    })
    const entry: Monitor = { users: 0, starting: Promise.resolve(), stop: () => observer.stop() }
    // Install the shared entry before any await, including the initial read.
    monitors.set(registry, entry)
    entry.starting = (async () => {
      await recoverInstallations(registry).catch(() => {})
      previous = (await ExtensionRegistry.snapshotAll(registry).catch(() => undefined))?.rows
      await observer.start()
      // Reconcile writes between the initial snapshot and watch subscription.
      await observer.refresh().catch(() => {})
    })()
    monitor = entry
  }
  const acquired = monitor
  acquired.users++
  try {
    await acquired.starting
  } catch (error) {
    if (--acquired.users === 0 && monitors.get(registry) === acquired) {
      monitors.delete(registry)
      await acquired.stop()
    }
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    if (--acquired.users > 0) return
    if (monitors.get(registry) === acquired) monitors.delete(registry)
    await acquired.stop()
    // Recovery holds mkdir lease gates; letting a CLI process.exit() interrupt it leaves them behind forever.
    await recoverInFlight?.catch(() => undefined)
  }
}
