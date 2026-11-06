import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { ExtensionActivationManager, ExtensionStyleLoadError, type WebExtensionModule } from "./activation"
import { createExtensionApi } from "./api"
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
    toolRenderers: [{ tool: "wolfram_eval" }],
    commands: [{ id: "restart", title: "Restart" }],
    panels: [{ id: "main", title: "Main" }],
  },
  web: {
    base: "http://127.0.0.1:4096/asset/",
    entry: "index.js",
    styles: ["http://127.0.0.1:4096/asset/index.css"],
    apiVersion: 1,
  },
})

function manager(input: { load?: () => Promise<WebExtensionModule>; style?: () => Promise<void> } = {}) {
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
      await input.style?.()
      return () => events.push("style:remove")
    },
    registerViewer: (_manifest, contribution) => {
      events.push(`viewer:add:${contribution.id}`)
      return () => events.push(`viewer:remove:${contribution.id}`)
    },
    registerToolRenderer: (_manifest, contribution) => {
      events.push(`tool:add:${contribution.tool}`)
      return () => events.push(`tool:remove:${contribution.tool}`)
    },
    registerPanel: (_manifest, contribution) => {
      events.push(`panel:add:${contribution.id}`)
      return () => events.push(`panel:remove:${contribution.id}`)
    },
    registerCommand: (_manifest, contribution) => {
      events.push(`command:add:${contribution.id}`)
      return () => events.push(`command:remove:${contribution.id}`)
    },
    callRpc: () => {
      events.push("rpc")
      return Promise.resolve(undefined)
    },
    listenEvents: (_manifest, name) => {
      events.push(`listen:${name}`)
      return () => events.push(`unlisten:${name}`)
    },
    readSetting: () => undefined,
    updateSettings: () => Promise.resolve(undefined),
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

  test("does not import or register a viewer until CSS succeeds, and can retry", async () => {
    let fail = true
    let imports = 0
    const { instance, events, dispose } = manager({
      style: async () => {
        if (fail) throw new ExtensionStyleLoadError("test.viewer", "index.css", "failed to load")
      },
      load: async () => {
        imports++
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
    try {
      await expect(instance.activate(manifest())).rejects.toBeInstanceOf(ExtensionStyleLoadError)
      expect(imports).toBe(0)
      expect(events).toEqual(["style:add"])
      expect(instance.get("test.viewer")).toBeUndefined()
      fail = false
      await instance.activate(manifest())
      expect(imports).toBe(1)
      expect(events).toEqual(["style:add", "style:add", "viewer:add:hello"])
    } finally {
      await instance.deactivate("test.viewer")
      dispose()
    }
  })

  test("drops a late activation after deactivate", async () => {
    let release: (value: WebExtensionModule) => void = () => {}
    const { instance, events, dispose } = manager({
      load: () => new Promise((resolve) => (release = resolve)),
    })
    const pending = instance.activate(manifest())
    await Promise.resolve()
    await instance.deactivate("test.viewer")
    release({
      default: {
        id: "test.viewer",
        apiVersion: 1,
        activate() {
          throw new Error("late")
        },
      },
    })
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
      registerToolRenderer: () => () => {},
      registerPanel: () => () => {},
      registerCommand: () => () => {},
      callRpc: () => Promise.resolve(undefined),
      listenEvents: () => () => {},
      readSetting: () => undefined,
      updateSettings: () => Promise.resolve(undefined),
      timeoutMs: 1,
    })
    await expect(instance.activate(manifest())).rejects.toThrow("timed out")
    await instance.deactivate("test.viewer")
    owner.dispose()
  })

  test("drops a manifest whose asset base is on another origin but keeps the rest", async () => {
    const { createExtensionApi } = await import("./api")
    const evil = manifest()
    evil.id = "evil.viewer"
    evil.web!.base = "https://evil.example/assets/"
    const api = createExtensionApi({
      globalSDK: {
        url: "http://127.0.0.1:4096",
        client: {
          extension: {
            list: async () => ({ data: [evil, manifest()] }),
          },
        },
      } as any,
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      const items = await api.list()
      expect(items.map((item) => item.id)).toEqual(["test.viewer"])
    } finally {
      console.warn = warn
    }
  })

  test("drops a manifest whose styles point at another origin", async () => {
    const { createExtensionApi } = await import("./api")
    const evil = manifest()
    evil.id = "evil.styles"
    evil.web!.styles = ["https://evil.example/assets/index.css"]
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
    const warn = console.warn
    console.warn = () => {}
    try {
      const items = await api.list()
      expect(items).toEqual([])
    } finally {
      console.warn = warn
    }
  })

  test("resolves the remaining list when one manifest is structurally invalid", async () => {
    const { createExtensionApi } = await import("./api")
    const broken = { id: "broken.viewer", web: { base: "not a url", styles: null } } as any
    const api = createExtensionApi({
      globalSDK: {
        url: "http://127.0.0.1:4096",
        client: {
          extension: {
            list: async () => ({ data: [broken, manifest()] }),
          },
        },
      } as any,
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      const items = await api.list()
      expect(items.map((item) => item.id)).toEqual(["test.viewer"])
    } finally {
      console.warn = warn
    }
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
      registerToolRenderer: () => () => {},
      registerPanel: () => () => {},
      registerCommand: () => () => {},
      callRpc: () => Promise.resolve(undefined),
      listenEvents: () => () => {},
      readSetting: () => undefined,
      updateSettings: () => Promise.resolve(undefined),
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

  test("registers declared tool renderers, panels and commands, and disposes them", async () => {
    const { instance, events, dispose } = manager({
      load: async () => ({
        default: {
          id: "test.viewer",
          apiVersion: 1,
          activate(ctx: any) {
            ctx.toolRenderers.register({ tool: "wolfram_eval", component: () => null })
            ctx.panels.register({ id: "main", component: () => null })
            ctx.commands.register({ id: "restart", run: () => {} })
          },
        },
      }),
    })
    await instance.activate(manifest())
    expect(events).toEqual(["style:add", "tool:add:wolfram_eval", "panel:add:main", "command:add:restart"])
    await instance.deactivate("test.viewer")
    expect(events).toEqual([
      "style:add",
      "tool:add:wolfram_eval",
      "panel:add:main",
      "command:add:restart",
      "command:remove:restart",
      "panel:remove:main",
      "tool:remove:wolfram_eval",
      "style:remove",
    ])
    dispose()
  })

  test("rejects undeclared tool renderers, panels and commands", async () => {
    let step: (ctx: any) => void = () => {}
    const { instance, events, dispose } = manager({
      load: async () => ({
        default: {
          id: "test.viewer",
          apiVersion: 1,
          activate(ctx: any) {
            step(ctx)
          },
        },
      }),
    })
    step = (ctx) => ctx.toolRenderers.register({ tool: "other", component: () => null })
    await expect(instance.activate(manifest())).rejects.toThrow("undeclared tool renderer")
    step = (ctx) => ctx.panels.register({ id: "other", component: () => null })
    await expect(instance.activate(manifest())).rejects.toThrow("undeclared panel")
    step = (ctx) => ctx.commands.register({ id: "other", run: () => {} })
    await expect(instance.activate(manifest())).rejects.toThrow("undeclared command")
    expect(events.every((event) => event === "style:add" || event === "style:remove")).toBe(true)
    dispose()
  })

  test("refuses to activate an extension without a web entry", async () => {
    const { instance, events, dispose } = manager()
    const serverOnly = manifest()
    serverOnly.web = { base: "http://127.0.0.1:4096/asset/", styles: [], apiVersion: 1 }
    await expect(instance.activate(serverOnly)).rejects.toThrow("no web entry")
    expect(events).toEqual([])
    dispose()
  })
})

describe("extension api setEnabled", () => {
  // Wire format the SDK returns for /global/extension/{id}/enable|disable.
  const sdkManifest = (overrides: Record<string, unknown> = {}) => ({
    id: "test.viewer",
    name: "test.viewer",
    version: "1.0.0",
    displayName: "Viewer",
    enabled: true,
    state: "ready",
    activation: [],
    contributes: {},
    permissions: [],
    web: { base: "http://127.0.0.1:4096/asset/", styles: ["http://127.0.0.1:4096/asset/index.css"], apiVersion: 1 },
    ...overrides,
  })

  function apiWith(client: Record<string, unknown>, url = "http://127.0.0.1:4096") {
    return createExtensionApi({ globalSDK: { url, client } as any })
  }

  test("posts enable and normalizes the response manifest", async () => {
    const calls: string[] = []
    const api = apiWith({
      extension: {
        enable: async ({ id }: { id: string }) => {
          calls.push(`enable:${id}`)
          return { data: sdkManifest() }
        },
        disable: async () => {
          throw new Error("disable must not be called")
        },
      },
    })
    const item = await api.setEnabled({ id: "test.viewer", enabled: true })
    expect(calls).toEqual(["enable:test.viewer"])
    expect(item.id).toBe("test.viewer")
    expect(item.enabled).toBe(true)
    expect(item.web?.base).toBe("http://127.0.0.1:4096/asset/")
    expect(item.web?.styles).toEqual(["http://127.0.0.1:4096/asset/index.css"])
  })

  test("posts disable for enabled=false", async () => {
    const calls: string[] = []
    const api = apiWith({
      extension: {
        enable: async () => {
          throw new Error("enable must not be called")
        },
        disable: async ({ id }: { id: string }) => {
          calls.push(`disable:${id}`)
          return { data: sdkManifest({ enabled: false, state: "disabled" }) }
        },
      },
    })
    const item = await api.setEnabled({ id: "test.viewer", enabled: false })
    expect(calls).toEqual(["disable:test.viewer"])
    expect(item.enabled).toBe(false)
    expect(item.state).toBe("disabled")
  })

  test("rejects with the server message when the toggle fails", async () => {
    const api = apiWith({
      extension: {
        enable: async () => ({ error: { data: { message: "extension not found" } } }),
      },
    })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("extension not found")
  })

  test("rejects a response whose data is missing", async () => {
    const api = apiWith({ extension: { enable: async () => ({}) } })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("response is unavailable")
  })

  test("rejects a response whose id does not match the request", async () => {
    const api = apiWith({ extension: { enable: async () => ({ data: sdkManifest({ id: "other.viewer" }) }) } })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("id mismatch")
  })

  test("rejects a response whose enabled flag contradicts the request", async () => {
    const api = apiWith({ extension: { enable: async () => ({ data: sdkManifest({ enabled: false }) }) } })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("enabled mismatch")
  })

  test("rejects a response with an unknown state", async () => {
    const api = apiWith({ extension: { enable: async () => ({ data: sdkManifest({ state: "detached" }) }) } })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("state is invalid")
  })

  test("accepts a known-but-unhealthy state: toggling persists even when the manifest is broken", async () => {
    const api = apiWith({
      extension: {
        enable: async () => ({ data: sdkManifest({ state: "incompatible", error: "unsupported api" }) }),
      },
    })
    const item = await api.setEnabled({ id: "test.viewer", enabled: true })
    expect(item.enabled).toBe(true)
    expect(item.state).toBe("incompatible")
  })

  test("rejects a cross-origin response manifest like a refresh would", async () => {
    const api = apiWith({
      extension: {
        enable: async () => ({
          data: sdkManifest({ web: { base: "https://evil.example/asset/", styles: [], apiVersion: 1 } }),
        }),
      },
    })
    expect(api.setEnabled({ id: "test.viewer", enabled: true })).rejects.toThrow("origin does not match")
  })
})
