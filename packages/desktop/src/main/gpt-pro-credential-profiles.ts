import { randomUUID } from "node:crypto"
import type { Cookie } from "electron"
import { GPT_PRO_PARTITION } from "@opencode-ai/util/gpt-pro"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"
import { importSessionCookies, type CookieJar, type SessionCookie } from "./gpt-pro-session-cookies"

type Profile = { cookies: CookieJar; dispose(): Promise<void> }
type Dependencies = {
  create(id: string): Profile
  persist(cookies: Cookie[]): Promise<void>
  changed(): void
  released?(id: string): void
  log(message: string): void
}

/** Only the verified candidate is persisted. Old pages keep their original, untouched in-memory jar. */
export class GptProCredentialProfiles {
  private profiles = new Map<string, Profile>()
  private active = GPT_PRO_PARTITION
  private candidate?: string
  private revision = 0
  private frozen = false
  private writes: Promise<void> = Promise.resolve()
  private releasing = new Map<string, Promise<void>>()
  constructor(private deps: Dependencies) {
    this.profiles.set(this.active, deps.create(this.active))
  }
  profileID() {
    return this.active
  }
  jar(id = this.active) {
    const profile = this.profiles.get(id)
    if (!profile) throw new Error("Unknown ChatGPT credential profile")
    return profile.cookies
  }
  private async snapshot(id: string) {
    return (await this.jar(id).get({ domain: "chatgpt.com" })).filter((cookie) =>
      ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain ?? ""),
    )
  }
  persist(): Promise<void> {
    const id = this.active
    const revision = this.revision
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        if (this.frozen || revision !== this.revision || id !== this.active) return
        const cookies = await this.snapshot(id)
        if (this.frozen || revision !== this.revision || id !== this.active) return
        await this.deps.persist(cookies)
      })
    this.writes = task
    return task
  }
  async stage(cookies: SessionCookie[]) {
    if (this.candidate || this.frozen)
      throw new GptProOperationError("login_import_busy", "Another login candidate is being verified.")
    if (this.profiles.size >= 4)
      throw new GptProOperationError(
        "login_import_busy",
        "Close retained ChatGPT pages before importing another login. Existing drafts and logins were preserved.",
      )
    const id = `${GPT_PRO_PARTITION}-generation-${randomUUID()}`
    this.candidate = id
    this.deps.log(`credential candidate stage=install profile=${id}; active jar unchanged`)
    try {
      this.profiles.set(id, this.deps.create(id))
      await importSessionCookies(this.jar(id), cookies, this.deps.log)
      return id
    } catch (error) {
      await this.discard(id)
      throw error
    }
  }
  async promote(id: string, commitExecution: () => void) {
    if (!this.profiles.has(id) || id === this.active || (this.candidate && this.candidate !== id) || this.frozen)
      throw new Error("Login candidate changed before promotion")
    this.candidate = id
    const previous = this.active
    this.frozen = true
    this.revision++
    this.deps.log(`credential candidate stage=commit profile=${id}; old profile retained=${previous}`)
    try {
      await this.writes.catch(() => {})
      const cookies = await this.snapshot(id)
      try {
        await this.deps.persist(cookies)
        // No await between execution authority and the in-memory profile switch.
        commitExecution()
      } catch (error) {
        this.deps.log("credential candidate commit failed; restoring previous encrypted active snapshot")
        await this.deps.persist(await this.snapshot(previous))
        throw error
      }
      this.active = id
      this.candidate = undefined
      this.deps.log(`credential candidate stage=promoted profile=${id}; no page reloaded or question dispatched`)
    } finally {
      this.frozen = false
      try {
        this.deps.changed()
      } catch {
        this.deps.log("credential profile subscriber failed after transaction settled")
      }
    }
  }
  // A failed candidate can remain visible for human verification; it never becomes active implicitly.
  retain(id: string) {
    if (this.candidate === id) this.candidate = undefined
  }
  async discard(id: string) {
    if (id === this.active) throw new Error("Cannot discard the active ChatGPT profile")
    if (id === this.candidate) this.candidate = undefined
    const profile = this.profiles.get(id)
    if (!profile) return
    const existing = this.releasing.get(id)
    if (existing) return existing
    const task = Promise.resolve().then(async () => {
      await profile.dispose()
      this.profiles.delete(id)
      this.deps.released?.(id)
      this.deps.log(`credential profile released profile=${id}; active vault untouched`)
    })
    this.releasing.set(id, task)
    try {
      await task
    } finally {
      this.releasing.delete(id)
    }
  }
  async collect(retain: (id: string) => boolean) {
    for (const id of this.profiles.keys()) {
      if (id === this.active || id === this.candidate || retain(id)) continue
      await this.discard(id)
    }
  }
}
