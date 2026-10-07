import { describe, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
// Registers the Solid JSX loader for Bun before any app module is imported;
// must stay the first import of this file.
import "./solid-form-loader"
import type { ExtensionInfo } from "../../src/extensions/types"
import type { SaveExtensionSettings } from "../../src/pages/config-extension-settings"

// Browser-condition contract tests for the migrated config extension settings
// section (packages/app/src/pages/config-extension-settings.tsx). The real
// production component is rendered with the language and save bridge injected
// through its optional test seams; no global mocks are installed.
const { ConfigExtensionSettings } = await import("../../src/pages/config-extension-settings")

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const definitions = {
  host: { type: "string", title: "Endpoint", description: "Server URL" },
  port: { type: "number", title: "Port" },
  enabled: { type: "boolean", title: "Enabled" },
  mode: { type: "string", title: "Mode", enum: ["fast", "slow"] },
  token: { type: "string", title: "Token", secret: true },
} as const

const makeItem = (over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id: "acme.demo",
  version: "1.2.3",
  displayName: "Acme Demo",
  enabled: true,
  state: "ready",
  activation: [],
  settings: {},
  contributes: { settings: { ...definitions } },
  ...over,
})

const language = {
  t: (key: string) => key.split(".").at(-1) ?? key,
}

function mount(
  item: () => ExtensionInfo,
  saveSettings?: SaveExtensionSettings,
  options: { disabled?: boolean; onStateChange?: (state: { dirty: boolean; saving: boolean }) => void } = {},
) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () =>
      createComponent(ConfigExtensionSettings, {
        get item() {
          return item()
        },
        language,
        ...options,
        saveSettings:
          saveSettings ??
          (() => {
            throw new Error("unexpected save call")
          }),
      }),
    container,
  )
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const input = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)

const typeInto = (el: HTMLInputElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

const saveButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-action="settings-extensions-save"]')

const checkbox = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLInputElement>(`[data-setting-key="${key}"] input[type="checkbox"]`)

