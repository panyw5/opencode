import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import {
  declaredCommand,
  declaredPanel,
  declaredToolRenderer,
  declaredViewer,
  extensionCommandID,
  extensionViewerID,
  makeExtensionContext,
} from "./context"
import type { Disposable, ExtensionInfo } from "./types"

const manifest = (): ExtensionInfo => ({
  id: "acme.demo",
  version: "1.0.0",
  displayName: "Demo",
  enabled: true,
  state: "ready",
  activation: ["onTool:wolfram_eval", "onCommand:restart", "onPanel:main"],
  contributes: {
    fileViewers: [{ id: "hello", title: "Hello" }],
    toolRenderers: [{ tool: "wolfram_eval" }],
    commands: [{ id: "restart", title: "Restart", category: "Wolfram", keybind: "mod+r", slash: "restart" }],
    panels: [{ id: "main", title: "Main", icon: "layout-right" }],
    settings: { path: { type: "string", title: "Path", default: "" } },
  },
  web: { base: "http://127.0.0.1:4096/asset/", entry: "index.js", styles: [], apiVersion: 1 },
})

function context(input: { manifest?: ExtensionInfo; valid?: () => boolean } = {}) {
  const events: string[] = []
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    const subscriptions: Disposable[] = []
    const ctx = makeExtensionContext({
      manifest: input.manifest ?? manifest(),
      owner,
      valid: input.valid ?? (() => true),
      subscriptions,
      registerViewer: (contribution) => {
        events.push(`viewer:add:${contribution.id}`)
        return () => events.push(`viewer:remove:${contribution.id}`)
      },
      registerToolRenderer: (contribution) => {
        events.push(`tool:add:${contribution.tool}`)
        return () => events.push(`tool:remove:${contribution.tool}`)
      },
      registerPanel: (contribution) => {
        events.push(`panel:add:${contribution.id}`)
        return () => events.push(`panel:remove:${contribution.id}`)
      },
      registerCommand: (contribution) => {
        events.push(`command:add:${contribution.id}`)
        return () => events.push(`command:remove:${contribution.id}`)
      },
      callRpc: () => {
        events.push("rpc")
        return Promise.resolve(undefined)
      },
      listenEvents: (name) => {
        events.push(`listen:${name}`)
        return () => events.push(`unlisten:${name}`)
      },
      readSetting: () => undefined,
      updateSettings: () => Promise.resolve(undefined),
    })
    return { ctx, events, subscriptions, dispose }
  })
}

describe("contribution declaration helpers", () => {
  test("resolves declared contributions and global ids", () => {
    const item = manifest()
    expect(extensionViewerID(item.id, "hello")).toBe("ext.acme.demo.hello")
    expect(extensionCommandID(item.id, "restart")).toBe("ext.acme.demo.restart")
    expect(declaredViewer(item, "hello")?.title).toBe("Hello")
    expect(declaredToolRenderer(item, "wolfram_eval")).toEqual({ tool: "wolfram_eval" })
    expect(declaredPanel(item, "main")?.title).toBe("Main")
    expect(declaredCommand(item, "restart")?.keybind).toBe("mod+r")
    expect(declaredViewer(item, "missing")).toBeUndefined()
    expect(declaredToolRenderer(item, "other")).toBeUndefined()
    expect(declaredPanel(item, "other")).toBeUndefined()
    expect(declaredCommand(item, "other")).toBeUndefined()
  })

  test("tolerates manifests without the P2 contribution blocks", () => {
    const item = manifest()
    item.contributes = { fileViewers: [{ id: "hello", title: "Hello" }] }
    expect(declaredToolRenderer(item, "wolfram_eval")).toBeUndefined()
    expect(declaredPanel(item, "main")).toBeUndefined()
    expect(declaredCommand(item, "restart")).toBeUndefined()
    expect(item.contributes.settings).toBeUndefined()
  })
})

describe("extension context contribution registries", () => {
  test("registers declared contributions and disposes them in reverse", () => {
    const root = context()
    const { ctx, events, subscriptions, dispose } = root
    const viewer = ctx.fileViewers.register({ id: "hello", component: () => null })
    const tool = ctx.toolRenderers.register({ tool: "wolfram_eval", component: () => null })
    const panel = ctx.panels.register({ id: "main", component: () => null })
    const command = ctx.commands.register({ id: "restart", run: () => {} })
    expect(events).toEqual(["viewer:add:hello", "tool:add:wolfram_eval", "panel:add:main", "command:add:restart"])
    expect(subscriptions.length).toBe(4)
    command.dispose()
    panel.dispose()
    tool.dispose()
    viewer.dispose()
    expect(events).toEqual([
      "viewer:add:hello",
      "tool:add:wolfram_eval",
      "panel:add:main",
      "command:add:restart",
      "command:remove:restart",
      "panel:remove:main",
      "tool:remove:wolfram_eval",
      "viewer:remove:hello",
    ])
    dispose()
  })

  test("disposes a contribution only once during cleanup", () => {
    const { ctx, events, subscriptions, dispose } = context()
    const item = ctx.commands.register({ id: "restart", run: () => {} })
    item.dispose()
    item.dispose()
    for (const subscription of subscriptions) subscription.dispose()
    expect(events).toEqual(["command:add:restart", "command:remove:restart"])
    dispose()
  })

  test("rejects undeclared contributions without registering", () => {
    const root = context()
    const { ctx, events, dispose } = root
    expect(() => ctx.toolRenderers.register({ tool: "other", component: () => null })).toThrow(
      "undeclared tool renderer",
    )
    expect(() => ctx.panels.register({ id: "other", component: () => null })).toThrow("undeclared panel")
    expect(() => ctx.commands.register({ id: "other", run: () => {} })).toThrow("undeclared command")
    expect(() => ctx.fileViewers.register({ id: "other", component: () => null })).toThrow("undeclared file viewer")
    expect(events).toEqual([])
    dispose()
  })

  test("rejects registrations after the activation goes stale", () => {
    let valid = true
    const root = context({ valid: () => valid })
    const { ctx, events, dispose } = root
    ctx.commands.register({ id: "restart", run: () => {} })
    valid = false
    expect(() => ctx.commands.register({ id: "restart", run: () => {} })).toThrow("stale")
    expect(events).toEqual(["command:add:restart"])
    dispose()
  })

  test("exposes identity, version, assets and string-only logging", () => {
    const root = context()
    const { ctx, dispose } = root
    expect(ctx.id).toBe("acme.demo")
    expect(ctx.version).toBe("1.0.0")
    expect(ctx.assets.url("dist/web/icon.svg")).toBe("http://127.0.0.1:4096/asset/dist/web/icon.svg")
    expect(() => ctx.assets.url("http://evil.example/icon.svg")).toThrow("origin mismatch")
    const messages: string[] = []
    const info = console.info
    console.info = (message: string) => messages.push(message)
    try {
      ctx.log.info("hello")
    } finally {
      console.info = info
    }
    expect(messages).toEqual(["[ext:acme.demo] hello"])
    dispose()
  })
})
