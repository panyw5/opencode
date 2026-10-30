import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { Cookie } from "electron"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"
import { sessionCookieFamily } from "../../resources/gpt-pro-login/common.js"

type Dependencies = {
  path: string
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  log(message: string): void
}

export class GptProCredentialVault {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: Dependencies) {}

  private check() {
    if (!this.deps.available()) {
      this.deps.log("credential-vault unavailable; refusing plaintext fallback")
      throw new GptProOperationError(
        "credential_storage",
        "The operating system's secure credential storage is unavailable. No plaintext fallback is allowed.",
      )
    }
  }
  async read(): Promise<Cookie[] | undefined> {
    this.check()
    let bytes: Buffer
    try {
      bytes = await readFile(this.deps.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new GptProOperationError("credential_storage", "The encrypted ChatGPT credential vault could not be read.")
    }
    try {
      if (bytes.length > 1024 * 1024) throw Error("oversized")
      const envelope = JSON.parse(bytes.toString("utf8"))
      if (envelope.version !== 1 || typeof envelope.encrypted !== "string") throw Error("format")
      const cookies = JSON.parse(this.deps.decrypt(Buffer.from(envelope.encrypted, "base64")))
      validateCookies(cookies)
      await chmod(this.deps.path, 0o600)
      this.deps.log(`credential-vault restored count=${cookies.length}; values omitted`)
      return restorableGptProCookies(cookies)
    } catch {
      throw new GptProOperationError(
        "credential_storage",
        "The encrypted ChatGPT credential vault could not be decrypted. It was preserved; reconnect after restoring secure storage.",
      )
    } finally {
      bytes.fill(0)
    }
  }
  write(cookies: Cookie[]): Promise<void> {
    this.check()
    validateCookies(cookies)
    // Encrypt before yielding; queued disk writes never retain plaintext snapshots.
    const encrypted = this.deps.encrypt(JSON.stringify(cookies))
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        const temp = `${this.deps.path}.${randomUUID()}.tmp`
        try {
          await mkdir(dirname(this.deps.path), { recursive: true, mode: 0o700 })
          await chmod(dirname(this.deps.path), 0o700)
          const file = await open(temp, "wx", 0o600)
          try {
            await file.writeFile(JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }))
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temp, this.deps.path)
          if (process.platform !== "win32") {
            const directory = await open(dirname(this.deps.path), "r")
            try {
              await directory.sync()
            } finally {
              await directory.close()
            }
          }
          this.deps.log(`credential-vault committed encrypted=true count=${cookies.length}`)
        } catch {
          throw new GptProOperationError(
            "credential_storage",
            "ChatGPT credentials could not be securely saved. The previous vault was preserved.",
          )
        } finally {
          encrypted.fill(0)
          await rm(temp, { force: true }).catch(() => {})
        }
      })
    this.tail = task
    return task
  }
}

// Dropping a single expired chunk must not restore a truncated login session.
export function restorableGptProCookies(cookies: Cookie[], now = Date.now() / 1000) {
  const groups = new Map<string, Cookie[]>()
  for (const cookie of cookies) {
    const family = sessionCookieFamily(cookie.name)
    if (!family) continue
    const key = `${cookie.domain}:${cookie.path}:${family}`
    const group = groups.get(key) ?? []
    group.push(cookie)
    groups.set(key, group)
  }
  const invalid = new Set<Cookie>()
  for (const group of groups.values()) {
    const family = sessionCookieFamily(group[0].name)!
    const whole = group.filter((cookie) => cookie.name === family)
    const indices = group.map((cookie) => Number(cookie.name.slice(family.length + 1))).sort((a, b) => a - b)
    if (
      group.some((cookie) => cookie.expirationDate !== undefined && cookie.expirationDate <= now) ||
      (whole.length ? group.length !== 1 : indices.some((index, position) => index !== position))
    )
      group.forEach((cookie) => invalid.add(cookie))
  }
  return cookies.filter(
    (cookie) => !invalid.has(cookie) && (cookie.expirationDate === undefined || cookie.expirationDate > now),
  )
}

function validateCookies(cookies: unknown): asserts cookies is Cookie[] {
  if (
    !Array.isArray(cookies) ||
    cookies.length > 256 ||
    cookies.some(
      (cookie) =>
        !cookie ||
        !["chatgpt.com", ".chatgpt.com"].includes(cookie.domain) ||
        typeof cookie.name !== "string" ||
        typeof cookie.value !== "string" ||
        typeof cookie.path !== "string" ||
        !cookie.path.startsWith("/") ||
        (cookie.expirationDate !== undefined && !Number.isFinite(cookie.expirationDate)),
    )
  )
    throw new GptProOperationError(
      "credential_storage",
      "The credential snapshot is unsupported; no values were logged or saved.",
    )
}
