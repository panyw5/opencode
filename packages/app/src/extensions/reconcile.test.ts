import { describe, expect, test } from "bun:test"
import { extensionDefinition } from "./definition"
import { reconcileExtensions, type ReconcileDeps } from "./reconcile"
import type { ExtensionInfo } from "./types"

const manifest = (id: string, version: string): ExtensionInfo => ({
  id,
  version,
  displayName: id,
  enabled: true,
  state: "ready",
  activation: ["onStartup"],
  contributes: {},
  web: { base: "http://127.0.0.1:4096/asset/", entry: "index.js", styles: [], apiVersion: 1 },
})

// Minimal stand-in for the host state a reconcile pass mutates, with the same
// bookkeeping shape the provider keeps: manifests, placeholder disposables,
// last-registered definition per extension, activation failures. The manager
// stub mimics the real ExtensionActivationManager profile: deactivate removes
// the runtime and awaits the extension cleanup (parkable), activate dedups an
// already-active extension.
function harness(initial: ExtensionInfo[]) {
  const items = [...initial]
  const registered = new Map<string, string>()
  const placeholders = new Map<string, Array<() => void>>()
  const failures = new Set<string>()
  const active = new Set<string>()
  const deactivated: string[] = []
  const activated: string[] = []
  const disposed: string[] = []
  let deactivateHook: ((id: string) => Promise<void>) | undefined

  const clearPlaceholders = (id: string) => {
    for (const dispose of placeholders.get(id) ?? []) dispose()
    placeholders.delete(id)
    registered.delete(id)
  }
  const deps = (isStale: () => boolean): ReconcileDeps => ({
    manifests: () => items,
    setManifests: (next) => {
      items.splice(0, items.length, ...next)
    },
    registered,
    deactivate: async (id) => {
      deactivated.push(id)
      active.delete(id)
      if (deactivateHook) {
        const hook = deactivateHook
        deactivateHook = undefined
        await hook(id)
      }
    },
    clearPlaceholders,
    clearFailure: (id) => failures.delete(id),
    registerPlaceholders: (item) => {
      registered.set(item.id, extensionDefinition(item))
      placeholders.set(item.id, [() => disposed.push(item.id)])
    },
    activate: async (id) => {
      if (active.has(id)) return
      active.add(id)
      activated.push(id)
    },
    isStale,
  })

  return {
    items,
    registered,
    placeholders,
    failures,
    deactivated,
    activated,
    disposed,
    deps,
    park: (hook: (id: string) => Promise<void>) => {
      deactivateHook = hook
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("extension host reconcile", () => {
  test("a superseded reconcile never overwrites the newer refresh's manifests and leaves no ghost registrations", async () => {
    const h = harness([manifest("a.demo", "1.0.0")])
    await reconcileExtensions(
      [manifest("a.demo", "1.0.0")],
      h.deps(() => false),
    )

    let epoch = 1
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    h.park(async () => {
      await gate
    })
    // Refresh 1 parks inside manager.deactivate: a.demo's cleanup is in flight.
    const stale = reconcileExtensions(
      [manifest("a.demo", "2.0.0"), manifest("b.demo", "1.0.0")],
      h.deps(() => epoch !== 1),
    )
    await flush()
    expect(h.deactivated).toEqual(["a.demo"])

    // Refresh 2 (newer epoch) completes a full reconcile while refresh 1 waits.
    epoch = 2
    await reconcileExtensions(
      [manifest("a.demo", "2.0.0"), manifest("b.demo", "2.0.0"), manifest("c.demo", "1.0.0")],
      h.deps(() => false),
    )
    expect(h.items.map((item) => `${item.id}@${item.version}`)).toEqual([
      "a.demo@2.0.0",
      "b.demo@2.0.0",
      "c.demo@1.0.0",
    ])

    // Refresh 1's cleanup resolves last: the stale pass must not touch state.
    release()
    expect(await stale).toBe(false)

    // The newest list still wins.
    expect(h.items.map((item) => `${item.id}@${item.version}`)).toEqual([
      "a.demo@2.0.0",
      "b.demo@2.0.0",
      "c.demo@1.0.0",
    ])
    // No ghosts: every registration and placeholder belongs to a live manifest.
    for (const id of h.registered.keys()) expect(h.items.some((item) => item.id === id)).toBe(true)
    for (const id of h.placeholders.keys()) expect(h.items.some((item) => item.id === id)).toBe(true)
    // Only the superseded v1 placeholders were torn down — the newer v2
    // registrations survive the stale pass.
    expect(h.disposed).toEqual(["a.demo"])
    expect(h.registered.get("a.demo")).toBe(extensionDefinition(manifest("a.demo", "2.0.0")))
  })

  test("a superseded pass stops before registering or activating, leaving the old state coherent for the next refresh", async () => {
    const h = harness([manifest("a.demo", "1.0.0"), manifest("b.demo", "1.0.0")])
    await reconcileExtensions(
      [manifest("a.demo", "1.0.0"), manifest("b.demo", "1.0.0")],
      h.deps(() => false),
    )
    expect([...h.activated].sort()).toEqual(["a.demo", "b.demo"])
    const activationsBefore = h.activated.length

    let epoch = 1
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    h.park(async () => {
      await gate
    })
    const stale = reconcileExtensions(
      [manifest("a.demo", "2.0.0"), manifest("b.demo", "2.0.0")],
      h.deps(() => epoch !== 1),
    )
    await flush()
    expect(h.deactivated).toEqual(["a.demo"])

    // A newer refresh starts (safe mode flip, status event) but its manifest
    // fetch fails, so it never reconciles. The stale pass still must not
    // finish its own list on top of the half-reconciled state.
    epoch = 2
    release()
    expect(await stale).toBe(false)

    expect(h.deactivated).toEqual(["a.demo"])
    // the stale pass started no activations of its own
    expect(h.activated.length).toBe(activationsBefore)
    expect(h.items.map((item) => `${item.id}@${item.version}`)).toEqual(["a.demo@1.0.0", "b.demo@1.0.0"])
    // The just-deactivated extension keeps its current placeholders, so lazy
    // activation still resolves against the unchanged manifests.
    expect([...h.placeholders.keys()].sort()).toEqual(["a.demo", "b.demo"])
    expect(h.registered.get("a.demo")).toBe(extensionDefinition(manifest("a.demo", "1.0.0")))

    // A later successful refresh reconciles from the still-current manifests.
    const healed = await reconcileExtensions(
      [manifest("a.demo", "2.0.0"), manifest("b.demo", "2.0.0")],
      h.deps(() => false),
    )
    expect(healed).toBe(true)
    expect(h.items.map((item) => `${item.id}@${item.version}`)).toEqual(["a.demo@2.0.0", "b.demo@2.0.0"])
    expect([...h.registered.keys()].sort()).toEqual(["a.demo", "b.demo"])
    expect([...h.placeholders.keys()].sort()).toEqual(["a.demo", "b.demo"])
  })

  test("completes when current, re-runs without churn, and reports superseded before touching state", async () => {
    const h = harness([manifest("a.demo", "1.0.0"), manifest("b.demo", "1.0.0")])
    const list = [manifest("a.demo", "1.0.0"), manifest("b.demo", "2.0.0")]
    expect(
      await reconcileExtensions(
        list,
        h.deps(() => false),
      ),
    ).toBe(true)
    expect([...h.activated].sort()).toEqual(["a.demo", "b.demo"])
    expect(h.items.map((item) => `${item.id}@${item.version}`)).toEqual(["a.demo@1.0.0", "b.demo@2.0.0"])

    // A repeat pass is idempotent: no teardown, no re-registration, and the
    // already-active extensions are not re-activated.
    const before = { deactivated: h.deactivated.length, disposed: h.disposed.length, activated: h.activated.length }
    expect(
      await reconcileExtensions(
        list,
        h.deps(() => false),
      ),
    ).toBe(true)
    expect(h.deactivated.length).toBe(before.deactivated)
    expect(h.disposed.length).toBe(before.disposed)
    expect(h.activated.length).toBe(before.activated)

    // A pass that is already stale at entry bails out before any deactivation.
    const baseline = h.deactivated.length
    expect(
      await reconcileExtensions(
        [manifest("a.demo", "3.0.0")],
        h.deps(() => true),
      ),
    ).toBe(false)
    expect(h.deactivated.length).toBe(baseline)
    expect(h.items.map((item) => item.version)).toEqual(["1.0.0", "2.0.0"])
  })
})
