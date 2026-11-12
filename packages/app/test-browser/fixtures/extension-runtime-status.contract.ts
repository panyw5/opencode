import { expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./solid-form-loader"
import type { ExtensionInfo } from "../../src/extensions/types"
const { ExtensionRuntimeStatus } = await import("../../src/components/extension-runtime-status")

const failed = (): ExtensionInfo => ({
  id: "test.runtime",
  version: "1.0",
  displayName: "Runtime",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
  server: {
    hasService: false,
    hasInstanceHooks: false,
    runtime: "error",
    needsRestart: false,
    error: "activation timed out",
  },
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function mount(
  options: {
    item?: ExtensionInfo
    gate?: Promise<void>
    gateForCall?: (index: number) => Promise<void>
    fail?: boolean
    synced?: boolean
  } = {},
) {
  const [item, setItem] = createSignal(options.item ?? failed())
  const [connection, setConnection] = createSignal<object>({})
  const calls: string[] = []
  const notices: string[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () =>
      createComponent(ExtensionRuntimeStatus, {
        get item() {
          return item()
        },
        connection,
        language: { t: (key: string) => key },
        notify: (notice) => {
          notices.push(String(notice.title))
          return "test"
        },
        retry: async (id) => {
          calls.push(id)
          await (options.gateForCall?.(calls.length - 1) ?? options.gate)
          if (options.fail) throw new Error("retry rejected")
          return { info: item(), synced: options.synced ?? true }
        },
      }),
    container,
  )
  return {
    container,
    calls,
    notices,
    setItem,
    setConnection,
    dispose() {
      dispose()
      container.remove()
    },
  }
}
const button = (app: ReturnType<typeof mount>) =>
  app.container.querySelector<HTMLButtonElement>("[data-action=extension-runtime-retry]")

test("shows runtime errors and retries once while busy", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = mount({ gate })
  try {
    expect(app.container.textContent).toContain("activation timed out")
    button(app)!.click()
    expect(button(app)!.disabled).toBe(true)
    button(app)!.click()
    expect(app.calls).toEqual(["test.runtime"])
    release()
    await tick()
    expect(button(app)!.disabled).toBe(false)
  } finally {
    release()
    app.dispose()
  }
})

test("restart blockers show a restart instruction and never expose retry", () => {
  const item = failed()
  const app = mount({ item: { ...item, server: { ...item.server!, runtime: "blocked", needsRestart: true } } })
  try {
    expect(app.container.textContent).toContain("config.extensions.runtime.restart")
    expect(button(app)).toBeNull()
    expect(app.calls).toHaveLength(0)
  } finally {
    app.dispose()
  }
})

test("retry failures surface without masking partial synchronization", async () => {
  const app = mount({ fail: true })
  try {
    button(app)!.click()
    await tick()
    expect(app.notices).toEqual(["config.extensions.runtime.failed"])
  } finally {
    app.dispose()
  }
  const partial = mount({ synced: false })
  try {
    button(partial)!.click()
    await tick()
    expect(partial.container.textContent).toContain("config.extensions.toggle.syncFailed")
  } finally {
    partial.dispose()
  }
})

test("switching servers resets local retry state and a late completion cannot clear the new busy state", async () => {
  const gates: Array<() => void> = []
  const promises = [
    new Promise<void>((resolve) => gates.push(resolve)),
    new Promise<void>((resolve) => gates.push(resolve)),
  ]
  const app = mount({ gateForCall: (index) => promises[index]! })
  try {
    button(app)!.click()
    app.setConnection({})
    expect(button(app)!.disabled).toBe(false)
    button(app)!.click()
    expect(app.calls).toHaveLength(2)
    expect(button(app)!.disabled).toBe(true)
    gates[0]!()
    await tick()
    expect(button(app)!.disabled).toBe(true)
    gates[1]!()
    await tick()
    expect(button(app)!.disabled).toBe(false)
  } finally {
    for (const release of gates) release()
    app.dispose()
  }
})

test("a previous server's synchronization failure does not show on a healthy connection", async () => {
  const app = mount({ synced: false })
  try {
    button(app)!.click()
    await tick()
    expect(app.container.textContent).toContain("config.extensions.toggle.syncFailed")
    app.setConnection({})
    app.setItem({
      ...failed(),
      server: { hasService: true, hasInstanceHooks: false, runtime: "ready", needsRestart: false },
    })
    expect(app.container.querySelector("[data-extension-runtime]")).toBeNull()
  } finally {
    app.dispose()
  }
})

test("a late retry failure after a connection change does not notify the new server", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = mount({ gate, fail: true })
  try {
    button(app)!.click()
    app.setConnection({})
    release()
    await tick()
    expect(app.notices).toEqual([])
  } finally {
    release()
    app.dispose()
  }
})
