import { describe, expect, test } from "bun:test"
import { extensionDefinition, extensionDefinitionChanged, reconcilePlan } from "./definition"
import type { ExtensionInfo } from "./types"

const manifest = (overrides: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id: "test.viewer",
  version: "1.0.0",
  displayName: "Viewer",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {
    fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello"] }],
    commands: [{ id: "restart", title: "Restart" }],
  },
  web: { base: "http://127.0.0.1:4096/asset/", entry: "index.js", styles: [], apiVersion: 1 },
  ...overrides,
})

describe("extension definition signature", () => {
  test("is stable for the same manifest", () => {
    const item = manifest()
    expect(extensionDefinition(item)).toBe(extensionDefinition(manifest()))
    expect(extensionDefinitionChanged(item, manifest())).toBe(false)
  })

  test("detects contribution changes without a version bump", () => {
    const previous = manifest()
    const next = manifest({
      contributes: {
        fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello"] }],
        commands: [
          { id: "restart", title: "Restart" },
          { id: "reload", title: "Reload" },
        ],
      },
    })
    expect(extensionDefinitionChanged(previous, next)).toBe(true)
  })

  test("detects viewer content ownership changes without a version bump", () => {
    const previous = manifest()
    const next = manifest({
      contributes: {
        ...previous.contributes,
        fileViewers: [{ ...previous.contributes.fileViewers![0], content: "self" }],
      },
    })
    expect(extensionDefinitionChanged(previous, next)).toBe(true)
    expect(reconcilePlan([previous], [next], new Map([[previous.id, extensionDefinition(previous)]]))).toEqual({
      deactivate: [previous.id],
      register: [next],
    })
    expect(
      extensionDefinitionChanged(
        next,
        manifest({
          contributes: {
            ...next.contributes,
            fileViewers: [{ ...next.contributes.fileViewers![0], content: "text" }],
          },
        }),
      ),
    ).toBe(true)
  })

  test("detects enablement, state, version and web changes", () => {
    expect(extensionDefinitionChanged(manifest(), manifest({ enabled: false }))).toBe(true)
    expect(extensionDefinitionChanged(manifest(), manifest({ state: "error" }))).toBe(true)
    expect(extensionDefinitionChanged(manifest(), manifest({ version: "1.0.1" }))).toBe(true)
    expect(extensionDefinitionChanged(manifest(), manifest({ web: undefined }))).toBe(true)
    expect(
      extensionDefinitionChanged(
        manifest(),
        manifest({ web: { base: "http://127.0.0.1:4096/asset2/", entry: "index.js", styles: [], apiVersion: 1 } }),
      ),
    ).toBe(true)
  })

  test("ignores settings snapshots and display-only renames", () => {
    expect(extensionDefinitionChanged(manifest(), manifest({ settings: { theme: "dark" } }))).toBe(false)
    expect(extensionDefinitionChanged(manifest(), manifest({ displayName: "Renamed" }))).toBe(false)
  })

  test("detects stylesheet URL changes even when the JS entry is unchanged", () => {
    const previous = manifest()
    const next = manifest({ web: { ...previous.web!, styles: ["http://127.0.0.1:4096/asset/next.css"] } })
    expect(extensionDefinitionChanged(previous, next)).toBe(true)
    expect(reconcilePlan([previous], [next], new Map([[previous.id, extensionDefinition(previous)]]))).toEqual({
      deactivate: [previous.id],
      register: [next],
    })
  })
})

describe("reconcile plan", () => {
  const registered = (items: ExtensionInfo[]) => new Map(items.map((item) => [item.id, extensionDefinition(item)]))

  test("is idempotent for an already reconciled state", () => {
    const items = [manifest(), manifest({ id: "other.view" })]
    const plan = reconcilePlan(items, items, registered(items))
    expect(plan.deactivate).toEqual([])
    expect(plan.register).toEqual([])
    // Repeating the pass against the same state stays a no-op.
    const again = reconcilePlan(items, items, registered(items))
    expect(again.deactivate).toEqual([])
    expect(again.register).toEqual([])
  })

  test("registers only new and changed extensions", () => {
    const current = [manifest(), manifest({ id: "other.view" })]
    const changed = manifest({ version: "1.0.1" })
    const next = [changed, manifest({ id: "other.view" }), manifest({ id: "new.view" })]
    const plan = reconcilePlan(current, next, registered(current))
    expect(plan.deactivate).toEqual(["test.viewer"])
    expect(plan.register.map((item) => item.id)).toEqual(["test.viewer", "new.view"])
  })

  test("deactivates removed extensions", () => {
    const current = [manifest(), manifest({ id: "gone.view" })]
    const plan = reconcilePlan(current, [manifest()], registered(current))
    expect(plan.deactivate).toEqual(["gone.view"])
    expect(plan.register).toEqual([])
  })

  test("re-registers extensions whose placeholders were cleared explicitly", () => {
    const items = [manifest()]
    const partial = new Map<string, string>()
    partial.set("other.view", extensionDefinition(manifest({ id: "other.view" })))
    const plan = reconcilePlan(items, items, partial)
    expect(plan.deactivate).toEqual([])
    expect(plan.register.map((item) => item.id)).toEqual(["test.viewer"])
  })

  test("treats a contribution change as a full teardown, not a skip", () => {
    const current = [manifest()]
    const next = [
      manifest({
        contributes: {
          fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello", "world"] }],
          commands: [{ id: "restart", title: "Restart" }],
        },
      }),
    ]
    const plan = reconcilePlan(current, next, registered(current))
    expect(plan.deactivate).toEqual(["test.viewer"])
    expect(plan.register.map((item) => item.id)).toEqual(["test.viewer"])
  })
})
