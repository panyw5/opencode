import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash, generateKeyPairSync } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import tar from "tar-stream"
import { createInstaller, InstallError, type InstallerOptions } from "../../src/extension/install"
import * as Registry from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"
import { requestJsonDocument, type DownloadTransport } from "../../src/extension/download"
import { resolveRelease } from "../../src/extension/release"
import {
  SignatureError,
  signDescriptor,
  trustedKeysFor,
  verifyDescriptorSignature,
  type TrustedKey,
} from "../../src/extension/trust"

/**
 * T3.1/T3.2 trust-chain coverage:
 *  - detached Ed25519 signature over the exact stable.json bytes
 *  - trusted origins must verify; other origins stay unsigned but installable
 *  - signed publisher sequence never moves backwards on release-current
 */

const id = ExtensionID.make("test.signed-release")
const ORIGIN = "https://signed.example.test/"
const descriptorURL = `${ORIGIN}viewer/stable.json`
const unsignedURL = "https://unsigned.example.test/viewer/stable.json"
const artifactURL = "https://cdn.example.test/extension.tgz?signature=PRIVATE"
const publicIP = { address: "93.184.216.34", family: 4 } as const

const publisher = generateKeyPairSync("ed25519")
const privatePem = publisher.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
const publisherKey: TrustedKey = {
  keyId: `ed25519-${createHash("sha256")
    .update(publisher.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")
    .slice(0, 16)}`,
  publicKey: publisher.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  origins: [ORIGIN],
}
const trusted: readonly TrustedKey[] = [publisherKey]

const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

function descriptor(input: { version?: string; sequence?: number; sha256?: string } = {}) {
  const body: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    version: input.version ?? "1.0.0",
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    artifact: { url: artifactURL, sha256: input.sha256 ?? "ab".repeat(32) },
  }
  return JSON.stringify(body)
}

function serve(files: Record<string, Uint8Array | undefined>) {
  const requests: string[] = []
  const transport: DownloadTransport = {
    lookup: async () => [publicIP],
    async request(input) {
      requests.push(input.url.href)
      const bytes = files[input.url.pathname]
      if (!bytes) return { status: 404, headers: {}, body: (async function* () {})() }
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield bytes
        })(),
      }
    },
  }
  return {
    requests,
    fetch: (url: string, options?: Parameters<typeof requestJsonDocument>[1]) =>
      requestJsonDocument(url, { ...options, transport }),
  }
}

async function fixture(version = "1.0.0") {
  const pkg = {
    name: "signed-release-extension",
    version,
    exports: { "./web": "./web.js" },
    opencode: {
      manifestVersion: 1,
      id,
      displayName: "Signed Release Fixture",
      web: { apiVersion: 1 },
      permissions: [],
      contributes: {},
    },
  }
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const completed = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk))
  })()
  for (const [name, content] of Object.entries({
    "package.json": JSON.stringify(pkg),
    "web.js": "throw new Error('extension must not execute during installation')",
  })) {
    pack.entry({ name: `package/${name}`, mode: 0o777 }, content)
  }
  pack.finalize()
  await completed
  return { bytes: gzipSync(Buffer.concat(chunks)), pkg }
}

