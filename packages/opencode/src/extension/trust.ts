import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import { MAX_SIGNATURE_BYTES } from "@opencode-ai/util/extension-release"

export type TrustedKey = {
  /** Stable identifier carried inside the .sig envelope; derived from the public key. */
  keyId: string
  /** Base64-encoded DER SPKI Ed25519 public key. */
  publicKey: string
  /** Normalized HTTPS descriptor URL prefixes this key must sign for. */
  origins: readonly string[]
}

/** A required descriptor signature failed; the code is the only safe detail to surface. */
export class SignatureError extends Error {
  override readonly name = "ExtensionSignatureError"
  readonly code = "signature_invalid" as const
}

export { MAX_SIGNATURE_BYTES }

/**
 * Host-pinned publisher keys. A descriptor URL inside one of these origins MUST
 * carry a valid detached signature; origins outside the list keep the previous
 * unsigned behaviour (the installer marks them as an unsigned source). Multiple
 * entries allow rotation: the .sig envelope selects the key by keyId.
 */
export const TRUSTED_KEYS: readonly TrustedKey[] = [
  {
    keyId: "ed25519-e1b01f86f6422244",
    publicKey: "MCowBQYDK2VwAyEAhEXjTYkeVC4fm94fF8gsIpc5LCuWCdXir3hr1N3vMhY=",
    origins: ["https://raw.githubusercontent.com/panyw5/open-extensions/"],
  },
]

/** Keys whose origins cover the (already normalized) descriptor URL. */
export function trustedKeysFor(url: string, keys: readonly TrustedKey[] = TRUSTED_KEYS): TrustedKey[] {
  return keys.filter((key) => key.origins.some((origin) => url.startsWith(origin)))
}

/** The detached signature sits next to the descriptor: stable.json → stable.json.sig. */
export function signatureURL(descriptor: string): string {
  return `${descriptor}.sig`
}

function keyIdOf(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" })
  return `ed25519-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`
}

/** OPENCODE_EXTENSION_SIGNING_KEY accepts PKCS8 PEM or base64 DER; it is never logged. */
function signingKey(material: string): KeyObject {
  const trimmed = material.trim()
  try {
    if (trimmed.startsWith("-----BEGIN")) return createPrivateKey(trimmed)
    return createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" })
  } catch {
    throw new Error("Extension signing key must be an Ed25519 PKCS8 PEM or base64 DER")
  }
}

/**
 * Sign the exact raw descriptor bytes. The returned document is written verbatim
 * as stable.json.sig; keyId is derived from the public key so it always matches
 * the pinned trust entry.
 */
export function signDescriptor(descriptor: Uint8Array, material: string): { keyId: string; document: string } {
  const key = signingKey(material)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Extension signing key must be Ed25519")
  const signature = sign(null, Buffer.from(descriptor), key)
  const keyId = keyIdOf(createPublicKey(key))
  return {
    keyId,
    document: `${JSON.stringify({ keyId, signature: signature.toString("base64") }, null, 2)}\n`,
  }
}

function fail(message: string): never {
  // Signature failures never echo envelope bytes, key material or URLs.
  throw new SignatureError(`Extension release signature: ${message}`)
}

function envelope(value: unknown): { keyId: string; signature: Buffer } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid signature structure")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail("invalid signature structure")
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || keys.some((key) => typeof key !== "string" || !["keyId", "signature"].includes(key)))
    fail("signature fields must be exactly keyId and signature")
  const document = value as { keyId: unknown; signature: unknown }
  if (typeof document.keyId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(document.keyId))
    fail("invalid signature key id")
  if (typeof document.signature !== "string") fail("invalid signature encoding")
  const signature = Buffer.from(document.signature, "base64")
  // Round-tripping enforces canonical base64 (no whitespace, comments or odd padding).
  if (signature.length !== 64 || signature.toString("base64") !== document.signature)
    fail("invalid signature encoding")
  return { keyId: document.keyId, signature }
}

/**
 * Verify a descriptor against the pinned keys for its origin. Returns the keyId
 * that signed it; undefined when the origin is not covered by any trusted key
 * (an unsigned source). Any failure to verify a covered origin throws.
 * `document` may be the parsed .sig JSON, its raw bytes or its text.
 */
export function verifyDescriptorSignature(input: {
  url: string
  descriptor: Uint8Array
  document: unknown
  keys?: readonly TrustedKey[]
}): { keyId: string } | undefined {
  const trusted = trustedKeysFor(input.url, input.keys)
  if (!trusted.length) return undefined
  let value = input.document
  if (typeof value === "string" || value instanceof Uint8Array) {
    try {
      const text = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value)
      value = JSON.parse(text)
    } catch {
      fail("signature is not valid JSON")
    }
  }
  const signed = envelope(value)
  const key = trusted.find((item) => item.keyId === signed.keyId)
  if (!key) fail("signature key is not trusted for this origin")
  let ok = false
  try {
    ok = verify(
      null,
      Buffer.from(input.descriptor),
      createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" }),
      signed.signature,
    )
  } catch {
    ok = false
  }
  if (!ok) fail("signature does not match the descriptor")
  return { keyId: signed.keyId }
}

export * as ExtensionTrust from "./trust"
