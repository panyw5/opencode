import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createDesktopArchiveOperations } from "./install-desktop"
import type { InstallationOperations, PreparedInstallation } from "../pages/install-actions-state"

const bytes = new Uint8Array([1, 2, 3])
const sha256 = createHash("sha256").update(bytes).digest("hex")
const request = {
  kind: "update" as const,
  id: "local.wls-repl",
  source: { type: "archive" as const, url: "https://github.com/example/release.tgz", sha256 },
}
const releaseURL = "https://raw.githubusercontent.com/example/extension/main/stable.json"
const descriptorText = JSON.stringify({
  schemaVersion: 1,
  id: "local.wls-repl",
  version: "1.18.64",
  artifact: { url: "https://github.com/example/release.tgz", sha256 },
})
function setup(useSecureDownload = false, input: { hostVersion?: string; descriptor?: string } = {}) {
  const calls: Array<{ op: string; payload?: any }> = []
  let connection = {}
  let local = true
  let afterDownload = () => {}
  let secureDownloads = 0
  const prepared = {
    kind: "update",
    id: request.id,
    version: "1.18.64",
    operationId: "test-op",
    token: "test-secret",
  } as PreparedInstallation
  const fallback = Object.fromEntries(
    ["prepareInstallation", "commitInstallation", "installationStatus", "cancelInstallation"].map((op) => [
      op,
      async () => {
        calls.push({ op: "http:" + op })
        return prepared
      },
    ]),
  ) as unknown as InstallationOperations
  const operations = createDesktopArchiveOperations({
    fallback,
    local: () => local,
    connection: () => connection,
    releaseURL: () => releaseURL,
    download: useSecureDownload
      ? async () => {
          secureDownloads++
          return bytes
        }
      : undefined,
    hostVersion: input.hostVersion === undefined ? undefined : () => input.hostVersion,
    fetch: (async (url: RequestInfo | URL) => {
      if (String(url) === releaseURL) {
        calls.push({ op: "descriptor" })
        afterDownload()
        return new Response(input.descriptor ?? descriptorText)
      }
      if (String(url) === `${releaseURL}.sig`) {
        calls.push({ op: "signature" })
        afterDownload()
        return new Response("sig-document")
      }
      calls.push({ op: "download" })
      afterDownload()
      return new Response(bytes)
    }) as unknown as typeof fetch,
    bridge: {
      stage: async (value) => {
        expect([...value]).toEqual([...bytes])
        calls.push({ op: "stage" })
        return { ok: true, value: { path: "/tmp/test-download.tgz" } }
      },
      cleanup: async () => {
        calls.push({ op: "cleanup" })
      },
      invoke: async (op, payload) => {
        calls.push({ op, payload })
        return { ok: true, value: op === "prepare" ? prepared : { state: "committed", committed: true } }
      },
    },
  })
  return {
    calls,
    operations,
    secureDownloads: () => secureDownloads,
    setRemote: () => {
      local = false
    },
    changeConnection: () => {
      connection = {}
    },
    afterDownload: (fn: () => void) => {
      afterDownload = fn
    },
  }
}

test("desktop uses its HTTPS-only transport for redirected release assets", async () => {
  const app = setup(true)
  await app.operations.prepareInstallation({ kind: "install", source: { type: "release", url: releaseURL } })
  expect(app.secureDownloads()).toBe(1)
  expect(app.calls.some((c) => c.op === "download")).toBe(false)
  expect(app.calls.map((c) => c.op)).toEqual(["descriptor", "signature", "stage", "prepare", "cleanup"])
})

test("desktop HTTPS update uses verified proxy download and IPC, retaining normal preview/commit", async () => {
  const app = setup()
  const prepared = await app.operations.prepareInstallation(request)
  expect(app.calls.map((c) => c.op)).toEqual(["download", "stage", "prepare", "cleanup"])
  expect(app.calls.find((c) => c.op === "prepare")?.payload).toEqual({
    request,
    archive: { path: "/tmp/test-download.tgz", sha256 },
  })
  await app.operations.commitInstallation(prepared)
  await app.operations.installationStatus(prepared)
  await app.operations.cancelInstallation(prepared)
  expect(app.calls.slice(-3).map((c) => c.op)).toEqual(["commit", "status", "cancel"])
  expect(app.calls.some((c) => c.op.startsWith("http:"))).toBe(false)
})

