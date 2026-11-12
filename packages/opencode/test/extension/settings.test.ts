import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import type { InstanceContext } from "../../src/project/instance-context"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { emit, emitTo } from "../../src/extension/event"
import { ExtensionRegistry, SECRET_MASK, SettingsError } from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"
import { extensionPackage } from "./fixture"
import { tmpdir } from "../fixture/fixture"

const registry = path.join(process.env.TMPDIR ?? "/tmp", `oc-ext-settings-${process.pid}.json`)
const id = ExtensionID.make("test.extension")

const settings = {
  apiKey: { type: "string", title: "API Key", default: "", secret: true },
  mode: { type: "string", title: "Mode", enum: ["always", "never"], default: "always" },
  limit: { type: "number", title: "Limit", default: 3 },
  verbose: { type: "boolean", title: "Verbose", default: false },
}

afterEach(() => rm(registry, { force: true }))

async function collectEvents() {
  const events: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => events.push(event)
  GlobalBus.on("event", listener)
  return {
    events,
    stop: () => GlobalBus.off("event", listener),
  }
}

describe("extension settings", () => {
  test("resolves defaults on link, stores plaintext and masks secrets in info", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })

    const linked = await ExtensionRegistry.link(extension, undefined, registry)
    expect(linked.settings).toEqual({ apiKey: "", mode: "always", limit: 3, verbose: false })

    const updated = await ExtensionRegistry.updateSettings(id, { apiKey: "sk-live-123", limit: 5 }, undefined, registry)
    expect(updated.settings).toEqual({ apiKey: SECRET_MASK, mode: "always", limit: 5, verbose: false })
    expect(updated.state).toBe("ready")

    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].settings).toEqual({ apiKey: "sk-live-123", limit: 5 })

    const read = await ExtensionRegistry.get(id, undefined, registry)
    expect(read.settings?.apiKey).toBe(SECRET_MASK)
    expect(read.settings?.limit).toBe(5)
  })

  test("rejects unknown keys, type mismatches and off-enum values", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)

    await expect(ExtensionRegistry.updateSettings(id, { nope: 1 }, undefined, registry)).rejects.toThrow(
      'Unknown extension setting "test.extension:nope"',
    )
    await expect(ExtensionRegistry.updateSettings(id, { apiKey: 5 }, undefined, registry)).rejects.toThrow(
      new SettingsError('Extension setting "test.extension:apiKey" must be a string'),
    )
    await expect(ExtensionRegistry.updateSettings(id, { limit: "many" }, undefined, registry)).rejects.toThrow(
      "must be a finite number",
    )
    await expect(
      ExtensionRegistry.updateSettings(id, { limit: Number.POSITIVE_INFINITY }, undefined, registry),
    ).rejects.toThrow("must be a finite number")
    await expect(ExtensionRegistry.updateSettings(id, { verbose: "yes" }, undefined, registry)).rejects.toThrow(
      "must be a boolean",
    )
    await expect(ExtensionRegistry.updateSettings(id, { mode: "sometimes" }, undefined, registry)).rejects.toThrow(
      "must be one of",
    )

    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].settings).toBeUndefined()
  })

  test("submitting the secret mask keeps the stored value", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    await ExtensionRegistry.updateSettings(id, { apiKey: "sk-live-123" }, undefined, registry)

    const updated = await ExtensionRegistry.updateSettings(id, { apiKey: SECRET_MASK }, undefined, registry)
    expect(updated.settings?.apiKey).toBe(SECRET_MASK)
    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].settings.apiKey).toBe("sk-live-123")
  })

  test("undefined removes a stored value so the default applies again", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    await ExtensionRegistry.updateSettings(id, { limit: 9 }, undefined, registry)

    const updated = await ExtensionRegistry.updateSettings(id, { limit: undefined }, undefined, registry)
    expect(updated.settings?.limit).toBe(3)
    const stored = await Bun.file(registry).json()
    // The last stored value is gone, so the row carries no settings at all.
    expect(stored.extensions["test.extension"].settings?.limit).toBeUndefined()
  })

  test("preserves settings across relink", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    await ExtensionRegistry.updateSettings(id, { apiKey: "sk-live-123", mode: "never" }, undefined, registry)

    const relinked = await ExtensionRegistry.link(extension, undefined, registry)
    expect(relinked.settings).toEqual({
      apiKey: SECRET_MASK,
      mode: "never",
      limit: 3,
      verbose: false,
    })
    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].settings.mode).toBe("never")
  })

  test("publishes extension.status changed after saving", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    const subscription = await collectEvents()
    try {
      await ExtensionRegistry.updateSettings(id, { limit: 4 }, undefined, registry)
      const status = subscription.events
        .map((event) => event.payload)
        .filter((payload) => payload.type === "extension.status")
      expect(status).toEqual([
        {
          id: expect.any(String),
          type: "extension.status",
          properties: { id, version: "1.2.3", state: "changed" },
        },
      ])
    } finally {
      subscription.stop()
    }
  })

  test("rejects settings for unknown extension ids", async () => {
    await Bun.write(registry, JSON.stringify({ version: 1, extensions: {} }))
    await expect(
      ExtensionRegistry.updateSettings(ExtensionID.make("test.missing"), { limit: 1 }, undefined, registry),
    ).rejects.toThrow("Extension not found")
  })

  test("does not disclose settings removed from the manifest", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    await ExtensionRegistry.updateSettings(id, { apiKey: "sk-live-123" }, undefined, registry)
    const manifest = path.join(extension, "package.json")
    const pkg = await Bun.file(manifest).json()
    delete pkg.opencode.contributes.settings.apiKey
    await Bun.write(manifest, JSON.stringify(pkg))

    const read = await ExtensionRegistry.get(id, undefined, registry)
    expect(read.settings?.apiKey).toBeUndefined()
    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].settings.apiKey).toBe("sk-live-123")
  })

  test("hides stored settings when the manifest is unreadable", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { settings })
    await ExtensionRegistry.link(extension, undefined, registry)
    await ExtensionRegistry.updateSettings(id, { apiKey: "sk-live-123" }, undefined, registry)
    await Bun.write(path.join(extension, "package.json"), "{}")

    const read = await ExtensionRegistry.get(id, undefined, registry)
    expect(read.state).toBe("error")
    expect(read.settings).toEqual({})
  })

  test("server-only extensions link without web info and keep settings", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, {
      webExport: null,
      webManifest: false,
      serverEntry: "dist/server/index.js",
      settings,
    })

    const linked = await ExtensionRegistry.link(extension, undefined, registry)
    expect(linked.web).toBeUndefined()
    expect(linked.settings).toEqual({ apiKey: "", mode: "always", limit: 3, verbose: false })

    const updated = await ExtensionRegistry.updateSettings(id, { mode: "never" }, undefined, registry)
    expect(updated.state).toBe("ready")
    expect(updated.web).toBeUndefined()
    expect(updated.settings?.mode).toBe("never")
  })
})

