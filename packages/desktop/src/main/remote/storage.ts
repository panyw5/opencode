import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

export type SecureStorage = {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

/** Encrypted, atomic persistence for remote identities and gateway auth metadata. */
export class RemoteVault<T> {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly secure: SecureStorage,
    private readonly log: (message: string) => void,
    private readonly validate: (value: unknown) => value is T,
  ) {}

  private assertAvailable() {
    if (this.secure.available()) return
    this.log("remote-vault secure-storage-unavailable; plaintext-fallback=refused")
    throw new Error("Secure storage is unavailable. Remote access secrets were not persisted.")
  }

  async read(): Promise<T | undefined> {
    this.assertAvailable()
    let bytes: Buffer
    try {
      bytes = await readFile(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error("Remote access secure storage could not be read.")
    }
    try {
      if (bytes.length > 4 * 1024 * 1024) throw new Error("oversized")
      const envelope: unknown = JSON.parse(bytes.toString("utf8"))
      if (
        !envelope ||
        typeof envelope !== "object" ||
        (envelope as any).version !== 1 ||
        typeof (envelope as any).encrypted !== "string"
      )
        throw new Error("format")
      const plaintext = Buffer.from(this.secure.decrypt(Buffer.from((envelope as any).encrypted, "base64")))
      try {
        const value: unknown = JSON.parse(plaintext.toString("utf8"))
        if (!this.validate(value)) throw new Error("schema")
        await chmod(this.path, 0o600)
        this.log("remote-vault restored encrypted=true")
        return value
      } finally {
        plaintext.fill(0)
      }
    } catch {
      this.log("remote-vault decrypt-or-validation-failed; existing-file=preserved")
      throw new Error("Remote access secure storage could not be decrypted. Existing data was preserved.")
    } finally {
      bytes.fill(0)
    }
  }

  write(value: T): Promise<void> {
    this.assertAvailable()
    if (!this.validate(value)) throw new Error("Remote access secure storage rejected invalid data.")
    const plaintext = JSON.stringify(value)
    const encrypted = this.secure.encrypt(plaintext)
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        const directory = dirname(this.path)
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await chmod(directory, 0o700)
          const file = await open(temporary, "wx", 0o600)
          try {
            await file.writeFile(JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }))
            await file.sync()
          } finally {
            await file.close()
          }
          await rename(temporary, this.path)
          this.log("remote-vault committed encrypted=true")
        } catch {
          throw new Error("Remote access secrets could not be securely saved.")
        } finally {
          await rm(temporary, { force: true }).catch(() => {})
        }
      })
    this.tail = task.finally(() => encrypted.fill(0))
    return task
  }

  async clear(): Promise<void> {
    await this.tail.catch(() => {})
    await rm(this.path, { force: true })
    this.log("remote-vault cleared")
  }
}
