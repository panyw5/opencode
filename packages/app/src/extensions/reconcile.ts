import { reconcilePlan } from "./definition"
import type { ExtensionInfo } from "./types"

export type ReconcileDeps = {
  manifests(): readonly ExtensionInfo[]
  setManifests(next: ExtensionInfo[]): void
  registered: ReadonlyMap<string, string>
  deactivate(id: string): Promise<void>
  clearPlaceholders(id: string): void
  clearFailure(id: string): void
  registerPlaceholders(item: ExtensionInfo): void
  activate(id: string): Promise<void>
  isStale(): boolean
}

// Deactivation can wait on extension cleanup while a newer refresh completes.
// A superseded pass must not clear newer registrations or overwrite its list.
export async function reconcileExtensions(next: ExtensionInfo[], deps: ReconcileDeps): Promise<boolean> {
  if (deps.isStale()) return false
  const plan = reconcilePlan(deps.manifests(), next, deps.registered)
  for (const id of plan.deactivate) {
    await deps.deactivate(id)
    if (deps.isStale()) return false
    deps.clearPlaceholders(id)
    const fresh = next.find((item) => item.id === id)
    if (fresh && fresh.enabled && fresh.state === "ready") deps.clearFailure(id)
  }
  if (deps.isStale()) return false
  deps.setManifests(next)
  for (const item of plan.register) deps.registerPlaceholders(item)
  if (deps.isStale()) return false
  await Promise.all(next.filter((item) => item.activation.includes("onStartup")).map((item) => deps.activate(item.id)))
  return !deps.isStale()
}