const roots: string[] = []
const installers: ReturnType<typeof createInstaller>[] = []
afterEach(async () => {
  await Promise.all(installers.splice(0).map((installer) => installer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(options: InstallerOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-signed-release-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  const installer = createInstaller({ registry, trustedKeys: trusted, ...options })
  installers.push(installer)
  async function staged(input: { version?: string; sequence?: number; sign?: boolean; bytes?: Uint8Array } = {}) {
    const { bytes } = input.bytes ? { bytes: input.bytes } : await fixture(input.version ?? "1.0.0")
    const file = path.join(root, `staged-${Math.random().toString(36).slice(2)}.tgz`)
    await writeFile(file, bytes)
    const text = descriptor({ version: input.version, sequence: input.sequence, sha256: sha(bytes) })
    const signature = input.sign === false ? undefined : signDescriptor(Buffer.from(text), privatePem).document
    return { bytes, file, descriptor: text, signature }
  }
  return { root, registry, installer, staged }
}

describe("release descriptor signature", () => {
  test("a trusted origin resolves a signed descriptor and reports the signing key", async () => {
    const text = descriptor({ sequence: 7 })
    const signed = signDescriptor(Buffer.from(text), privatePem)
    const f = serve({
      "/viewer/stable.json": Buffer.from(text),
      "/viewer/stable.json.sig": Buffer.from(signed.document),
    })
    const result = await resolveRelease(descriptorURL, { transport: f.fetch, trustedKeys: trusted })
    expect(result.signature).toEqual({ keyId: publisherKey.keyId })
    expect(result.sequence).toBe(7)
    expect(result.descriptorSha256).toBe(sha(Buffer.from(text)))
    expect(f.requests).toEqual([descriptorURL, `${descriptorURL}.sig`])
  })

  test("a single tampered descriptor byte fails verification", async () => {
    const text = descriptor()
    const signed = signDescriptor(Buffer.from(text), privatePem)
    // Flip exactly one byte inside the version so the descriptor stays valid JSON.
    const tampered = Buffer.from(text.replace('"1.0.0"', '"1.0.1"'))
    const f = serve({
      "/viewer/stable.json": tampered,
      "/viewer/stable.json.sig": Buffer.from(signed.document),
    })
    const error = await resolveRelease(descriptorURL, { transport: f.fetch, trustedKeys: trusted }).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(SignatureError)
    expect((error as SignatureError).code).toBe("signature_invalid")
  })

  test("an unknown keyId fails even when the signature itself is well formed", async () => {
    const text = descriptor()
    const other = generateKeyPairSync("ed25519")
    const forged = signDescriptor(Buffer.from(text), other.privateKey.export({ format: "pem", type: "pkcs8" }).toString())
    const f = serve({
      "/viewer/stable.json": Buffer.from(text),
      "/viewer/stable.json.sig": Buffer.from(forged.document),
    })
    await expect(resolveRelease(descriptorURL, { transport: f.fetch, trustedKeys: trusted })).rejects.toBeInstanceOf(
      SignatureError,
    )
    // A known keyId under a different origin prefix is not trusted for this one.
    const narrowed: TrustedKey = { ...publisherKey, origins: ["https://elsewhere.example.test/"] }
    const unsigned = await resolveRelease(descriptorURL, { transport: f.fetch, trustedKeys: [narrowed] })
    expect(unsigned.signature).toBeUndefined()
  })

  test("a missing or malformed .sig rejects the trusted origin without signature contents in the error", async () => {
    const text = descriptor()
    for (const sig of [
      undefined,
      Buffer.from("not json"),
      Buffer.from(JSON.stringify({ keyId: publisherKey.keyId, signature: "AAA=" })),
      Buffer.from(JSON.stringify({ keyId: publisherKey.keyId, signature: "AAAA", extra: true })),
      Buffer.from(JSON.stringify({ keyId: "../" + publisherKey.keyId, signature: "AAAA" })),
    ]) {
      const f = serve({ "/viewer/stable.json": Buffer.from(text), "/viewer/stable.json.sig": sig })
      const error = await resolveRelease(descriptorURL, { transport: f.fetch, trustedKeys: trusted }).catch(
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(SignatureError)
      expect((error as SignatureError).code).toBe("signature_invalid")
      expect(String(error)).not.toContain("AAA")
      expect(String(error)).not.toContain(text)
    }
  })

  test("untrusted origins resolve without a signature and stay unsigned", async () => {
    const f = serve({ "/viewer/stable.json": Buffer.from(descriptor()) })
    const result = await resolveRelease(unsignedURL, { transport: f.fetch, trustedKeys: trusted })
    expect(result.signature).toBeUndefined()
    expect(f.requests).toEqual([unsignedURL])
  })

  test("key rotation accepts any pinned key covering the origin", async () => {
    const rotated = generateKeyPairSync("ed25519")
    const rotatedDer = rotated.publicKey.export({ format: "der", type: "spki" })
    const rotatedKey: TrustedKey = {
      keyId: `ed25519-${createHash("sha256").update(rotatedDer).digest("hex").slice(0, 16)}`,
      publicKey: rotatedDer.toString("base64"),
      origins: [ORIGIN],
    }
    const text = descriptor()
    const signed = signDescriptor(
      Buffer.from(text),
      rotated.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    )
    const f = serve({
      "/viewer/stable.json": Buffer.from(text),
      "/viewer/stable.json.sig": Buffer.from(signed.document),
    })
    const result = await resolveRelease(descriptorURL, {
      transport: f.fetch,
      trustedKeys: [publisherKey, rotatedKey],
    })
    expect(result.signature).toEqual({ keyId: rotatedKey.keyId })
  })

  test("verifyDescriptorSignature returns undefined outside trusted origins", () => {
    expect(trustedKeysFor(unsignedURL, trusted)).toHaveLength(0)
    expect(
      verifyDescriptorSignature({
        url: unsignedURL,
        descriptor: Buffer.from(descriptor()),
        document: "missing",
        keys: trusted,
      }),
    ).toBeUndefined()
  })
})

describe("staged release signature verification", () => {
  const installRequest = { kind: "install" as const, source: { type: "release" as const, url: descriptorURL } }

  test("a signed staged release verifies and reports signatureStatus verified", async () => {
    const context = await setup()
    const payload = await context.staged()
    const prepared = await context.installer.prepareRelease(installRequest, {
      url: descriptorURL,
      descriptor: payload.descriptor,
      signature: payload.signature,
      path: payload.file,
    })
    expect(prepared.signatureStatus).toBe("verified")
    expect((await context.installer.commit(prepared.operationId, prepared.token, {
      acceptRegistryUpgrade: true,
    })).committed).toBe(true)
  })

  test("a trusted-origin staged release without a signature is rejected", async () => {
    const context = await setup()
    const payload = await context.staged({ sign: false })
    const error = await context.installer
      .prepareRelease(installRequest, {
        url: descriptorURL,
        descriptor: payload.descriptor,
        path: payload.file,
      })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(InstallError)
    expect((error as InstallError).code).toBe("signature_invalid")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
  })

  test("a tampered staged descriptor under a trusted origin is rejected", async () => {
    const context = await setup()
    const payload = await context.staged()
    // The signature was made over the original bytes; flip one byte afterwards.
    const tampered = payload.descriptor.replace('"1.0.0"', '"1.0.1"')
    const error = await context.installer
      .prepareRelease(installRequest, {
        url: descriptorURL,
        descriptor: tampered,
        signature: payload.signature,
        path: payload.file,
      })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(InstallError)
    expect((error as InstallError).code).toBe("signature_invalid")
  })

  test("a staged release from an untrusted origin installs unsigned", async () => {
    const context = await setup()
    const payload = await context.staged({ sign: false })
    const url = "https://unsigned.example.test/viewer/stable.json"
    const prepared = await context.installer.prepareRelease(
      { kind: "install", source: { type: "release", url } },
      { url, descriptor: payload.descriptor, path: payload.file },
    )
    expect(prepared.signatureStatus).toBe("unsigned")
  })
})

describe("release sequence rollback protection", () => {
  const installRequest = { kind: "install" as const, source: { type: "release" as const, url: descriptorURL } }
  const updateRequest = { kind: "update" as const, id, target: "release-current" as const }

  async function installAt(context: Awaited<ReturnType<typeof setup>>, version: string, sequence: number) {
    const payload = await context.staged({ version, sequence })
    const prepared = await context.installer.prepareRelease(installRequest, {
      url: descriptorURL,
      descriptor: payload.descriptor,
      signature: payload.signature,
      path: payload.file,
    })
    expect(prepared.releaseSequence).toBe(sequence)
    expect(
      (await context.installer.commit(prepared.operationId, prepared.token, { acceptRegistryUpgrade: true }))
        .committed,
    ).toBe(true)
    return payload
  }

  async function updateAt(context: Awaited<ReturnType<typeof setup>>, version: string, sequence: number) {
    const payload = await context.staged({ version, sequence })
    return context.installer.prepareRelease(updateRequest, {
      url: descriptorURL,
      descriptor: payload.descriptor,
      signature: payload.signature,
      path: payload.file,
    })
  }

  test("a lower signed sequence is rejected with rollback_detected and leaves the registry untouched", async () => {
    const context = await setup()
    await installAt(context, "1.0.0", 5)
    const error = await updateAt(context, "1.1.0", 4).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(InstallError)
    expect((error as InstallError).code).toBe("rollback_detected")
    const row = (await Registry.snapshot(id, context.registry)).row
    expect(row?.version).toBe("1.0.0")
    expect(row?.releaseSequence).toBe(5)
  })

  test("an equal sequence is idempotent and a higher sequence proceeds", async () => {
    const context = await setup()
    await installAt(context, "1.0.0", 5)
    const same = await updateAt(context, "1.0.0", 5)
    expect(same.releaseSequence).toBe(5)
    expect(same.versionChange).toBe("same-version")
    expect((await context.installer.commit(same.operationId, same.token)).committed).toBe(true)
    const next = await updateAt(context, "1.1.0", 6)
    expect((await context.installer.commit(next.operationId, next.token)).committed).toBe(true)
    const row = (await Registry.snapshot(id, context.registry)).row
    expect(row?.version).toBe("1.1.0")
    expect(row?.releaseSequence).toBe(6)
  })

  test("online release resolution also rejects a rollback on release-current", async () => {
    const context = await setup()
    await installAt(context, "1.0.0", 9)
    const { bytes } = await fixture("1.1.0")
    const text = descriptor({ version: "1.1.0", sequence: 8, sha256: sha(bytes) })
    const signed = signDescriptor(Buffer.from(text), privatePem)
    const f = serve({
      "/viewer/stable.json": Buffer.from(text),
      "/viewer/stable.json.sig": Buffer.from(signed.document),
    })
    const installer = createInstaller({
      registry: context.registry,
      trustedKeys: trusted,
      resolveRelease: (url, options) => resolveRelease(url, { ...options, transport: f.fetch }),
      download: async () => bytes,
    })
    installers.push(installer)
    const error = await installer.prepare(updateRequest).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(InstallError)
    expect((error as InstallError).code).toBe("rollback_detected")
  })

  test("explicit-source updates are not gated by the sequence guard", async () => {
    const context = await setup()
    await installAt(context, "1.0.0", 5)
    // An explicit version/source preview may legitimately move backwards.
    const { bytes } = await fixture("0.9.0")
    const text = descriptor({ version: "0.9.0", sequence: 1, sha256: sha(bytes) })
    const signed = signDescriptor(Buffer.from(text), privatePem)
    const f = serve({
      "/viewer/stable.json": Buffer.from(text),
      "/viewer/stable.json.sig": Buffer.from(signed.document),
    })
    const installer = createInstaller({
      registry: context.registry,
      trustedKeys: trusted,
      resolveRelease: (url, options) => resolveRelease(url, { ...options, transport: f.fetch }),
      download: async () => bytes,
    })
    installers.push(installer)
    const prepared = await installer.prepare({
      kind: "update",
      id,
      source: { type: "release", url: descriptorURL },
    })
    expect(prepared.versionChange).toBe("downgrade")
    expect(prepared.releaseSequence).toBe(1)
  })
})
