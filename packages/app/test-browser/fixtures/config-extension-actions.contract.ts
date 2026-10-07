import { describe, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./solid-form-loader"
import type { ExtensionInfo } from "../../src/extensions/types"

const { ConfigExtensionActions } = await import("../../src/pages/config-extension-actions")
const item = (): ExtensionInfo => ({
  id: "test.viewer",
  displayName: "Viewer",
  version: "1.0.0",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function mount(
  options: {
    enabled?: boolean
    dirty?: boolean
    saving?: boolean
    busy?: boolean
    item?: ExtensionInfo
    fail?: boolean
    gate?: Promise<void>
    synced?: boolean
    resultState?: ExtensionInfo["state"]
  } = {},
) {
  const [value, setValue] = createSignal(options.item ?? item())
  const [connection, setConnection] = createSignal<object>({})
  const calls: Array<{ id: string; enabled: boolean }> = []
  const notices: string[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () =>
      createComponent(ConfigExtensionActions, {
        get item() {
          return value()
        },
        connection,
        enabled: options.enabled ?? true,
        dirty: options.dirty,
        saving: options.saving,
        busy: options.busy,
        language: { t: (key: string) => key },
        notify: (notice) => {
          notices.push(String(notice.title))
          return "test-toast"
        },
        setEnabled: async (id, enabled) => {
          calls.push({ id, enabled })
          await options.gate
          if (options.fail) throw new Error("toggle rejected")
          const info = {
            ...value(),
            enabled,
            state: options.resultState ?? (enabled ? ("ready" as const) : ("disabled" as const)),
          }
          setValue(info)
          return { info, synced: options.synced ?? true }
        },
      }),
    container,
  )
  return {
    container,
    calls,
    notices,
    setValue,
    setConnection,
    dispose() {
      dispose()
      container.remove()
    },
  }
}
const button = (app: ReturnType<typeof mount>, action: string) =>
  app.container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!

describe("extension actions", () => {
  test("disabling requires confirmation, cancel sends no request", async () => {
    const app = mount()
    try {
      button(app, "extension-toggle").click()
      expect(app.calls).toHaveLength(0)
      expect(button(app, "extension-toggle-confirm")).not.toBeNull()
      button(app, "extension-toggle-cancel").click()
      expect(app.calls).toHaveLength(0)
      expect(button(app, "extension-toggle-confirm")).toBeNull()
      button(app, "extension-toggle").click()
      button(app, "extension-toggle-confirm").click()
      await tick()
      expect(app.calls).toEqual([{ id: "test.viewer", enabled: false }])
    } finally {
      app.dispose()
    }
  })
  test("enabling sends one request without a disable confirmation", async () => {
    const app = mount({ item: { ...item(), enabled: false, state: "disabled" } })
    try {
      button(app, "extension-toggle").click()
      await tick()
      expect(app.calls).toEqual([{ id: "test.viewer", enabled: true }])
    } finally {
      app.dispose()
    }
  })
  test("dirty, saving and busy disable management", () => {
    for (const state of [{ dirty: true }, { saving: true }, { busy: true }]) {
      const app = mount(state)
      try {
        expect(button(app, "extension-toggle").disabled).toBe(true)
        expect(app.calls).toHaveLength(0)
      } finally {
        app.dispose()
      }
    }
  })
  test("safe mode hides management and incompatible entries cannot be enabled", () => {
    const off = mount({ enabled: false })
    try {
      expect(button(off, "extension-toggle")).toBeNull()
    } finally {
      off.dispose()
    }
    const app = mount({ item: { ...item(), enabled: false, state: "incompatible" } })
    try {
      expect(button(app, "extension-toggle").disabled).toBe(true)
    } finally {
      app.dispose()
    }
  })
  test("switching identity cancels the pending confirmation", () => {
    const app = mount()
    try {
      button(app, "extension-toggle").click()
      app.setValue({ ...item(), id: "test.other" })
      expect(button(app, "extension-toggle-confirm")).toBeNull()
      expect(app.calls).toHaveLength(0)
    } finally {
      app.dispose()
    }
  })
  test("a failed request leaves the extension enabled and can be retried", async () => {
    const app = mount({ fail: true })
    try {
      button(app, "extension-toggle").click()
      button(app, "extension-toggle-confirm").click()
      await tick()
      expect(button(app, "extension-toggle").disabled).toBe(false)
      button(app, "extension-toggle").click()
      expect(button(app, "extension-toggle-confirm")).not.toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("a pending request blocks another toggle", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = mount({ item: { ...item(), enabled: false, state: "disabled" }, gate })
    try {
      button(app, "extension-toggle").click()
      expect(button(app, "extension-toggle").disabled).toBe(true)
      button(app, "extension-toggle").click()
      expect(app.calls).toHaveLength(1)
      release()
      await tick()
      expect(button(app, "extension-toggle").disabled).toBe(false)
    } finally {
      release()
      app.dispose()
    }
  })
  test("switching server identity drops a late success notification", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = mount({ item: { ...item(), enabled: false, state: "disabled" }, gate })
    try {
      button(app, "extension-toggle").click()
      app.setConnection({})
      release()
      await tick()
      expect(app.notices).toEqual([])
    } finally {
      release()
      app.dispose()
    }
  })
  test("saved but unsynchronized state is reported as a warning", async () => {
    const app = mount({ item: { ...item(), enabled: false, state: "disabled" }, synced: false })
    try {
      button(app, "extension-toggle").click()
      await tick()
      expect(app.notices).toContain("config.extensions.toggle.syncFailed")
    } finally {
      app.dispose()
    }
  })
  test("enabled error state is not reported as available", async () => {
    const app = mount({ item: { ...item(), enabled: false, state: "error" }, resultState: "error" })
    try {
      button(app, "extension-toggle").click()
      await tick()
      expect(app.notices).toContain("config.extensions.toggle.unavailable")
    } finally {
      app.dispose()
    }
  })
})
