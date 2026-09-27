import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionTabs } from "@/pages/session/helpers"
import { extensionPanelTab, isExtensionPanelTab, parseExtensionPanelTab } from "./panel-tab"
import { extensionPanelTitle, getExtensionPanel, registerExtensionPanel } from "./panel-registry"

describe("extension panel tabs", () => {
  test("parses extension, panel, key and state", () => {
    expect(parseExtensionPanelTab("ext://acme.wolfram-notebook/kernels?key=a&view=list")).toEqual({
      extensionID: "acme.wolfram-notebook",
      panelID: "kernels",
      key: "a",
      state: { view: "list" },
    })
    expect(parseExtensionPanelTab("ext://acme.demo/main")).toEqual({
      extensionID: "acme.demo",
      panelID: "main",
      state: {},
    })
  })

  test("rejects malformed tab values", () => {
    expect(parseExtensionPanelTab("file://src/a.ts")).toBeUndefined()
    expect(parseExtensionPanelTab("ext://nodot/main")).toBeUndefined()
    expect(parseExtensionPanelTab("ext://Acme.demo/main")).toBeUndefined()
    expect(parseExtensionPanelTab("ext://acme.demo/")).toBeUndefined()
    expect(parseExtensionPanelTab("ext://acme.demo/Main")).toBeUndefined()
    expect(parseExtensionPanelTab("ext://acme.demo/a/b")).toBeUndefined()
    expect(parseExtensionPanelTab(`ext://${"a".repeat(60)}.demo/main`)).toBeUndefined()
  })

  test("formats tab values that round-trip", () => {
    const tab = extensionPanelTab({
      extensionID: "acme.demo",
      panelID: "main",
      key: "k 1",
      state: { z: "2", a: "x&y" },
    })
    expect(tab).toBe("ext://acme.demo/main?key=k+1&a=x%26y&z=2")
    expect(isExtensionPanelTab(tab)).toBe(true)
    expect(parseExtensionPanelTab(tab)).toEqual({
      extensionID: "acme.demo",
      panelID: "main",
      key: "k 1",
      state: { a: "x&y", z: "2" },
    })
    expect(extensionPanelTab({ extensionID: "acme.demo", panelID: "main" })).toBe("ext://acme.demo/main")
    expect(() => extensionPanelTab({ extensionID: "bad", panelID: "main" })).toThrow()
  })
})

describe("extension panel registry", () => {
  test("registers and disposes panels", () => {
    const component = () => null
    const dispose = registerExtensionPanel({ extensionID: "acme.demo", id: "main", title: "Demo", component })
    expect(getExtensionPanel("acme.demo", "main")?.component).toBe(component)
    expect(extensionPanelTitle(getExtensionPanel("acme.demo", "main")!)).toBe("Demo")
    dispose()
    expect(getExtensionPanel("acme.demo", "main")).toBeUndefined()
  })

  test("a stale disposer does not remove a newer registration", () => {
    const first = registerExtensionPanel({ extensionID: "acme.demo", id: "main", title: "A", component: () => null })
    const second = registerExtensionPanel({
      extensionID: "acme.demo",
      id: "main",
      title: () => "B",
      component: () => null,
    })
    first()
    expect(extensionPanelTitle(getExtensionPanel("acme.demo", "main")!)).toBe("B")
    second()
    expect(getExtensionPanel("acme.demo", "main")).toBeUndefined()
  })
})

describe("createSessionTabs with extension panel tabs", () => {
  test("keeps an opened extension panel tab active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "ext://acme.demo/main" as string | undefined,
        all: ["file://src/a.ts", "ext://acme.demo/main"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
      })

      expect(result.openedTabs()).toEqual(["file://src/a.ts", "ext://acme.demo/main"])
      expect(result.activeTab()).toBe("ext://acme.demo/main")
      expect(result.activeFileTab()).toBe("ext://acme.demo/main")
      dispose()
    })
  })

  test("falls back when the active extension panel tab is not opened", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "ext://acme.demo/main" as string | undefined,
        all: ["file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
      })

      expect(result.activeTab()).toBe("file://src/a.ts")
      dispose()
    })
  })
})
