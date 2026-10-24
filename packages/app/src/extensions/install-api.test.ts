import { describe, expect, mock, test } from "bun:test"
import {
  createInstallationApi,
  synchronizeInstallation,
  type InstallationRequest,
  type InstallationResult,
  type InstallationStatus,
  type PreparedInstallation,
} from "./install-api"

type GlobalSDK = Parameters<typeof createInstallationApi>[0]
type Client = GlobalSDK["client"]["extensionInstallation"]
type Envelope = { data?: PreparedInstallation | InstallationResult | InstallationStatus; error?: unknown }

const token = "installation-api-test-capability"
const genericError = "Extension operation could not be completed"

function prepared(kind: PreparedInstallation["kind"] = "install"): PreparedInstallation {
  return {
    operationId: "operation-123",
    expiresAt: 1_900_000_000_000,
    kind,
    id: "example.viewer",
    name: "Example Viewer",
    version: "2.0.0",
    permissions: [],
    permissionsAdded: [],
    permissionsRemoved: [],
    contributes: {},
    source: {
      type: "npm",
      spec: "@example/viewer@2.0.0",
      registry: "https://registry.npmjs.org",
      integrity: "sha512-test-integrity",
    },
    hasServer: false,
    enable: false,
    token,
  }
}

function completed(kind: InstallationResult["kind"] = "install"): InstallationResult {
  return {
    operationId: "operation-123",
    kind,
    id: "example.viewer",
    state: "committed",
    committed: true,
    synced: true,
    cleanupPending: false,
    warnings: [],
  }
}

function setup(respond: () => Envelope | Promise<Envelope> = () => ({ data: completed() })) {
  const client = {
    prepare: mock((_input: Parameters<Client["prepare"]>[0]) => Promise.resolve(respond())),
    install: mock((_input: Parameters<Client["install"]>[0]) => Promise.resolve(respond())),
    update: mock((_input: Parameters<Client["update"]>[0]) => Promise.resolve(respond())),
    uninstall: mock((_input: Parameters<Client["uninstall"]>[0]) => Promise.resolve(respond())),
    status: mock((_input: Parameters<Client["status"]>[0]) => Promise.resolve(respond())),
    cancel: mock((_input: Parameters<Client["cancel"]>[0]) => Promise.resolve(respond())),
  }
  // Only this SDK surface is needed; no Solid provider or runtime context is involved.
  const api = createInstallationApi({ client: { extensionInstallation: client } } as unknown as GlobalSDK)
  return { api, client }
}

function operations(api: ReturnType<typeof createInstallationApi>) {
  return [
    () => api.prepare({ kind: "install", source: { type: "npm", spec: "@example/viewer@2.0.0" } }),
    () => api.commit(prepared("install")),
    () => api.commit(prepared("update")),
    () => api.commit(prepared("uninstall")),
    () => api.status(prepared()),
    () => api.cancel(prepared()),
  ]
}

async function expectSanitized(operation: () => Promise<unknown>) {
  const error: unknown = await operation().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(genericError)
  expect(String(error)).not.toContain(token)
  expect((error as Error).cause).toBeUndefined()
}

