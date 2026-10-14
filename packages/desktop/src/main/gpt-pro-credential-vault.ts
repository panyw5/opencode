import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { Cookie } from "electron"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"

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
      return cookies.filter(
        (cookie: Cookie) => cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000,
      )
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