describe("extension custom events", () => {
  test("emit broadcasts extension.event globally", async () => {
    const subscription = await collectEvents()
    try {
      emit({ id, name: "kernel.restart", data: { ok: true } })
      const payload = subscription.events.find((event) => event.payload.type === "extension.event")?.payload
      expect(payload).toEqual({
        id: expect.any(String),
        type: "extension.event",
        properties: { id, name: "kernel.restart", data: { ok: true } },
      })
      expect(subscription.events.find((event) => event.payload.type === "extension.event")?.directory).toBe("global")
    } finally {
      subscription.stop()
    }
  })

  test("emitTo routes extension.event through the instance bus", async () => {
    const subscription = await collectEvents()
    try {
      const ctx = {
        directory: "/tmp/oc-ext-settings-instance",
        directoryKey: "/tmp/oc-ext-settings-instance",
        nativeDirectory: "/tmp/oc-ext-settings-instance",
        worktree: "/tmp/oc-ext-settings-instance",
        project: { id: "test-project" },
        location: {},
      } as unknown as InstanceContext
      await emitTo(ctx, { id, name: "kernel.progress", data: 42 })
      const event = subscription.events.find((item) => item.payload.type === "extension.event")
      expect(event?.directory).toBe("/tmp/oc-ext-settings-instance")
      expect(event?.project).toBe("test-project")
      expect(event?.payload.properties).toEqual({ id, name: "kernel.progress", data: 42 })
    } finally {
      subscription.stop()
    }
  })
})