describe("ConfigExtensionSettings section", () => {
  test("reports only dirty and saving state and permits discarding edits", async () => {
    const states: Array<{ dirty: boolean; saving: boolean }> = []
    const { container, dispose } = mount(() => makeItem(), undefined, { onStateChange: (state) => states.push(state) })
    try {
      typeInto(input(container, "Endpoint")!, "unsaved")
      await tick()
      expect(states.at(-1)).toEqual({ dirty: true, saving: false })
      container.querySelector<HTMLButtonElement>('[data-action="extension-settings-discard"]')!.click()
      await tick()
      expect(input(container, "Endpoint")!.value).toBe("")
      expect(states.at(-1)).toEqual({ dirty: false, saving: false })
    } finally {
      dispose()
    }
  })

  test("invalid numeric edits still report dirty and can be discarded", async () => {
    const states: Array<{ dirty: boolean; saving: boolean }> = []
    const { container, dispose } = mount(() => makeItem(), undefined, { onStateChange: (state) => states.push(state) })
    try {
      typeInto(input(container, "Port")!, "1e999")
      await tick()
      expect(saveButton(container)?.disabled).toBe(true)
      expect(states.at(-1)?.dirty).toBe(true)
      const cancel = container.querySelector<HTMLButtonElement>('[data-action="extension-settings-discard"]')!
      expect(cancel.disabled).toBe(false)
      cancel.click()
      await tick()
      expect(states.at(-1)?.dirty).toBe(false)
    } finally {
      dispose()
    }
  })

  test("blocks saving while extension management is busy", () => {
    const { container, dispose } = mount(() => makeItem(), undefined, { disabled: true })
    try {
      expect(container.querySelector("fieldset")?.disabled).toBe(true)
      expect(saveButton(container)?.disabled).toBe(true)
    } finally {
      dispose()
    }
  })

  test("renders one row per manifest definition with explicit aria labels", () => {
    const { container, dispose } = mount(() => makeItem())
    expect(container.querySelector<HTMLElement>("[data-extension-id]")?.getAttribute("data-extension-id")).toBe(
      "acme.demo",
    )
    const keys = [...container.querySelectorAll("[data-setting-key]")].map((row) =>
      row.getAttribute("data-setting-key"),
    )
    expect(keys).toEqual(["host", "port", "enabled", "mode", "token"])
    expect(input(container, "Endpoint")).not.toBeNull()
    expect(input(container, "Port")).not.toBeNull()
    expect(input(container, "Token")?.type).toBe("password")
    expect(checkbox(container, "enabled")).not.toBeNull()
    expect(container.querySelector('button[aria-label="Mode"]')).not.toBeNull()
    // Nothing changed yet: save is disabled.
    expect(saveButton(container)?.disabled).toBe(true)
    dispose()
  })

  test("saves the built patch without untouched secrets, then re-baselines from the response", async () => {
    const calls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const [manifest, setManifest] = createSignal(makeItem())
    // Mirrors the host bridge: the PATCH response becomes the authoritative
    // snapshot and the manifest is swapped in place.
    const saveSettings: SaveExtensionSettings = (id, patch) => {
      calls.push({ id, patch })
      const fresh = makeItem({ settings: { ...manifest().settings, ...patch } })
      setManifest(fresh)
      return Promise.resolve(fresh)
    }
    const { container, dispose } = mount(() => manifest(), saveSettings)

    typeInto(input(container, "Endpoint")!, "https://example.com")
    expect(saveButton(container)?.disabled).toBe(false)
    checkbox(container, "enabled")!.click()
    typeInto(input(container, "Port")!, "8080")
    saveButton(container)!.click()
    await tick()
    await tick()

    expect(calls).toEqual([{ id: "acme.demo", patch: { host: "https://example.com", port: 8080, enabled: true } }])
    // The server snapshot rebaselines the form: no pending patch left.
    expect(saveButton(container)?.disabled).toBe(true)
    expect(input(container, "Endpoint")!.value).toBe("https://example.com")
    expect(input(container, "Token")!.value).toBe("")
    dispose()
  })

  test("a touched then cleared secret sends null instead of being skipped", async () => {
    const calls: Array<{ id: string; patch: Record<string, unknown> }> = []
    const saveSettings: SaveExtensionSettings = (id, patch) => {
      calls.push({ id, patch })
      return Promise.resolve(makeItem({ settings: { ...patch } }))
    }
    const { container, dispose } = mount(() => makeItem(), saveSettings)

    typeInto(input(container, "Token")!, "abc")
    typeInto(input(container, "Token")!, "")
    saveButton(container)!.click()
    await tick()
    await tick()
    expect(calls).toEqual([{ id: "acme.demo", patch: { token: null } }])
    dispose()
  })

  test("replaces local edits with a fresh server snapshot when the manifest updates", async () => {
    const [item, setItem] = createSignal(makeItem())
    const { container, dispose } = mount(() => item())

    typeInto(input(container, "Endpoint")!, "local-draft")
    expect(saveButton(container)?.disabled).toBe(false)
    setItem(makeItem({ settings: { host: "server-b" } }))
    await tick()
    await tick()
    expect(input(container, "Endpoint")!.value).toBe("server-b")
    expect(saveButton(container)?.disabled).toBe(true)
    dispose()
  })

  test("a save resolving after the section switched extensions does not re-baseline the new extension", async () => {
    const logs: string[] = []
    const debug = console.debug
    console.debug = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "))
    }

    let resolveSave: (value: ExtensionInfo) => void = () => {}
    const saveSettings: SaveExtensionSettings = (id, patch) => {
      return new Promise<ExtensionInfo>((resolve) => {
        resolveSave = resolve
        void patch
      })
    }
    const [item, setItem] = createSignal(makeItem())
    const { container, dispose } = mount(() => item(), saveSettings)

    typeInto(input(container, "Endpoint")!, "a-server")
    saveButton(container)!.click()
    await tick()
    // The parent swaps the keyed section to another extension while the save
    // request for the first one is still in flight.
    setItem(makeItem({ id: "other.ext", displayName: "Other", settings: { host: "b-server" } }))
    await tick()
    await tick()
    expect(input(container, "Endpoint")!.value).toBe("b-server")

    resolveSave(makeItem({ settings: { host: "a-server" } }))
    await tick()
    await tick()
    // The stale response must not overwrite the new extension's baseline.
    expect(input(container, "Endpoint")!.value).toBe("b-server")
    expect(logs.some((line) => line.includes("save resolved stale from=acme.demo to=other.ext"))).toBe(true)
    console.debug = debug
    dispose()
  })

  test("a save resolving after the section was disposed does not write state or toast", async () => {
    const logs: string[] = []
    const debug = console.debug
    console.debug = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "))
    }
    let resolveSave: (value: ExtensionInfo) => void = () => {}
    const saveSettings: SaveExtensionSettings = () =>
      new Promise<ExtensionInfo>((resolve) => {
        resolveSave = resolve
      })
    const { container, dispose } = mount(() => makeItem(), saveSettings)

    typeInto(input(container, "Endpoint")!, "a-server")
    saveButton(container)!.click()
    await tick()
    // The parent unmounts the section while the request is in flight.
    dispose()
    resolveSave(makeItem({ settings: { host: "a-server" } }))
    await tick()
    await tick()
    // The late response is dropped instead of writing into the dead section.
    expect(logs.some((line) => line.includes("save resolved stale from=acme.demo to=acme.demo"))).toBe(true)
    console.debug = debug
  })

  test("a failed save keeps the draft and re-enables the button, logging the id without values", async () => {
    const logs: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(" "))
    }
    const saveSettings: SaveExtensionSettings = () => Promise.reject(new Error("boom"))
    const { container, dispose } = mount(() => makeItem(), saveSettings)

    typeInto(input(container, "Endpoint")!, "https://example.com")
    saveButton(container)!.click()
    await tick()
    await tick()

    expect(saveButton(container)?.disabled).toBe(false)
    expect(input(container, "Endpoint")!.value).toBe("https://example.com")
    expect(logs.some((line) => line.includes("save failed id=acme.demo error=boom"))).toBe(true)
    // Logs carry ids and key counts only, never setting values.
    expect(logs.join("\n").includes("https://example.com")).toBe(false)
    console.warn = warn
    dispose()
  })
})
