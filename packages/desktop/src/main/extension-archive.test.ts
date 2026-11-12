import { afterAll, describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  MAX_ARCHIVE_BYTES,
  MAX_DESCRIPTOR_BYTES,
  MAX_SIGNATURE_BYTES,
} from "@opencode-ai/util/extension-release"
// The desktop main process only re-validates shape/size/digest; the sidecar
// (opencode server) performs the Ed25519 check. These tests drive the shared
// trust implementation inside the fake sidecar so the IPC boundary is covered
// against the real T3.1 semantics with a generated publisher key.
import {
  signDescriptor,
  verifyDescriptorSignature,
  type TrustedKey,
} from "../../../opencode/src/extension/trust"

import type { IpcMain, Net } from "electron"
import {
  cleanupStagedArchive,
  registerExtensionArchiveIpcHandlers,
  stageArchiveBytes,
  type ExtensionArchiveServer as ArchiveServer,
} from "./extension-archive"

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, Handler>()

// The module takes ipcMain/net through deps, so no Electron runtime or module
// mock is needed; any ipc/net use would fail loudly in these fakes.
const ipcMain: Pick<IpcMain, "handle"> = {
  handle: (channel, listener) => {
    handlers.set(channel, listener as Handler)
  },
}
const net: Pick<Net, "request"> = {
  request: () => {
    throw new Error("electron net.request must not run in unit tests")
  },
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

const handle = (channel: string) => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`handler ${channel} is not registered`)
  return fn
}
const invoke = (channel: string, ...args: unknown[]) =>
  handle(channel)(null, ...args) as Promise<
    { ok: true; value: unknown } | { ok: false; error: { code?: string; message: string } }
  >
const op = (name: string, payload: unknown) => invoke("extension-archive-op", name, payload)

// The deps.server() lookup is resolved per call so tests can swap or drop the
// fake sidecar between cases.
let current: ArchiveServer = null
registerExtensionArchiveIpcHandlers({
  server: () => current,
  ipcMain,
  net,
})

