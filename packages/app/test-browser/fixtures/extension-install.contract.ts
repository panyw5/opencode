import { describe, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./solid-form-loader"
import type {
  InstallationIntent,
  InstallationOperations,
  InstallationResult,
  InstallationStatus,
  PreparedInstallation,
} from "../../src/pages/install-actions-state"
const { ExtensionInstallationForm } = await import("../../src/components/dialog-install-extension")
const { ConfigExtensionInstallActions } = await import("../../src/pages/config-extension-install-actions")
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const language = { t: (key: string) => key }
const preview = (kind: InstallationIntent["kind"] = "install"): PreparedInstallation => ({
  operationId: "operation-1",
  token: "private-capability",
  expiresAt: Date.now() + 600_000,
  kind,
  id: "test.viewer",
  name: "Viewer",
  version: "2.0.0",
  oldVersion: kind === "update" ? "3.0.0" : undefined,
  versionChange: kind === "update" ? "downgrade" : undefined,
  permissions: ["fs:read"],
  permissionsAdded: ["fs:read"],
  permissionsRemoved: ["net:fetch"],
  contributes: { commands: [{ id: "read", title: "Read" }] },
  source: {
    type: "npm",
    spec: "@test/viewer@2.0.0",
    registry: "https://registry.npmjs.org/",
    integrity: "sha512-test",
  },
  hasServer: true,
  enable: false,
})
const result = (over: Partial<InstallationResult> = {}): InstallationResult => ({
  operationId: "operation-1",
  kind: "install",
  id: "test.viewer",
  state: "committed",
  committed: true,
  synced: true,
  cleanupPending: false,
  warnings: [],
  ...over,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function mount(
  options: {
    intent?: InstallationIntent
    prepared?: Promise<PreparedInstallation>
    committed?: Promise<InstallationResult>
    result?: InstallationResult
    status?: InstallationStatus
    failCommit?: boolean
    enabled?: boolean
    busy?: boolean
    dirty?: boolean
    saving?: boolean
    blocked?: boolean
  } = {},
) {
  const [connection, setConnection] = createSignal<unknown>("A")
  const [block, setBlock] = createSignal(!!options.blocked)
  const [busy, setBusy] = createSignal(!!options.busy)
  const calls = { prepare: [] as unknown[], commit: [] as unknown[], cancel: [] as unknown[], status: [] as unknown[] }
  const notices: InstallationResult[] = []
  let closed = () => {}
  const operations: InstallationOperations = {
    prepareInstallation: async (request) => {
      calls.prepare.push(request)
      return options.prepared ?? preview(request.kind)
    },
    commitInstallation: async (prepared, input) => {
      calls.commit.push({ prepared, input })
      if (options.failCommit) throw new Error(`lost ${prepared.token}`)
      return options.committed ?? options.result ?? result({ kind: prepared.kind })
    },
    cancelInstallation: async (prepared) => {
      calls.cancel.push(prepared)
      return result({ state: "cancelled", committed: false })
    },
    installationStatus: async (prepared) => {
      calls.status.push(prepared)
      return options.status ?? result()
    },
  }
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () =>
      createComponent(ExtensionInstallationForm, {
        intent: options.intent ?? { kind: "install" },
        operations,
        language,
        connection,
        enabled: options.enabled,
        get busy() {
          return busy()
        },
        dirty: options.dirty,
        saving: options.saving,
        get blocked() {
          return block()
        },
        registerClose: (callback) => {
          closed = callback
        },
        onClose: () => {},
        onResult: (value) => notices.push(value),
      }),
    container,
  )
  return {
    container,
    calls,
    notices,
    setConnection,
    setBlock,
    setBusy,
    closed: () => closed(),
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}
type App = ReturnType<typeof mount>
const button = (app: App, action: string) =>
  app.container.querySelector<HTMLButtonElement>(`[data-action="extension-install-${action}"]`)!
const type = (app: App, label: string, value: string) => {
  const input = app.container.querySelector<HTMLInputElement>(`input[aria-label="config.extensions.install.${label}"]`)!
  expect(input).not.toBeNull()
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const select = (app: App, value: string) => {
  const el = app.container.querySelector<HTMLSelectElement>("select")!
  el.value = value
  el.dispatchEvent(new Event("change", { bubbles: true }))
}
const prepare = async (app: App) => {
  type(app, "spec", "@test/viewer@2.0.0")
  button(app, "prepare").click()
  await tick()
}

describe("extension installation UI contracts", () => {
  test("npm prepare is separate from commit, shows complete review and defaults disabled", async () => {
    const app = mount()
    try {
      await prepare(app)
      expect(app.calls.prepare).toEqual([{ kind: "install", source: { type: "npm", spec: "@test/viewer@2.0.0" } }])
      expect(app.calls.commit).toHaveLength(0)
      expect(app.container.textContent).toContain("permissionsAdded")
      expect(app.container.textContent).toContain("permissionsRemoved")
      expect(app.container.textContent).toContain("fs:read")
      expect(app.container.textContent).toContain("net:fetch")
      expect(app.container.textContent).toContain("unverified")
      expect(app.container.querySelector('[data-preview="contributes"]')?.textContent).toContain("commands: 1")
      expect(app.container.querySelector<HTMLInputElement>('[data-field="enable"] input')?.checked).toBe(false)
      expect(app.container.innerHTML).not.toContain("private-capability")
      button(app, "confirm").click()
      await tick()
      expect(app.calls.commit).toHaveLength(1)
      expect(app.calls.commit[0]).toMatchObject({ input: { enable: false } })
      expect(app.container.querySelector('[data-result="committed"]')).not.toBeNull()
      expect(JSON.stringify(app.notices)).not.toContain("private-capability")
    } finally {
      app.dispose()
    }
  })
  test("archive accepts HTTPS plus SHA-256 only and never accepts local/upload input", async () => {
    const app = mount()
    try {
      select(app, "archive")
      type(app, "url", "http://localhost/test.tgz")
      type(app, "sha256", "a".repeat(64))
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toHaveLength(0)
      type(app, "url", "https://example.com/test.tgz")
      type(app, "sha256", "bad")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toHaveLength(0)
      type(app, "sha256", "A".repeat(64))
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare[0]).toEqual({
        kind: "install",
        source: { type: "archive", url: "https://example.com/test.tgz", sha256: "a".repeat(64) },
      })
      expect(app.container.querySelector('input[type="file"]')).toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("update version preview explicitly shows downgrade and previous version", async () => {
    const app = mount({ intent: { kind: "update", id: "test.viewer" } })
    try {
      select(app, "version")
      type(app, "version", "2.0.0")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toEqual([{ kind: "update", id: "test.viewer", version: "2.0.0" }])
      expect(app.container.querySelector('[data-preview="versions"]')?.textContent).toBe("3.0.0 → 2.0.0")
      expect(app.container.querySelector('[data-preview="version-change"]')?.textContent).toContain("downgrade")
    } finally {
      app.dispose()
    }
  })
  test("uninstall retains data by default, purge requires explicit checkbox and cannot fake success", async () => {
    for (const purge of [false, true]) {
      const app = mount({
        intent: { kind: "uninstall", id: "test.viewer" },
        result: result({ kind: "uninstall", state: "failed", committed: false }),
      })
      try {
        if (purge) app.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
        button(app, "prepare").click()
        await tick()
        expect(app.calls.prepare).toEqual([{ kind: "uninstall", id: "test.viewer", purgeData: purge }])
        expect(app.container.textContent).toContain(purge ? "purgeWarning" : "keepData")
        button(app, "confirm").click()
        await tick()
        expect(app.container.querySelector('[data-result="failed"]')?.textContent).toContain("failed")
        expect(app.container.querySelector('[data-result="committed"]')).toBeNull()
      } finally {
        app.dispose()
      }
    }
  })
  test("safe mode, busy, dirty, saving, and parent blocked prevent prepare and entry actions", () => {
    for (const options of [{ enabled: false }, { busy: true }, { dirty: true }, { saving: true }, { blocked: true }]) {
      const app = mount(options)
      try {
        expect(button(app, "prepare").disabled).toBe(true)
        expect(app.calls.prepare).toHaveLength(0)
      } finally {
        app.dispose()
      }
      const container = document.createElement("div")
      const dispose = render(
        () =>
          createComponent(ConfigExtensionInstallActions, {
            ...options,
            operations: {} as InstallationOperations,
            language,
            connection: () => "A",
            showInstallation: () => {
              throw new Error("blocked")
            },
          }),
        container,
      )
      try {
        expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true)
      } finally {
        dispose()
      }
    }
  })
  test("development links can be unlinked but cannot be updated", () => {
    const container = document.createElement("div")
    document.body.append(container)
    const intents: InstallationIntent[] = []
    const dispose = render(
      () =>
        createComponent(ConfigExtensionInstallActions, {
          item: { id: "test.viewer", source: { type: "path" } },
          operations: {} as InstallationOperations,
          language,
          connection: () => "A",
          showInstallation: (intent) => {
            intents.push(intent)
          },
        }),
      container,
    )
    try {
      const update = container.querySelector<HTMLButtonElement>('[data-action="extension-update-open"]')!
      const uninstall = container.querySelector<HTMLButtonElement>('[data-action="extension-uninstall-open"]')!
      expect(update.disabled).toBe(true)
      expect(uninstall.disabled).toBe(false)
      update.click()
      uninstall.click()
      expect(intents).toEqual([{ kind: "uninstall", id: "test.viewer" }])
    } finally {
      dispose()
      container.remove()
    }
  })
  test("input edits during prepare discard late preview and cancel its service operation", async () => {
    const gate = deferred<PreparedInstallation>()
    const app = mount({ prepared: gate.promise })
    try {
      type(app, "spec", "test-one")
      button(app, "prepare").click()
      type(app, "spec", "test-two")
      gate.resolve(preview())
      await tick()
      expect(app.container.querySelector('[data-action="extension-install-confirm"]')).toBeNull()
      expect(app.calls.cancel).toHaveLength(1)
      expect(button(app, "prepare").disabled).toBe(false)
    } finally {
      app.dispose()
    }
    const ownGate = deferred<PreparedInstallation>()
    const own = mount({ prepared: ownGate.promise })
    try {
      type(own, "spec", "test")
      button(own, "prepare").click()
      own.setBusy(true)
      ownGate.resolve(preview())
      await tick()
      expect(button(own, "confirm").disabled).toBe(true)
      expect(own.calls.cancel).toHaveLength(0)
      own.setBusy(false)
      expect(button(own, "confirm").disabled).toBe(false)
    } finally {
      own.dispose()
    }
  })
  test("A-B-A server transitions permanently invalidate a late response", async () => {
    const gate = deferred<PreparedInstallation>()
    const app = mount({ prepared: gate.promise })
    try {
      type(app, "spec", "test")
      button(app, "prepare").click()
      app.setConnection("B")
      app.setConnection("A")
      gate.resolve(preview())
      await tick()
      expect(app.calls.cancel).toHaveLength(1)
      expect(button(app, "prepare").disabled).toBe(true)
      expect(app.container.querySelector('[data-action="extension-install-confirm"]')).toBeNull()
      expect(app.notices).toHaveLength(0)
    } finally {
      app.dispose()
    }
  })
  test("close/dispose cancels uncommitted previews including pending prepare but not submitted commits", async () => {
    const gate = deferred<PreparedInstallation>()
    const app = mount({ prepared: gate.promise })
    type(app, "spec", "test")
    button(app, "prepare").click()
    app.closed()
    gate.resolve(preview())
    await tick()
    expect(app.calls.cancel).toHaveLength(1)
    app.dispose()
    const review = mount()
    await prepare(review)
    review.dispose()
    await tick()
    expect(review.calls.cancel).toHaveLength(1)
    const commitGate = deferred<InstallationResult>()
    const submitted = mount({ committed: commitGate.promise })
    await prepare(submitted)
    button(submitted, "confirm").click()
    submitted.closed()
    commitGate.resolve(result())
    await tick()
    expect(submitted.calls.cancel).toHaveLength(0)
    expect(submitted.notices).toHaveLength(0)
    submitted.dispose()
  })
  test("committed but unsynced / cleanup pending are warnings and callback never leaks capability", async () => {
    const app = mount({
      result: result({ synced: false, cleanupPending: true, warnings: ["cleanup private-capability"] }),
    })
    try {
      await prepare(app)
      button(app, "confirm").click()
      await tick()
      expect(app.container.textContent).toContain("syncPending")
      expect(app.container.textContent).toContain("cleanupPending")
      expect(app.container.textContent).not.toContain("private-capability")
      expect(app.notices[0]).toMatchObject({
        committed: true,
        synced: false,
        cleanupPending: true,
        warnings: ["cleanup [redacted]"],
      })
    } finally {
      app.dispose()
    }
  })
  test("lost commit response is unknown, offers status not reinstall; prepared status keeps original capability", async () => {
    const prepared = preview()
    const { token: _token, ...fields } = prepared
    const app = mount({ failCommit: true, status: { ...fields, state: "prepared", committed: false } })
    try {
      await prepare(app)
      button(app, "confirm").click()
      await tick()
      expect(app.container.querySelector('[data-result="unknown"]')?.textContent).toContain("unknown")
      expect(app.container.querySelector('[data-action="extension-install-prepare"]')).toBeNull()
      button(app, "status").click()
      await tick()
      expect(app.calls.status).toHaveLength(1)
      expect(button(app, "confirm")).not.toBeNull()
      button(app, "confirm").click()
      await tick()
      expect(app.calls.commit[1]).toMatchObject({ prepared: { token: "private-capability" } })
    } finally {
      app.dispose()
    }
  })
})
