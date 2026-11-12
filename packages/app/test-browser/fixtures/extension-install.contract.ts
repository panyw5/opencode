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
const npmSource = {
  type: "npm" as const,
  spec: "@test/viewer@3.0.0",
  registry: "https://registry.npmjs.org/",
  integrity: "sha512-test",
}
const releasePreview = (kind: InstallationIntent["kind"] = "install", upgrade = true): PreparedInstallation => ({
  ...preview(kind),
  source: {
    type: "release",
    descriptor: "https://publisher.example/viewer/stable.json",
    extensionID: "test.viewer",
    version: "2.0.0",
    artifact: "https://cdn.example/viewer-2.0.0.tgz",
    sha256: "a".repeat(64),
    descriptorSha256: "b".repeat(64),
  },
  expectedRegistryVersion: upgrade ? 2 : 3,
  registryUpgrade: upgrade ? { from: 2, to: 3 } : undefined,
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
    status?: InstallationStatus | Promise<InstallationStatus>
    statusError?: Error
    failCommit?: boolean
    prepareError?: Error
    localDigest?: string
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
  const [dirty, setDirty] = createSignal(!!options.dirty)
  const [saving, setSaving] = createSignal(!!options.saving)
  const calls = { prepare: [] as unknown[], commit: [] as unknown[], cancel: [] as unknown[], status: [] as unknown[] }
  const notices: InstallationResult[] = []
  let closed = () => {}
  const operations: InstallationOperations = {
    prepareInstallation: async (request) => {
      calls.prepare.push(request)
      if (options.prepareError) throw options.prepareError
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
      if (options.statusError) throw options.statusError
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
        localArchiveBridge: options.localDigest
          ? {
              digest: async (path: string) => ({
                ok: true as const,
                value: { path, size: 100, sha256: options.localDigest! },
              }),
            }
          : undefined,
        connection,
        enabled: options.enabled,
        get busy() {
          return busy()
        },
        get dirty() {
          return dirty()
        },
        get saving() {
          return saving()
        },
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
    setDirty,
    setSaving,
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
const sourceTrigger = (app: App) => {
  const trigger = app.container.querySelector<HTMLButtonElement>(
    'button[aria-label="config.extensions.install.source"]',
  )
  expect(trigger).not.toBeNull()
  return trigger!
}
const sourceValue = (app: App) =>
  sourceTrigger(app).querySelector('[data-slot="select-select-trigger-value"]')?.textContent?.trim()
const settleSelect = async () => {
  await tick()
  await tick()
}
const openSource = async (app: App) => {
  const trigger = sourceTrigger(app)
  expect(trigger.disabled).toBe(false)
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.click()
  await settleSelect()
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  // Kobalte portals the options outside the form; follow this trigger's listbox.
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!
  expect(listbox?.getAttribute("role")).toBe("listbox")
  return listbox
}
const select = async (app: App, value: string) => {
  const listbox = await openSource(app)
  const option = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === `config.extensions.install.${value}`,
  )
  expect(option).toBeDefined()
  option!.click()
  await settleSelect()
  expect(sourceTrigger(app).getAttribute("aria-expanded")).toBe("false")
  expect(sourceValue(app)).toBe(`config.extensions.install.${value}`)
}
const prepare = async (app: App) => {
  await select(app, "npm")
  type(app, "spec", "@test/viewer@2.0.0")
  button(app, "prepare").click()
  await tick()
}

describe("extension installation UI contracts", () => {
  test("preview failures show curated diagnostics but never raw transport credentials", async () => {
    for (const [error, expected] of [
      [new Error("Extension is already installed"), "config.extensions.install.diagAlreadyInstalled"],
      [
        new Error("Release descriptor is not valid JSON; use a raw stable.json URL, not a web page"),
        "config.extensions.install.diagDescriptorJson",
      ],
      [new Error("transport failed private-capability Authorization: secret"), undefined],
    ] as const) {
      const app = mount({ prepareError: error })
      try {
        await prepare(app)
        expect(app.container.querySelector('[role="alert"]')?.textContent).toContain("config.extensions.install.failed")
        expect(app.container.querySelector("[data-install-diagnostic]")?.textContent).toBe(expected)
        expect(app.container.textContent).not.toContain("private-capability")
        expect(app.container.textContent).not.toContain("Authorization")
      } finally {
        app.dispose()
      }
    }
  })

  test("prepare sits beside the source input at matching height and remains available for uninstall", async () => {
    const app = mount({ intent: { kind: "update", id: "test.viewer", source: npmSource } })
    const uninstall = mount({ intent: { kind: "uninstall", id: "test.viewer" } })
    try {
      for (const [source, field] of [
        ["release", "releaseUrl"],
        ["npm", "spec"],
        ["version", "version"],
        ["archive", "url"],
      ] as const) {
        await select(app, source)
        const input = app.container.querySelector(`input[aria-label="config.extensions.install.${field}"]`)!
        const row = input.closest('[data-field="installation-source"]')!
        const action = button(app, "prepare")
        expect(row).not.toBeNull()
        expect(row.classList.contains("items-end")).toBe(true)
        expect(row.lastElementChild).toBe(action)
        expect(action.style.height).toBe("34px")
        const hint = app.container.querySelector('[data-field="release-hint"]')
        if (source === "release") {
          expect(hint).not.toBeNull()
          expect(row.contains(hint)).toBe(false)
          expect(row.nextElementSibling).toBe(hint)
        }
        expect(app.container.querySelectorAll('[data-action="extension-install-prepare"]')).toHaveLength(1)
      }
      expect(uninstall.container.querySelector('[data-field="installation-source"]')).toBeNull()
      expect(button(uninstall, "prepare").parentElement).toBe(button(uninstall, "close").parentElement)
    } finally {
      app.dispose()
      uninstall.dispose()
    }
  })
  test("npm prepare is separate from commit, shows complete review and defaults disabled", async () => {
    const app = mount()
    try {
      await prepare(app)
      expect(app.calls.prepare).toEqual([{ kind: "install", source: { type: "npm", spec: "@test/viewer@2.0.0" } }])
      expect(app.calls.commit).toHaveLength(0)
      expect(app.container.textContent).not.toContain("permissionsAdded")
      expect(app.container.textContent).not.toContain("permissionsRemoved")
      expect(app.container.textContent).toContain("fs:read")
      expect(app.container.textContent).not.toContain("net:fetch")
      expect(app.container.textContent).toContain("unverified")
      const contributions = app.container.querySelector('[data-preview="contributes"]')!
      expect(contributions.querySelectorAll("dt")).toHaveLength(5)
      expect(contributions.querySelectorAll("dd")[2]?.textContent).toBe("1")
      expect(button(app, "confirm").closest("[data-install-footer]")).not.toBeNull()
      expect(app.container.querySelector("[data-install-scroll]")?.contains(button(app, "confirm"))).toBe(false)
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
  test("release accepts one URL without a checksum and reviews descriptor/download trust separately", async () => {
    const app = mount({ prepared: Promise.resolve(releasePreview("install", false)) })
    try {
      expect(sourceValue(app)).toBe("config.extensions.install.release")
      expect(app.container.querySelector('input[aria-label="config.extensions.install.sha256"]')).toBeNull()
      for (const url of [
        "http://publisher.example/stable.json",
        "https://user:secret@publisher.example/stable.json",
        "https://publisher.example/stable.json?secret=value",
        "https://publisher.example/stable.json#hash",
      ]) {
        type(app, "releaseUrl", url)
        button(app, "prepare").click()
        await tick()
      }
      expect(app.calls.prepare).toHaveLength(0)
      type(app, "releaseUrl", "https://publisher.example/viewer/stable.json")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toEqual([
        { kind: "install", source: { type: "release", url: "https://publisher.example/viewer/stable.json" } },
      ])
      expect(app.container.textContent).toContain("https://publisher.example/viewer/stable.json")
      const review = app.container.querySelector('[data-preview="release-integrity"]')!
      expect(review.textContent).toContain("cdn.example")
      expect(review.textContent).toContain("integrityMatched")
      expect(app.container.querySelector('[data-preview="source"] [data-component="extension-card"]')).not.toBeNull()
      expect(
        app.container.querySelector('[data-preview="contributes"] [data-component="extension-card"]'),
      ).not.toBeNull()
      expect(app.container.textContent).not.toContain("permissionsAdded")
      expect(app.container.textContent).not.toContain("permissionsRemoved")
      expect(app.container.querySelector('[data-field="accept-registry-upgrade"]')).toBeNull()
      expect(button(app, "confirm").disabled).toBe(false)
      expect(app.container.innerHTML).not.toContain("private-capability")
    } finally {
      app.dispose()
    }
  })
  test("registry upgrade is handled internally on install and update without a technical consent checkbox", async () => {
    for (const kind of ["install", "update"] as const) {
      const prepared = releasePreview(kind)
      const app = mount({
        intent: kind === "update" ? { kind, id: "test.viewer", source: prepared.source } : { kind },
        prepared: Promise.resolve(prepared),
      })
      try {
        if (kind === "install") type(app, "releaseUrl", "https://publisher.example/viewer/stable.json")
        button(app, "prepare").click()
        await tick()
        expect(app.container.querySelector('[data-field="accept-registry-upgrade"]')).toBeNull()
        expect(app.container.querySelector('[data-preview="registry-upgrade"]')).toBeNull()
        expect(button(app, "confirm").disabled).toBe(false)
        button(app, "back").click()
        button(app, "prepare").click()
        await tick()
        expect(button(app, "confirm").disabled).toBe(false)
        button(app, "confirm").click()
        await tick()
        expect(app.calls.commit).toHaveLength(1)
        expect(app.calls.commit[0]).toMatchObject({ input: { enable: false, acceptRegistryUpgrade: true } })
      } finally {
        app.dispose()
      }
    }
  })
  test("release update pins the saved descriptor and version-only is available only for npm", async () => {
    const prepared = releasePreview("update", false)
    const app = mount({
      intent: { kind: "update", id: "test.viewer", source: prepared.source },
      prepared: Promise.resolve(prepared),
    })
    try {
      const source = sourceTrigger(app)
      const input = app.container.querySelector<HTMLInputElement>(
        'input[aria-label="config.extensions.install.releaseUrl"]',
      )!
      expect(source.disabled).toBe(true)
      expect(input.readOnly).toBe(true)
      expect(input.value).toBe("https://publisher.example/viewer/stable.json")
      source.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
      source.click()
      await settleSelect()
      expect(source.getAttribute("aria-expanded")).not.toBe("true")
      expect(sourceValue(app)).toBe("config.extensions.install.release")
      type(app, "releaseUrl", "https://attacker.example/stable.json")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toEqual([{ kind: "update", id: "test.viewer", target: "release-current" }])
    } finally {
      app.dispose()
    }
    for (const source of [
      undefined,
      { type: "archive" as const, location: "https://publisher.example/old.tgz", sha256: "a".repeat(64) },
      { type: "path" as const, path: "/tmp/dev" },
    ]) {
      const other = mount({ intent: { kind: "update", id: "test.viewer", source } })
      try {
        if (source?.type === "archive") expect(sourceValue(other)).toBe("config.extensions.install.archive")
        const listbox = await openSource(other)
        const labels = [...listbox.querySelectorAll('[role="option"]')].map((item) => item.textContent?.trim())
        expect(labels).toEqual([
          "config.extensions.install.release",
          "config.extensions.install.npm",
          "config.extensions.install.archive",
        ])
      } finally {
        other.dispose()
      }
    }
  })
  test("update entry passes the installed public release source into the dialog intent", () => {
    const source = releasePreview().source
    const container = document.createElement("div")
    document.body.append(container)
    const intents: InstallationIntent[] = []
    const dispose = render(
      () =>
        createComponent(ConfigExtensionInstallActions, {
          item: { id: "test.viewer", source },
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
      container.querySelector<HTMLButtonElement>('[data-action="extension-update-open"]')!.click()
      expect(intents).toEqual([{ kind: "update", id: "test.viewer", source }])
    } finally {
      dispose()
      container.remove()
    }
  })
  test("release late prepare cannot survive close, server switch, dirty, or saving", async () => {
    for (const invalidate of ["close", "server", "dirty", "saving"] as const) {
      const gate = deferred<PreparedInstallation>()
      const app = mount({ prepared: gate.promise })
      try {
        type(app, "releaseUrl", "https://publisher.example/viewer/stable.json")
        button(app, "prepare").click()
        if (invalidate === "close") app.closed()
        if (invalidate === "server") {
          app.setConnection("B")
          app.setConnection("A")
        }
        if (invalidate === "dirty") app.setDirty(true)
        if (invalidate === "saving") app.setSaving(true)
        gate.resolve(releasePreview())
        await tick()
        expect(app.calls.cancel).toHaveLength(1)
        expect(app.calls.commit).toHaveLength(0)
        expect(app.container.querySelector('[data-field="accept-registry-upgrade"]')).toBeNull()
        expect(app.container.querySelector('[data-action="extension-install-confirm"]')).toBeNull()
      } finally {
        app.dispose()
      }
    }
  })
  test("release lost commit uses status and preserves the original capability", async () => {
    const prepared = releasePreview()
    const { token: _token, ...fields } = prepared
    const app = mount({
      prepared: Promise.resolve(prepared),
      failCommit: true,
      status: { ...fields, state: "prepared", committed: false },
    })
    try {
      type(app, "releaseUrl", "https://publisher.example/viewer/stable.json")
      button(app, "prepare").click()
      await tick()
      button(app, "confirm").click()
      await tick()
      expect(app.container.querySelector('[data-result="unknown"]')).not.toBeNull()
      expect(app.container.querySelector('[data-action="extension-install-prepare"]')).toBeNull()
      button(app, "status").click()
      await tick()
      expect(button(app, "confirm").disabled).toBe(false)
      button(app, "confirm").click()
      await tick()
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit[1]).toMatchObject({
        prepared: { token: "private-capability" },
        input: { acceptRegistryUpgrade: true },
      })
      expect(JSON.stringify(app.notices)).not.toContain("private-capability")
    } finally {
      app.dispose()
    }
  })
  test("archive needs only an HTTPS URL, never a user checksum or local/upload input", async () => {
    const app = mount()
    try {
      await select(app, "archive")
      type(app, "url", "http://localhost/test.tgz")
      expect(app.container.querySelector('input[aria-label="config.extensions.install.sha256"]')).toBeNull()
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toHaveLength(0)
      type(app, "url", "https://example.com/test.tgz")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare[0]).toEqual({
        kind: "install",
        source: { type: "archive", url: "https://example.com/test.tgz" },
      })
      expect(app.container.querySelector('input[type="file"]')).toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("local file digests are automatic and never leak into a later URL source", async () => {
    const app = mount({
      intent: { kind: "install", localArchive: { path: "/tmp/fixture.tgz" } },
      localDigest: "a".repeat(64),
    })
    try {
      expect(button(app, "prepare").disabled).toBe(true)
      expect(app.container.querySelector('input[aria-label="config.extensions.install.sha256"]')).toBeNull()
      await tick()
      expect(button(app, "prepare").disabled).toBe(false)
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare[0]).toEqual({
        kind: "install",
        source: { type: "local", path: "/tmp/fixture.tgz", sha256: "a".repeat(64) },
      })
      button(app, "back").click()
      await select(app, "archive")
      type(app, "url", "https://example.com/different.tgz")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare[1]).toEqual({
        kind: "install",
        source: { type: "archive", url: "https://example.com/different.tgz" },
      })
    } finally {
      app.dispose()
    }
  })

  test("update version preview explicitly shows downgrade and previous version", async () => {
    const app = mount({ intent: { kind: "update", id: "test.viewer", source: npmSource } })
    try {
      await select(app, "version")
      type(app, "version", "2.0.0")
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toEqual([{ kind: "update", id: "test.viewer", version: "2.0.0" }])
      expect(app.container.querySelector('[data-preview="versions"]')?.textContent).toBe("3.0.0 → 2.0.0")
      expect(app.container.querySelector('[data-preview="version-change"]')?.textContent).toContain("downgrade")
      const permissions = app.container.querySelector('[data-preview="permissions"]')!
      expect(permissions.textContent).toContain("permissionsAdded")
      expect(permissions.textContent).toContain("permissionsRemoved")
      expect(permissions.textContent).toContain("net:fetch")
      expect(permissions.querySelectorAll('[data-component="extension-card"]')).toHaveLength(3)
      expect(button(app, "confirm").closest("[data-install-footer]")).not.toBeNull()
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
        expect(app.calls.commit).toHaveLength(1)
        expect(app.container.querySelector('[data-removal-state="failed"]')?.textContent).toContain("removeFailed")
        expect(app.container.querySelector('[data-removal-state="removed"]')).toBeNull()
        expect(button(app, "confirm")).toBeNull()
        expect(button(app, "status")).toBeNull()
      } finally {
        app.dispose()
      }
    }
  })
  test("removal shows only progress while preparation and commit are pending", async () => {
    const prepared = deferred<PreparedInstallation>()
    const committed = deferred<InstallationResult>()
    const app = mount({
      intent: { kind: "uninstall", id: "test.viewer" },
      prepared: prepared.promise,
      committed: committed.promise,
    })
    try {
      button(app, "prepare").click()
      expect(app.container.querySelector('[data-removal-state="removing"]')?.textContent).toBe(
        "config.extensions.install.removePending",
      )
      expect(app.container.querySelector('input[type="checkbox"]')).toBeNull()
      prepared.resolve(preview("uninstall"))
      await tick()
      expect(app.calls.commit).toHaveLength(1)
      expect(app.container.querySelector('[data-removal-state="removing"]')).not.toBeNull()
      expect(app.container.querySelector("[data-preview]")).toBeNull()
      expect(button(app, "confirm")).toBeNull()
      committed.resolve(result({ kind: "uninstall" }))
      await tick()
      expect(app.container.querySelector('[data-removal-state="removed"]')?.textContent).toBe(
        "config.extensions.install.removeSuccess",
      )
      expect(button(app, "status")).toBeNull()
      expect(app.container.querySelector('[data-action="extension-remove-retry"]')).toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("saved changes without synchronization are removal failures, not successes", async () => {
    for (const flags of [
      { synced: false, cleanupPending: false },
      { synced: false, cleanupPending: true },
    ]) {
      const app = mount({
        intent: { kind: "uninstall", id: "test.viewer" },
        result: result({
          kind: "uninstall",
          ...flags,
          warnings: ["Runtime coordinator reported warnings", "private-capability"],
        }),
      })
      try {
        button(app, "prepare").click()
        await tick()
        expect(app.container.querySelector('[data-removal-state="failed"]')?.textContent).toContain("removeIncomplete")
        for (const hidden of [
          "coordinator",
          "private-capability",
          "syncPending",
          "cleanupPending",
          "committed",
          "purgeWarning",
        ])
          expect(app.container.textContent).not.toContain(hidden)
        expect(button(app, "status")).toBeNull()
        expect(app.container.querySelector('[data-action="extension-remove-retry"]')).toBeNull()
      } finally {
        app.dispose()
      }
    }
  })
  test("a committed and synchronized removal succeeds even when old-package cleanup is pending", async () => {
    const app = mount({
      intent: { kind: "uninstall", id: "test.viewer" },
      result: result({
        kind: "uninstall",
        cleanupPending: true,
        warnings: ["Runtime coordinator reported warnings", "Cleanup receipt update failed; reconciliation is pending"],
      }),
    })
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.container.querySelector('[data-removal-state="removed"]')?.textContent).toBe(
        "config.extensions.install.removeSuccess",
      )
      expect(app.container.querySelector('[data-removal-state="failed"]')).toBeNull()
      expect(button(app, "status")).toBeNull()
      expect(app.container.querySelector('[data-action="extension-remove-retry"]')).toBeNull()
      for (const hidden of ["coordinator", "cleanupPending", "reconciliation", "removeIncomplete"])
        expect(app.container.textContent).not.toContain(hidden)
      expect(app.calls.commit).toHaveLength(1)
      expect(app.notices[0]?.cleanupPending).toBe(true)
    } finally {
      app.dispose()
    }
  })
  test("a lost removal response is reconciled automatically without another commit", async () => {
    const app = mount({
      intent: { kind: "uninstall", id: "test.viewer" },
      failCommit: true,
      status: result({ kind: "uninstall" }),
    })
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit).toHaveLength(1)
      expect(app.calls.status).toHaveLength(1)
      expect(app.container.querySelector('[data-removal-state="removed"]')).not.toBeNull()
      expect(button(app, "status")).toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("retry never resubmits an unresolved removal", async () => {
    const app = mount({
      intent: { kind: "uninstall", id: "test.viewer" },
      failCommit: true,
      status: result({ kind: "uninstall", state: "unknown", committed: undefined }),
    })
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.container.querySelector('[data-removal-state="failed"]')?.textContent).toContain("removeUnknown")
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.status).toHaveLength(2)
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit).toHaveLength(1)
      expect(app.calls.status[0]).toBe(app.calls.status[1])
    } finally {
      app.dispose()
    }
  })
  test("retry commits a confirmed unsubmitted removal with its original capability", async () => {
    const { token, ...prepared } = preview("uninstall")
    const options = {
      intent: { kind: "uninstall" as const, id: "test.viewer" },
      failCommit: true,
      status: { ...prepared, state: "prepared" as const, committed: false as const },
    }
    const app = mount(options)
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.calls.commit).toHaveLength(1)
      options.failCommit = false
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit).toHaveLength(2)
      expect(app.calls.commit[1]).toEqual(app.calls.commit[0])
      expect(JSON.stringify(app.calls.commit[1])).toContain(token)
      expect(app.container.querySelector('[data-removal-state="removed"]')).not.toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("a failed removal preparation can be retried without showing raw errors", async () => {
    const options = {
      intent: { kind: "uninstall" as const, id: "test.viewer" },
      prepareError: new Error("private-capability coordinator failure") as Error | undefined,
    }
    const app = mount(options)
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.container.querySelector('[data-removal-state="failed"]')).not.toBeNull()
      expect(app.container.textContent).not.toContain("private-capability")
      expect(app.container.textContent).not.toContain("coordinator")
      options.prepareError = undefined
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.prepare).toHaveLength(2)
      expect(app.calls.commit).toHaveLength(1)
      expect(app.container.querySelector('[data-removal-state="removed"]')).not.toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("retry starts a new removal only after a negative commit receipt", async () => {
    const options = {
      intent: { kind: "uninstall" as const, id: "test.viewer" },
      result: result({ kind: "uninstall", state: "failed", committed: false }),
    }
    const app = mount(options)
    try {
      button(app, "prepare").click()
      await tick()
      options.result = result({ kind: "uninstall" })
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.status).toHaveLength(0)
      expect(app.calls.prepare).toHaveLength(2)
      expect(app.calls.commit).toHaveLength(2)
      expect(app.container.querySelector('[data-removal-state="removed"]')).not.toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("failed automatic reconciliation stays retryable without exposing transport errors", async () => {
    const app = mount({
      intent: { kind: "uninstall", id: "test.viewer" },
      failCommit: true,
      statusError: new Error("private-capability coordinator failure"),
    })
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.container.querySelector('[data-removal-state="failed"]')?.textContent).toContain("removeUnknown")
      expect(app.container.textContent).not.toContain("private-capability")
      expect(app.container.textContent).not.toContain("coordinator")
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.status).toHaveLength(2)
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit).toHaveLength(1)
    } finally {
      app.dispose()
    }
  })
  test("retry of an unknown removal commits only after reconciliation confirms it is prepared", async () => {
    const options = {
      intent: { kind: "uninstall" as const, id: "test.viewer" },
      failCommit: true,
      status: result({ kind: "uninstall", state: "unknown", committed: undefined }) as InstallationStatus,
    }
    const app = mount(options)
    try {
      button(app, "prepare").click()
      await tick()
      const { token, ...prepared } = preview("uninstall")
      options.status = { ...prepared, state: "prepared", committed: false }
      options.failCommit = false
      app.container.querySelector<HTMLButtonElement>('[data-action="extension-remove-retry"]')!.click()
      await tick()
      expect(app.calls.status).toHaveLength(2)
      expect(app.calls.prepare).toHaveLength(1)
      expect(app.calls.commit).toHaveLength(2)
      expect(JSON.stringify(app.calls.commit[1])).toContain(token)
      expect(app.container.querySelector('[data-removal-state="removed"]')).not.toBeNull()
    } finally {
      app.dispose()
    }
  })
  test("closing while removal reconciliation is pending discards late results without cancelling a submitted operation", async () => {
    const status = deferred<InstallationStatus>()
    const app = mount({ intent: { kind: "uninstall", id: "test.viewer" }, failCommit: true, status: status.promise })
    try {
      button(app, "prepare").click()
      await tick()
      expect(app.container.querySelector('[data-removal-state="removing"]')).not.toBeNull()
      app.closed()
      status.resolve(result({ kind: "uninstall" }))
      await tick()
      expect(app.notices).toHaveLength(0)
      expect(app.calls.cancel).toHaveLength(0)
    } finally {
      app.dispose()
    }
  })
  test("connection changes during removal prevent retries and discard late results", async () => {
    const committed = deferred<InstallationResult>()
    const app = mount({ intent: { kind: "uninstall", id: "test.viewer" }, committed: committed.promise })
    try {
      button(app, "prepare").click()
      await tick()
      app.setConnection("B")
      expect(app.container.querySelector('[data-removal-state="failed"]')?.textContent).toContain(
        "removeConnectionChanged",
      )
      expect(app.container.querySelector('[data-action="extension-remove-retry"]')).toBeNull()
      committed.resolve(result({ kind: "uninstall" }))
      await tick()
      expect(app.container.querySelector('[data-removal-state="removed"]')).toBeNull()
      expect(app.notices).toHaveLength(0)
      expect(app.calls.cancel).toHaveLength(0)
    } finally {
      app.dispose()
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
          item: { id: "test.viewer", source: { type: "path", path: "/tmp/viewer" } },
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
      await select(app, "npm")
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
      await select(own, "npm")
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
      await select(app, "npm")
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
    await select(app, "npm")
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
    submitted.setBusy(true)
    expect(submitted.container.textContent).not.toContain("config.extensions.install.blocked")
    expect(button(submitted, "confirm").textContent).toBe("config.extensions.install.busy")
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