describe("extension installation API", () => {
  test("recovered committed status refreshes the production host view before returning", async () => {
    const { api } = setup(() => ({ data: completed() }))
    let refreshed = false
    const pending = synchronizeInstallation(await api.status(prepared()), async () => {
      refreshed = true
    })
    expect((await pending).committed).toBe(true)
    expect(refreshed).toBe(true)
    const unsynced = await synchronizeInstallation(await api.status(prepared()), async () => {
      throw new Error("offline")
    })
    expect(unsynced.committed).toBe(true)
    if (unsynced.state === "prepared") throw new Error("Expected committed status")
    expect(unsynced.synced).toBe(false)
    const { token: _token, ...fields } = prepared()
    let refreshes = 0
    await synchronizeInstallation(
      { ...fields, state: "prepared", committed: false } as InstallationStatus,
      async () => {
        refreshes++
      },
    )
    await synchronizeInstallation({ ...completed(), state: "unknown", committed: undefined }, async () => {
      refreshes++
    })
    expect(refreshes).toBe(0)
  })
  test("wraps npm preparation in the generated SDK envelope and unwraps data", async () => {
    const data = prepared()
    const { api, client } = setup(() => ({ data }))
    const request: InstallationRequest = {
      kind: "install",
      source: { type: "npm", spec: "@example/viewer@2.0.0" },
    }

    expect(await api.prepare(request)).toBe(data)
    expect(client.prepare).toHaveBeenCalledTimes(1)
    expect(client.prepare).toHaveBeenCalledWith({ extensionPrepareInput: request }, { redirect: "error" })
    expect(client.install).not.toHaveBeenCalled()
  })

  test("preserves the archive URL and checksum in the preparation envelope", async () => {
    const data = prepared()
    const { api, client } = setup(() => ({ data }))
    const request: InstallationRequest = {
      kind: "install",
      source: {
        type: "archive",
        url: "https://example.com/viewer-2.0.0.tgz",
        sha256: "a".repeat(64),
      },
    }

    expect(await api.prepare(request)).toBe(data)
    expect(client.prepare).toHaveBeenCalledTimes(1)
    expect(client.prepare).toHaveBeenCalledWith({ extensionPrepareInput: request }, { redirect: "error" })
  })

  test("preserves release prepare, fixed-current update, and v3 preview fields", async () => {
    const data: PreparedInstallation = {
      ...prepared(),
      source: {
        type: "release",
        descriptor: "https://publisher.example/stable.json",
        extensionID: "example.viewer",
        version: "2.0.0",
        artifact: "https://cdn.example/viewer.tgz",
        sha256: "a".repeat(64),
        descriptorSha256: "b".repeat(64),
      },
      expectedRegistryVersion: 2,
      registryUpgrade: { from: 2, to: 3 },
    }
    const { api, client } = setup(() => ({ data }))
    for (const request of [
      { kind: "install", source: { type: "release", url: "https://publisher.example/stable.json" } },
      { kind: "update", id: "example.viewer", target: "release-current" },
    ] satisfies InstallationRequest[]) {
      expect(await api.prepare(request)).toBe(data)
      expect(client.prepare).toHaveBeenLastCalledWith({ extensionPrepareInput: request }, { redirect: "error" })
    }
    expect(client.install).not.toHaveBeenCalled()
    expect(client.update).not.toHaveBeenCalled()
  })

  test("forwards explicit registry upgrade consent to install and update but never uninstall", async () => {
    const { api, client } = setup()
    for (const acceptRegistryUpgrade of [true, false]) {
      await api.commit(prepared("install"), { acceptRegistryUpgrade })
      expect(client.install).toHaveBeenLastCalledWith(
        { operationId: "operation-123", "x-opencode-extension-token": token, enable: false, acceptRegistryUpgrade },
        { redirect: "error" },
      )
      await api.commit(prepared("update"), { enable: true, acceptRegistryUpgrade })
      expect(client.update).toHaveBeenLastCalledWith(
        {
          operationId: "operation-123",
          "x-opencode-extension-token": token,
          id: "example.viewer",
          acceptRegistryUpgrade,
        },
        { redirect: "error" },
      )
    }
    await api.commit(prepared("uninstall"), { acceptRegistryUpgrade: true })
    expect(client.uninstall).toHaveBeenLastCalledWith(
      { operationId: "operation-123", "x-opencode-extension-token": token, id: "example.viewer" },
      { redirect: "error" },
    )
  })

  test("prepares uninstall with its target and preserves explicit purgeData values", async () => {
    const data = prepared("uninstall")
    const { api, client } = setup(() => ({ data }))

    for (const purgeData of [false, true]) {
      const request: InstallationRequest = { kind: "uninstall", id: "example.viewer", purgeData }
      expect(await api.prepare(request)).toBe(data)
      expect(client.prepare).toHaveBeenLastCalledWith({ extensionPrepareInput: request }, { redirect: "error" })
    }
    expect(client.prepare).toHaveBeenCalledTimes(2)
    expect(client.uninstall).not.toHaveBeenCalled()
  })

  test("dispatches install with the capability header and defaults to disabled", async () => {
    const data = completed()
    const { api, client } = setup(() => ({ data }))
    const preview = { ...prepared(), enable: true }

    expect(await api.commit(preview)).toBe(data)
    expect(client.install).toHaveBeenCalledTimes(1)
    expect(client.install).toHaveBeenCalledWith(
      {
        operationId: preview.operationId,
        "x-opencode-extension-token": token,
        enable: false,
      },
      { redirect: "error" },
    )
    expect(client.update).not.toHaveBeenCalled()
    expect(client.uninstall).not.toHaveBeenCalled()
  })

  test("preserves explicit install enable choices", async () => {
    const { api, client } = setup()
    const preview = prepared()

    for (const enable of [true, false]) {
      await api.commit(preview, { enable })
      expect(client.install).toHaveBeenLastCalledWith(
        {
          operationId: preview.operationId,
          "x-opencode-extension-token": token,
          enable,
        },
        { redirect: "error" },
      )
    }
    expect(client.install).toHaveBeenCalledTimes(2)
  })

  test("dispatches update to the prepared target without install-only options", async () => {
    const data = completed("update")
    const { api, client } = setup(() => ({ data }))
    const preview = { ...prepared("update"), id: "another.viewer" }

    expect(await api.commit(preview, { enable: true })).toBe(data)
    expect(client.update).toHaveBeenCalledTimes(1)
    expect(client.update).toHaveBeenCalledWith(
      {
        operationId: preview.operationId,
        "x-opencode-extension-token": token,
        id: "another.viewer",
      },
      { redirect: "error" },
    )
    expect(client.install).not.toHaveBeenCalled()
    expect(client.uninstall).not.toHaveBeenCalled()
  })

  test("dispatches uninstall to the prepared target with its capability header", async () => {
    const data = completed("uninstall")
    const { api, client } = setup(() => ({ data }))
    const preview = { ...prepared("uninstall"), id: "another.viewer" }

    expect(await api.commit(preview, { enable: true })).toBe(data)
    expect(client.uninstall).toHaveBeenCalledTimes(1)
    expect(client.uninstall).toHaveBeenCalledWith(
      {
        operationId: preview.operationId,
        "x-opencode-extension-token": token,
        id: "another.viewer",
      },
      { redirect: "error" },
    )
    expect(client.install).not.toHaveBeenCalled()
    expect(client.update).not.toHaveBeenCalled()
  })

  test("reads status with the operation ID and capability header and unwraps data", async () => {
    const { token: _token, ...preview } = prepared()
    const data: InstallationStatus = { ...preview, state: "prepared", committed: false }
    const { api, client } = setup(() => ({ data }))

    expect(await api.status(prepared())).toBe(data)
    expect(client.status).toHaveBeenCalledTimes(1)
    expect(client.status).toHaveBeenCalledWith(
      {
        operationId: preview.operationId,
        "x-opencode-extension-token": token,
      },
      { redirect: "error" },
    )
    expect(client.cancel).not.toHaveBeenCalled()
  })

  test("cancels with the operation ID and capability header and unwraps data", async () => {
    const data: InstallationResult = { ...completed(), state: "cancelled", committed: false }
    const { api, client } = setup(() => ({ data }))
    const preview = prepared()

    expect(await api.cancel(preview)).toBe(data)
    expect(client.cancel).toHaveBeenCalledTimes(1)
    expect(client.cancel).toHaveBeenCalledWith(
      {
        operationId: preview.operationId,
        "x-opencode-extension-token": token,
      },
      { redirect: "error" },
    )
    expect(client.status).not.toHaveBeenCalled()
  })

  test("rejects missing data and error envelopes generically without exposing capabilities", async () => {
    const error = { message: `Request failed with x-opencode-extension-token: ${token}` }
    const responses: Envelope[] = [{}, { error }, { data: completed(), error }]

    for (const response of responses) {
      const { api } = setup(() => response)
      for (const operation of operations(api)) await expectSanitized(operation)
    }
  })

  test("sanitizes SDK promise rejections on every operation without retaining their cause", async () => {
    const error = new Error(`Request failed with x-opencode-extension-token: ${token}`)
    const { api } = setup(() => Promise.reject(error))

    for (const operation of operations(api)) await expectSanitized(operation)
  })

  test("sanitizes synchronous SDK failures on every operation", async () => {
    const { api } = setup(() => {
      throw new Error(`Cannot construct request with x-opencode-extension-token: ${token}`)
    })

    for (const operation of operations(api)) await expectSanitized(operation)
  })
})
