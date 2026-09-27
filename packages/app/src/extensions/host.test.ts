import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { ExtensionActivationManager, type WebExtensionModule } from "./activation"
import { declaredViewer, extensionViewerID } from "./context"
import { safeModeFromURL } from "./safe-mode"
import type { ExtensionInfo } from "./types"

const manifest = (): ExtensionInfo => ({
  id: "test.viewer",
  version: "1.0.0",
  displayName: "Viewer",
  enabled: true,
  state: "ready",
  activation: ["onFileViewer:hello"],
  contributes: {
    fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello"], mode: "replace" }],
  },
  web: { base: "http://127.0.0.1:4096/asset/", entry: "index.js", styles: ["http://127.0.0.1:4096/asset/index.css"], apiVersion: 1 },
})

function manager(input: { load?: () => Promise<WebExtensionModule> } = {}) {
  const events: string[] = []
  const owner = createRoot((dispose) => {
    const current = getOwner()
    if (!current) throw new Error("owner required")
    return { current, dispose }
  })
  const instance = new ExtensionActivationManager({
    hostOwner: owner.current,
    importModule: input.load ?? (async () => ({ default: { id: "test.viewer", apiVersion: 1, activate() {} } })),
    addStyle: async () => {
      events.push("style:add")
      return () => events.push("style:remove")
    },
    registerViewer: (_manifest, contribution) => {
      events.push(`viewer:add:${contribution.id}`)
      return () => events.push(`viewer:remove:${contribution.id}`)
    },
  })
  return { instance, events, dispose: owner.dispose }
}

describe("extension host helpers", () => {
  test("names viewer ids globally and resolves declared viewers", () => {
    const item = manifest()
    expect(extensionViewerID(item.id, "hello")).toBe("ext.test.viewer.hello")
    expect(declaredViewer(item, "hello")?.title).toBe("Hello")
    expect(declaredViewer(item, "missing")).toBeUndefined()
  })

  test("resolves explicit and persisted safe mode", () => {
    expect(safeModeFromURL("?extensions=off", false)).toEqual({ disabled: true, persist: true })
    expect(safeModeFromURL("?extensions=on", true)).toEqual({ disabled: false, persist: true })
    expect(safeModeFromURL("", true)).toEqual({ disabled: true, persist: false })
  })

  test("deduplicates concurrent activation and removes styles on deactivate", async () => {
    let loads = 0
    const { instance, events, dispose } = manager({
      load: async () => {
        loads++
        return {
          default: {
            id: "test.viewer",
            apiVersion: 1,
            activate(ctx: any) {
              ctx.fileViewers.register({ id: "hello", component: () => null })
            },
          },
        }
      },
    })
    await Promise.all([instance.activate(manifest()), instance.activate(manifest())])
    expect(loads).toBe(1)
    expect(events).toEqual(["style:add", "viewer:add:hello"])
    await instance.deactivate("test.viewer")
    expect(events).toEqual(["style:add", "viewer:add:hello", "viewer:remove:hello", "style:remove"])
    dispose()
  })

  test("rejects undeclared viewers without leaking styles", async () => {
    const { instance, events, dispose } = manager({
      load: async () => ({
        default: {
          id: "test.viewer",
          apiVersion: 1,
          activate(ctx: any) {
            ctx.fileViewers.register({ id: "other", component: () => null })
          },
        },
      }),
    })
    await expect(instance.activate(manifest())).rejects.toThrow("undeclared")
    await instance.deactivate("test.viewer")
    expect(events).toEqual(["style:add", "style:remove"])
    dispose()
  })

  test("drops a late activation after deactivate", async () => {
    let release: (value: WebExtensionModule) => void = () => {}
    const { instance, events, dispose } = manager({
      load: () => new Promise((resolve) => (release = resolve)),
    })
    const pending = instance.activate(manifest())
    await Promise.resolve()
    await instance.deactivate("test.viewer")
    release({ default: { id: "test.viewer", apiVersion: 1, activate() { throw new Error("late") } } })
    await pending
    expect(events).toEqual(["style:add", "style:remove"])
    dispose()
  })

  test("does not reactivate an already active extension", async () => {
    let loads = 0
    const { instance, dispose } = manager({
      load: async () => {
        loads++
        return { default: { id: "test.viewer", apiVersion: 1, activate() {} } }
      },
    })
    await instance.activate(manifest())
    await instance.activate(manifest())
    expect(loads).toBe(1)
    await instance.deactivate("test.viewer")
    dispose()
  })

  test("times out a stalled activate callback", async () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const instance = new ExtensionActivationManager({
      hostOwner: owner.current,
      importModule: async () => ({
        default: { id: "test.viewer", apiVersion: 1, activate: () => new Promise(() => {}) },
      }),
      addStyle: async () => () => {},
      registerViewer: () => () => {},
      timeoutMs: 1,
    })
    await expect(instance.activate(manifest())).rejects.toThrow("timed out")
    await instance.deactivate("test.viewer")
    owner.dispose()
  })

  test("rejects an extension asset base on another origin", async () => {
    const { createExtensionApi } = await import("./api")
    const evil = manifest()
    evil.web!.base = "https://evil.example/assets/"
    const api = createExtensionApi({
      globalSDK: {
        url: "http://127.0.0.1:4096",
        client: {
          extension: {
            list: async () => ({ data: [evil] }),
          },
        },
      } as any,
    })
    await expect(api.list()).rejects.toThrow("does not match server")
  })

  test("continues cleanup when one subscription disposer throws", async () => {
    const events: string[] = []
    const owner = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const instance = new ExtensionActivationManager({
      hostOwner: owner.current,
      importModule: async () => ({
        default: {
          id: "test.viewer",
          apiVersion: 1,
          activate(ctx: any) {
            ctx.fileViewers.register({ id: "hello", component: () => null })
          },
        },
      }),
      addStyle: async () => () => events.push("style:remove"),
      registerViewer: () => () => {
        events.push("viewer:dispose")
        throw new Error("dispose failed")
      },
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      await instance.activate(manifest())
      await instance.deactivate("test.viewer")
    } finally {
      console.warn = warn
      owner.dispose()
    }
    expect(events).toEqual(["viewer:dispose", "style:remove"])
  })

  test("normalizes extension asset URLs against the server", async () => {
    const { createExtensionApi } = await import("./api")
    const api = createExtensionApi({
      globalSDK: {
        url: "http://127.0.0.1:4096",
        client: {
          extension: {
            list: async () => ({ data: [manifest()] }),
          },
        },
      } as any,
    })
    const [item] = await api.list()
    expect(item?.web?.base).toBe("http://127.0.0.1:4096/asset/")
    expect(item?.web?.styles).toEqual(["http://127.0.0.1:4096/asset/index.css"])
  })
})