type ArchiveCall = { op: string; payload: Record<string, unknown> }
function recordingSidecar(impl?: (op: string, payload: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: ArchiveCall[] = []
  const server: NonNullable<ArchiveServer> = {
    extensionArchive: async (name, payload) => {
      calls.push({ op: name, payload })
      return impl ? impl(name, payload) : { prepared: true }
    },
  }
  return { calls, server }
}

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempdir(prefix = "ext-archive-test-") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
async function staged(bytes: Uint8Array = new TextEncoder().encode("fake tgz payload")) {
  const result = await stageArchiveBytes(bytes)
  dirs.push(dirname(result.path))
  return result.path
}
const exists = (path: string) => stat(path).then(() => true, () => false)
async function waitForGone(path: string) {
  for (let i = 0; i < 100; i++) {
    if (!(await exists(path))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`expected ${path} to be removed`)
}

const SIGN_ORIGIN = "https://signed.example.test/"
const UNSIGNED_ORIGIN = "https://unsigned.example.test/"
const publisher = generateKeyPairSync("ed25519")
const privatePem = publisher.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
const publisherKey: TrustedKey = {
  keyId: `ed25519-${createHash("sha256")
    .update(publisher.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 16)}`,
  publicKey: publisher.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  origins: [SIGN_ORIGIN],
}
const trusted: readonly TrustedKey[] = [publisherKey]

/**
 * Emulates the sidecar's prepare contract: run the shared descriptor-signature
 * rules on the release payload the main process forwarded, and report the
 * signature status the server would.
 */
function verifyingSidecar() {
  return recordingSidecar(async (name, payload) => {
    if (name === "prepare" && payload.release) {
      const release = payload.release as { url: string; descriptor: string; signature?: string }
      const verified = verifyDescriptorSignature({
        url: release.url,
        descriptor: new TextEncoder().encode(release.descriptor),
        document: release.signature,
        keys: trusted,
      })
      return { signatureStatus: verified ? "verified" : "unsigned" }
    }
    return { prepared: true }
  })
}

function releasePayload(input: {
  path: string
  sha?: string
  url?: string
  descriptor?: unknown
  signature?: unknown
}) {
  return {
    request: { kind: "install", source: { type: "release", url: input.url ?? `${SIGN_ORIGIN}viewer/stable.json` } },
    release: {
      url: input.url ?? `${SIGN_ORIGIN}viewer/stable.json`,
      descriptor: input.descriptor ?? JSON.stringify({ artifact: { sha256: input.sha ?? "" } }),
      ...(input.signature === undefined ? {} : { signature: input.signature }),
      path: input.path,
    },
  }
}

describe("stage archive bytes", () => {
  test("persists bytes to a fresh staging directory as package.tgz with 0600 permissions", async () => {
    const bytes = new TextEncoder().encode("archive-bytes")
    const { path } = await stageArchiveBytes(bytes)
    dirs.push(dirname(path))
    expect(basename(path)).toBe("package.tgz")
    // The staging directory is always a fresh mkdtemp under the OS temp dir;
    // no caller input influences the file or directory name.
    expect(dirname(path).startsWith(join(tmpdir(), "opencode-ext-"))).toBe(true)
    const info = await stat(path)
    expect(info.size).toBe(bytes.byteLength)
    expect(info.mode & 0o777).toBe(0o600)
    expect(await invoke("extension-archive-digest", path)).toEqual({
      ok: true,
      value: { path, size: bytes.byteLength, sha256: sha256(bytes) },
    })
  })

  test("there is no caller-controlled filename: path-like payloads are rejected as bytes", async () => {
    for (const bytes of [undefined, null, "", "../../etc/passwd", "/tmp/evil.tgz", { path: "../x.tgz" }, new Uint8Array(0)]) {
      const result = await invoke("extension-archive-stage", bytes)
      expect(result.ok).toBe(false)
    }
    await expect(stageArchiveBytes("anything" as unknown as Uint8Array)).rejects.toThrow(/required/)
    await expect(stageArchiveBytes(new Uint8Array(0))).rejects.toThrow(/required/)
  })

  test("rejects archives larger than the shared MAX_ARCHIVE_BYTES limit", async () => {
    const bytes = new Uint8Array(MAX_ARCHIVE_BYTES + 1)
    await expect(stageArchiveBytes(bytes)).rejects.toThrow(/too large/)
    const result = await invoke("extension-archive-stage", bytes)
    expect(result.ok).toBe(false)
    expect((result as { error: { message: string } }).error.message).toMatch(/too large/)
  })
})

describe("staged archive cleanup whitelist", () => {
  test("cleanup removes the whole staging directory, once", async () => {
    const path = await staged()
    const dir = dirname(path)
    await cleanupStagedArchive(path)
    expect(await exists(dir)).toBe(false)
    // Second cleanup is a no-op (the path left the whitelist).
    await cleanupStagedArchive(path)
    expect(await invoke("extension-archive-cleanup", path)).toEqual({ ok: true, value: undefined })
  })

  test("non-staged absolute paths are never deleted, including through IPC", async () => {
    const dir = await tempdir()
    const victim = join(dir, "keep.tgz")
    await writeFile(victim, "must survive")
    await cleanupStagedArchive(victim)
    expect(await invoke("extension-archive-cleanup", victim)).toEqual({ ok: true, value: undefined })
    expect(await exists(victim)).toBe(true)
    for (const bad of [undefined, null, 42, "..", join(dir, "..")]) {
      await cleanupStagedArchive(bad as string)
      expect(await exists(victim)).toBe(true)
    }
  })

  test("a '..' respelling of a staged path misses the whitelist and deletes nothing", async () => {
    const path = await staged()
    const dir = dirname(path)
    // join() would normalize ".." away; build the traversal spelling by hand
    // so it resolves to the same file while missing the exact-path whitelist.
    const traversal = `${dir}/../${basename(dir)}/package.tgz`
    expect(traversal).not.toBe(path)
    await cleanupStagedArchive(traversal)
    expect(await invoke("extension-archive-cleanup", traversal)).toEqual({ ok: true, value: undefined })
    expect(await exists(path)).toBe(true)
  })

  test("a symlink pointing at a staged file cannot escape the whitelist", async () => {
    const path = await staged()
    const dir = await tempdir()
    const link = join(dir, "escape.tgz")
    await symlink(path, link)
    await cleanupStagedArchive(link)
    expect(await invoke("extension-archive-cleanup", link)).toEqual({ ok: true, value: undefined })
    // Neither the symlink target nor the staging directory was touched.
    expect(await exists(path)).toBe(true)
    expect(await exists(link)).toBe(true)
    // A symlink whose TARGET is a victim file is equally inert.
    const victimDir = await tempdir()
    const victim = join(victimDir, "victim.tgz")
    await writeFile(victim, "must survive")
    const victimLink = join(dir, "victim-link.tgz")
    await symlink(victim, victimLink)
    await cleanupStagedArchive(victimLink)
    expect(await exists(victim)).toBe(true)
  })
})

describe("prepare staged archive descriptor re-validation", () => {
  test("forwards a well-formed release to the sidecar once the staged digest matches", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const sha = sha256(await readFile(path))
    const payload = releasePayload({ path, sha })
    const result = await op("prepare", payload)
    expect(result).toEqual({ ok: true, value: { prepared: true } })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].op).toBe("prepare")
    expect(fake.calls[0].payload).toEqual(payload)
  })

  test("accepts an uppercase sha256 spelling and rejects digest mismatches", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const bytes = await readFile(path)
    expect(await op("prepare", releasePayload({ path, sha: sha256(bytes).toUpperCase() }))).toEqual({
      ok: true,
      value: { prepared: true },
    })
    const wrong = await op("prepare", releasePayload({ path, sha: sha256("other bytes") }))
    expect(wrong).toEqual({ ok: false, error: { code: "invalid", message: "Staged release validation failed" } })
    expect(fake.calls).toHaveLength(1)
  })

  test("rejects descriptors exceeding MAX_DESCRIPTOR_BYTES and honours the boundary", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const bytes = await readFile(path)
    const base = JSON.stringify({ artifact: { sha256: sha256(bytes) } })
    const pad = MAX_DESCRIPTOR_BYTES - Buffer.byteLength(base, "utf8")
    const boundary = base.slice(0, -1) + " ".repeat(pad) + "}"
    expect(Buffer.byteLength(boundary, "utf8")).toBe(MAX_DESCRIPTOR_BYTES)
    expect(await op("prepare", releasePayload({ path, descriptor: boundary }))).toEqual({
      ok: true,
      value: { prepared: true },
    })
    const over = base.slice(0, -1) + " ".repeat(pad + 1) + "}"
    const result = await op("prepare", releasePayload({ path, descriptor: over }))
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "Staged release validation failed" } })
    expect(fake.calls).toHaveLength(1)
  })

  test("rejects malformed descriptor JSON, missing/invalid artifact sha256 and non-staged paths", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const sha = sha256(await readFile(path))
    const elsewhere = join(await tempdir(), "elsewhere.tgz")
    await writeFile(elsewhere, "bytes")
    const cases: unknown[] = [
      releasePayload({ path, descriptor: "not json" }),
      releasePayload({ path, descriptor: JSON.stringify({ artifact: {} }) }),
      releasePayload({ path, descriptor: JSON.stringify({ artifact: { sha256: "not-hex" } }) }),
      releasePayload({ path, descriptor: JSON.stringify({ artifact: { sha256: 42 } }) }),
      releasePayload({ path: elsewhere, sha }),
      releasePayload({ path: `${dirname(path)}/../${basename(dirname(path))}/package.tgz`, sha }),
      { request: {}, release: { url: 42, descriptor: "{}", signature: undefined, path } },
      { request: {}, release: { url: `${SIGN_ORIGIN}v/stable.json`, descriptor: 42, path } },
      { request: {}, release: { url: `${SIGN_ORIGIN}v/stable.json`, descriptor: "{}", signature: 42, path } },
      { request: {}, release: { url: `${SIGN_ORIGIN}v/stable.json`, descriptor: "{}", signature: "x".repeat(MAX_SIGNATURE_BYTES + 1), path } },
      { request: {}, release: { url: `${SIGN_ORIGIN}v/stable.json`, descriptor: "{}", signature: null, path } },
    ]
    for (const payload of cases) {
      expect(await op("prepare", payload)).toEqual({
        ok: false,
        error: { code: "invalid", message: "Staged release validation failed" },
      })
    }
    expect(fake.calls).toHaveLength(0)
  })

  test("archive payloads verify the staged digest and report mismatches as integrity errors", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const sha = sha256(await readFile(path))
    expect(await op("prepare", { request: {}, archive: { path, sha256: sha } })).toEqual({
      ok: true,
      value: { prepared: true },
    })
    for (const archive of [
      { path, sha256: sha256("other") },
      { path, sha256: "not-hex" },
      { path: join(await tempdir(), "unstaged.tgz"), sha256: sha },
      { sha256: sha },
    ]) {
      expect(await op("prepare", { request: {}, archive })).toEqual({
        ok: false,
        error: { code: "integrity", message: "Archive digest does not match the requested sha256" },
      })
    }
    expect(fake.calls).toHaveLength(1)
  })

  test("local payloads verify the user-picked file digest without staging", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const dir = await tempdir()
    const path = join(dir, "picked.tgz")
    await writeFile(path, "picked bytes")
    const request = { kind: "install", source: { type: "local", path, sha256: sha256("picked bytes") } }
    expect(await op("prepare", { request })).toEqual({ ok: true, value: { prepared: true } })
    expect(fake.calls[0].payload).toEqual({ request })
    const bad = { kind: "install", source: { type: "local", path, sha256: sha256("different") } }
    expect(await op("prepare", { request: bad })).toEqual({
      ok: false,
      error: { code: "integrity", message: "Archive digest does not match the requested sha256" },
    })
    for (const request of [{}, { source: { type: "local" } }, { source: { type: "local", path } }]) {
      expect(await op("prepare", { request })).toEqual({
        ok: false,
        error: { message: "Local archive request requires a path and sha256" },
      })
    }
  })

  test("reports a missing sidecar and propagates sidecar error codes", async () => {
    current = null
    expect(await op("prepare", { request: {} })).toEqual({
      ok: false,
      error: { message: "Server is not running" },
    })
    const fake = recordingSidecar(async () => {
      const error = new Error("Extension release signature: signature does not match the descriptor")
      ;(error as Error & { code?: string }).code = "signature_invalid"
      throw error
    })
    current = fake.server
    expect(await op("status", { operationId: "op-1" })).toEqual({
      ok: false,
      error: { code: "signature_invalid", message: "Extension release signature: signature does not match the descriptor" },
    })
  })

  test("commit and cancel evict the staged source file", async () => {
    const fake = recordingSidecar()
    current = fake.server
    const path = await staged()
    const dir = dirname(path)
    await op("commit", { request: { source: { path } }, operationId: "op-1", token: "t" })
    await waitForGone(dir)
    // After eviction the same path no longer passes prepare validation.
    const second = await staged()
    const sha = sha256(await readFile(second))
    const stale = releasePayload({ path, sha })
    expect(await op("prepare", stale)).toEqual({
      ok: false,
      error: { code: "invalid", message: "Staged release validation failed" },
    })
    await op("cancel", { request: { source: { path: second } }, operationId: "op-2" })
    await waitForGone(dirname(second))
  })
})

