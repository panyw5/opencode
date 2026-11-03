import type { ExtensionInfo } from "./types"

// Stable snapshot of everything the host uses to decide whether an
// extension's UI registrations (placeholders, activations) are still valid.
// Two manifests with the same definition render identically, so a reconcile
// pass can skip re-registering them. The settings snapshot is deliberately
// excluded: it changes at runtime without affecting what the host registers.
export function extensionDefinition(item: ExtensionInfo): string {
  return JSON.stringify({
    enabled: item.enabled,
    state: item.state,
    version: item.version,
    web: item.web ? { base: item.web.base, entry: item.web.entry } : undefined,
    // Contributions are part of the change signal: a manifest can ship new
    // viewers/commands/panels without bumping its version.
    contributes: item.contributes ?? {},
  })
}

export function extensionDefinitionChanged(previous: ExtensionInfo, next: ExtensionInfo): boolean {
  return extensionDefinition(previous) !== extensionDefinition(next)
}

export type ReconcilePlan = {
  // Extensions that disappeared from the list or changed definition: their
  // activations and placeholders must be torn down before re-registering.
  deactivate: string[]
  // Extensions whose placeholders are not registered yet (new extensions, or
  // ones whose definition changed after an explicit clearPlaceholders).
  register: ExtensionInfo[]
}

// Pure planning step for the host reconcile loop, so the change-detection
// rules are unit-testable without mounting the provider.
//
// `registered` maps extension id to the definition string that was last
// registered for it. The plan is idempotent: running it against an already
// reconciled state yields empty lists, so repeated refreshes never tear down
// and rebuild every placeholder.
export function reconcilePlan(
  previous: readonly ExtensionInfo[],
  next: readonly ExtensionInfo[],
  registered: ReadonlyMap<string, string>,
): ReconcilePlan {
  const incoming = new Map(next.map((item) => [item.id, item]))
  const deactivate: string[] = []
  for (const item of previous) {
    const fresh = incoming.get(item.id)
    if (!fresh || extensionDefinitionChanged(item, fresh)) deactivate.push(item.id)
  }
  const register = next.filter((item) => registered.get(item.id) !== extensionDefinition(item))
  return { deactivate, register }
}
