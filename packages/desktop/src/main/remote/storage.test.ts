import { expect, test } from "bun:test"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { RemoteVault } from "./storage"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-remote-vault-test-"))
  const key = randomBytes(32)
  let available = true
  const logs: string[] = []
  const secure = {
    available: () => available,
    encrypt(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    decrypt(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8")
    },
  }
  const vault = new RemoteVault(join(directory, "secrets.enc"), secure, (line) => logs.push(line), isSnapshot)
  return {
    directory,
    vault,
    logs,
    secure,
    unavailable: () => {
      available = false
    },
  }
}

function isSnapshot(value: unknown): value is { token: string } {
  return Boolean(value && typeof value === "object" && typeof (value as any).token === "string")
}

test("remote vault stores encrypted data atomically with private permissions", async () => {
  const f = await fixture()
  try {
    const secret = { token: "SYNTHETIC_REMOTE_PRIVATE_KEY" }
    await f.vault.write(secret)
    const path = join(f.directory, "secrets.enc")
    expect(await readFile(path, "utf8")).not.toContain(secret.token)
    expect(await f.vault.read()).toEqual(secret)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700)
    expect(f.logs.join("\n")).not.toContain(secret.token)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test("remote vault refuses plaintext fallback when secure storage is unavailable", async () => {
  const f = await fixture()
  try {
    f.unavailable()
    expect(() => f.vault.write({ token: "secret" })).toThrow("Secure storage is unavailable")
    await expect(f.vault.read()).rejects.toThrow("Secure storage is unavailable")
    expect(f.logs.join("\n")).not.toContain("secret")
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test("explicit vault deletion does not require encryption availability", async () => {
  const f = await fixture()
  try {
    await f.vault.write({ token: "test-secret" })
    f.unavailable()
    await f.vault.clear()
    expect(await Bun.file(join(f.directory, "secrets.enc")).exists()).toBe(false)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test("serialized remote vault writes retain the last snapshot", async () => {
  const f = await fixture()
  try {
    await Promise.all([f.vault.write({ token: "first" }), f.vault.write({ token: "second" })])
    expect(await f.vault.read()).toEqual({ token: "second" })
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