describe("release signature channel (T3.1 semantics)", () => {
  test("a trusted origin with a valid signature verifies end to end", async () => {
    const fake = verifyingSidecar()
    current = fake.server
    const path = await staged()
    const bytes = await readFile(path)
    const descriptor = JSON.stringify({
      schemaVersion: 1,
      id: "test.signed",
      version: "1.0.0",
      artifact: { url: "https://cdn.example.test/a.tgz", sha256: sha256(bytes) },
    })
    const signature = signDescriptor(new TextEncoder().encode(descriptor), privatePem).document
    const result = await op("prepare", releasePayload({ path, descriptor, signature }))
    expect(result).toEqual({ ok: true, value: { signatureStatus: "verified" } })
    const forwarded = fake.calls[0].payload.release as { signature?: string }
    expect(forwarded.signature).toBe(signature)
  })

  test("a trusted origin with an invalid or missing signature surfaces signature_invalid", async () => {
    const fake = verifyingSidecar()
    current = fake.server
    const path = await staged()
    const bytes = await readFile(path)
    const descriptor = JSON.stringify({ artifact: { sha256: sha256(bytes) } })
    // Signature made over different bytes: well-formed but does not verify.
    const forged = signDescriptor(new TextEncoder().encode("other descriptor"), privatePem).document
    for (const signature of [forged, JSON.stringify({ keyId: "ed25519-unknown", signature: "AAAA" }), "not json"]) {
      const result = await op("prepare", releasePayload({ path, descriptor, signature }))
      expect(result.ok).toBe(false)
      expect((result as { error: { code?: string } }).error.code).toBe("signature_invalid")
    }
    // No signature at all: trusted origins must be signed.
    const unsigned = await op("prepare", releasePayload({ path, descriptor }))
    expect(unsigned.ok).toBe(false)
    expect((unsigned as { error: { code?: string } }).error.code).toBe("signature_invalid")
  })

  test("a non-trusted origin installs through the unsigned-source path", async () => {
    const fake = verifyingSidecar()
    current = fake.server
    const path = await staged()
    const bytes = await readFile(path)
    const descriptor = JSON.stringify({ artifact: { sha256: sha256(bytes) } })
    const result = await op(
      "prepare",
      releasePayload({ path, descriptor, url: `${UNSIGNED_ORIGIN}viewer/stable.json` }),
    )
    expect(result).toEqual({ ok: true, value: { signatureStatus: "unsigned" } })
    // A signature is optional for unsigned origins but still passes through.
    const signature = signDescriptor(new TextEncoder().encode(descriptor), privatePem).document
    const signed = await op(
      "prepare",
      releasePayload({ path, descriptor, signature, url: `${UNSIGNED_ORIGIN}viewer/stable.json` }),
    )
    expect(signed).toEqual({ ok: true, value: { signatureStatus: "unsigned" } })
  })
})

describe("download and digest channels", () => {
  test("download rejects non-string and overlong URLs before touching the network", async () => {
    for (const url of [undefined, null, 42, "x".repeat(16_385)]) {
      const result = await invoke("extension-archive-download", url)
      expect(result.ok).toBe(false)
    }
  })

  test("digest rejects non-tgz paths", async () => {
    const dir = await tempdir()
    const file = join(dir, "demo.zip")
    await writeFile(file, "zip")
    const result = await invoke("extension-archive-digest", file)
    expect(result.ok).toBe(false)
    expect((result as { error: { message: string } }).error.message).toMatch(/\.tgz/)
  })
})
