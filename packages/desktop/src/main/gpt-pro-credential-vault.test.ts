import { expect, test } from "bun:test"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Cookie } from "electron"
import { GptProCredentialVault, restorableGptProCookies } from "./gpt-pro-credential-vault"

const cookies: Cookie[] = [
  {
    name: "__Secure-next-auth.session-token",
    value: "SYNTHETIC_SECRET_DO_NOT_PERSIST_PLAINTEXT",
    domain: ".chatgpt.com",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: true,
    sameSite: "lax",
  },
]

test("restore rejects incomplete, mixed and partially expired Cookie families as a whole", () => {
  const base = cookies[0]
  const chunk = (index: number, extra: Partial<Cookie> = {}) => ({ ...base, name: `${base.name}.${index}`, ...extra })
  expect(restorableGptProCookies([chunk(0), chunk(1)], 100)).toHaveLength(2)
  for (const group of [[chunk(0), chunk(2)], [chunk(0), chunk(1, { expirationDate: 50 })], [base, chunk(0)]])
    expect(restorableGptProCookies(group, 100)).toEqual([])
  expect(restorableGptProCookies([chunk(0), chunk(1), { ...base, domain: "chatgpt.com" }], 100)).toHaveLength(3)
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-credential-vault-test-"))
  const key = randomBytes(32)
  let available = true
  const logs: string[] = []
  const deps = {
    path: join(directory, "credentials.enc"),
    available: () => available,
    encrypt(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(value: Buffer) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8")
    },
    log: (message: string) => logs.push(message),
  }
  return {
    directory,
    deps,
    logs,
    vault: new GptProCredentialVault(deps),
    unavailable: () => {
      available = false
    },
  }
}

test("vault round-trips encrypted cookies without plaintext on disk or in logs", async () => {
  const f = await fixture()
  try {
    await f.vault.write(cookies)
    expect(await readFile(f.deps.path, "utf8")).not.toContain(cookies[0].value)
    expect(f.logs.join("\n")).not.toContain(cookies[0].value)
    expect(await new GptProCredentialVault(f.deps).read()).toEqual(cookies)
    expect((await stat(f.deps.path)).mode & 0o777).toBe(0o600)
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test("unavailable secure storage refuses both reads and plaintext writes", async () => {
  const f = await fixture()
  try {
    f.unavailable()
    expect(() => f.vault.write(cookies)).toThrow("credential_storage")
    await expect(f.vault.read()).rejects.toThrow("credential_storage")
    expect(await Bun.file(f.deps.path).exists()).toBe(false)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test("serialized encrypted writes retain the newest snapshot across restart", async () => {
  const f = await fixture()
  try {
    const next = [{ ...cookies[0], value: "SYNTHETIC_ROTATED_SECRET" }]
    await Promise.all([f.vault.write(cookies), f.vault.write(next)])
    expect(await new GptProCredentialVault(f.deps).read()).toEqual(next)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test("failed encryption leaves the previous vault intact", async () => {
  const f = await fixture()
  try {
    await f.vault.write(cookies)
    const before = await readFile(f.deps.path)
    const failing = new GptProCredentialVault({
      ...f.deps,
      encrypt: () => {
        throw Error("synthetic OS failure")
      },
    })
    expect(() => failing.write(cookies)).toThrow()
    expect(await readFile(f.deps.path)).toEqual(before)
    expect(await f.vault.read()).toEqual(cookies)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test("corrupt vaults are preserved and never silently replaced by an empty login", async () => {
  const f = await fixture()
  try {
    await writeFile(f.deps.path, "corrupt", { mode: 0o600 })
    await expect(f.vault.read()).rejects.toThrow("credential_storage")
    expect(await readFile(f.deps.path, "utf8")).toBe("corrupt")
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
test("expired credentials are filtered while session-only cookies survive encrypted restart", async () => {
  const f = await fixture()
  try {
    await f.vault.write([...cookies, { ...cookies[0], name: "expired", session: false, expirationDate: 1 }])
    expect(await f.vault.read()).toEqual(cookies)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})