test("desktop archive needs no user checksum and pins its computed digest before the IPC handoff", async () => {
  const app = setup()
  await app.operations.prepareInstallation({ ...request, source: { type: "archive", url: request.source.url } })
  expect(app.calls.find((c) => c.op === "prepare")?.payload.request.source).toEqual({
    type: "archive",
    url: request.source.url,
  })
  expect(app.calls.find((c) => c.op === "prepare")?.payload.archive).toEqual({ path: "/tmp/test-download.tgz", sha256 })
  expect(app.calls.map((c) => c.op)).toEqual(["download", "stage", "prepare", "cleanup"])
})

test("remote connections never use local IPC or download into the local registry", async () => {
  const app = setup()
  app.setRemote()
  const prepared = await app.operations.prepareInstallation(request)
  await app.operations.commitInstallation(prepared)
  expect(app.calls.map((c) => c.op)).toEqual(["http:prepareInstallation", "http:commitInstallation"])
})

test("a connection change during download cannot prepare or commit on another sidecar", async () => {
  const app = setup()
  app.afterDownload(app.changeConnection)
  await expect(app.operations.prepareInstallation(request)).rejects.toThrow(/server changed/)
  expect(app.calls.map((c) => c.op)).toEqual(["download"])
})

test("a digest mismatch cannot stage or prepare a package", async () => {
  const app = setup()
  await expect(
    app.operations.prepareInstallation({ ...request, source: { ...request.source, sha256: "a".repeat(64) } }),
  ).rejects.toThrow(/digest/)
  expect(app.calls.map((c) => c.op)).toEqual(["download"])
})

test("desktop release retains its source and hands the original descriptor to private IPC", async () => {
  const app = setup()
  const input = { kind: "install" as const, source: { type: "release" as const, url: releaseURL } }
  const prepared = await app.operations.prepareInstallation(input)
  expect(app.calls.map((c) => c.op)).toEqual(["descriptor", "signature", "download", "stage", "prepare", "cleanup"])
  expect(app.calls.find((c) => c.op === "prepare")?.payload).toEqual({
    request: input,
    release: { url: releaseURL, descriptor: descriptorText, signature: "sig-document", path: "/tmp/test-download.tgz" },
  })
  await app.operations.commitInstallation(prepared, { acceptRegistryUpgrade: true })
  expect(app.calls.at(-1)?.payload.input.acceptRegistryUpgrade).toBe(true)
})

test("release-current uses the saved descriptor and preserves its update target", async () => {
  const app = setup()
  const input = { kind: "update" as const, id: request.id, target: "release-current" as const }
  await app.operations.prepareInstallation(input)
  expect(app.calls.find((c) => c.op === "prepare")?.payload).toEqual({
    request: input,
    release: { url: releaseURL, descriptor: descriptorText, signature: "sig-document", path: "/tmp/test-download.tgz" },
  })
  expect(app.calls.some((c) => c.op.startsWith("http:"))).toBe(false)
})

test("a release declaring an incompatible engines range never reaches artifact download", async () => {
  const incompatible = JSON.stringify({
    schemaVersion: 1,
    id: "local.wls-repl",
    version: "1.18.64",
    engines: { opencode: ">=99.0.0" },
    artifact: { url: "https://github.com/example/release.tgz", sha256 },
  })
  const app = setup(false, { hostVersion: "1.18.64", descriptor: incompatible })
  await expect(
    app.operations.prepareInstallation({ kind: "install", source: { type: "release", url: releaseURL } }),
  ).rejects.toThrow(/requires opencode/)
  expect(app.calls.map((c) => c.op)).toEqual(["descriptor", "signature"])
})

test("a connection change during descriptor fetch stops before artifact download", async () => {
  const app = setup()
  app.afterDownload(app.changeConnection)
  await expect(
    app.operations.prepareInstallation({ kind: "install", source: { type: "release", url: releaseURL } }),
  ).rejects.toThrow(/server changed/)
  expect(app.calls.map((c) => c.op)).toEqual(["descriptor", "signature"])
})
