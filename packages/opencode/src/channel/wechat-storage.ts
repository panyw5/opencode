import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import * as Global from "@opencode-ai/core/global"
import { renameSync } from "node:fs"
import { Flock } from "@opencode-ai/core/util/flock"
import { validateBaseUrl } from "./wechat-api"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "wechat-storage" })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export interface Credentials {
  botId: string
  token: string
  baseUrl: string
  scannerUserId: string
}
export interface Context {
  token: string
  timestamp: number
  messageId: string
}
export class AccountLockedError extends Error {
  constructor() {
    super("WeChat account is already monitored by another process")
    this.name = "AccountLockedError"
  }
}
export class WechatStorage {
  constructor(readonly root = path.join(Global.Path.state, "wechat")) {}
  private location(kind: string, id: string) {
    return path.join(this.root, kind, hash(id))
  }
  private async directory(dir: string) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await fs.chmod(this.root, 0o700)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700)
  }
  private async read<T>(kind: string, id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.location(kind, id), "utf8")) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw new Error("WeChat private storage could not be read")
    }
  }
  private async write(kind: string, id: string, value: unknown, guard?: () => boolean) {
    const target = this.location(kind, id)
    await this.directory(path.dirname(target))
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
      if (guard && !guard()) throw new Error("WeChat login attempt is no longer active")
      // Synchronous rename makes the stale-attempt check and commit indivisible to JS cancellation.
      renameSync(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    log.debug("private state saved", { kind })
  }
  async loadCredentials(channelName: string) {
    const value = await this.read<Credentials>("channels", channelName)
    if (value === undefined) return
    if (!value || typeof value !== "object") throw new Error("Invalid WeChat credentials")
    if (
      ![value.botId, value.token, value.scannerUserId, value.baseUrl].every(
        (x) => typeof x === "string" && x.length > 0,
      )
    )
      throw new Error("Invalid WeChat credentials")
    return {
      botId: value.botId,
      token: value.token,
      scannerUserId: value.scannerUserId,
      baseUrl: validateBaseUrl(value.baseUrl),
    }
  }
  saveCredentials(channelName: string, value: Credentials, guard?: () => boolean) {
    if (
      ![value.botId, value.token, value.scannerUserId, value.baseUrl].every(
        (x) => typeof x === "string" && x.length > 0,
      )
    )
      throw new Error("Invalid WeChat credentials")
    return this.write("channels", channelName, { ...value, baseUrl: validateBaseUrl(value.baseUrl) }, guard)
  }
  async loadCursor(botId: string) {
    const value = await this.read<string>("cursors", botId)
    if (value !== undefined && typeof value !== "string") throw new Error("Invalid WeChat cursor")
    return value
  }
  saveCursor(botId: string, cursor: string) {
    return this.write("cursors", botId, cursor)
  }
  async loadContext(botId: string, userId: string, replyTo?: string) {
    const value = await this.read<Context>("contexts", JSON.stringify([botId, userId, replyTo ?? "latest"]))
    if (
      value !== undefined &&
      (!value ||
        typeof value.token !== "string" ||
        typeof value.messageId !== "string" ||
        !Number.isFinite(value.timestamp))
    )
      throw new Error("Invalid WeChat context")
    return value
  }
  async saveContext(botId: string, userId: string, value: Context) {
    if (
      !value.token ||
      typeof value.token !== "string" ||
      typeof value.messageId !== "string" ||
      !Number.isFinite(value.timestamp)
    )
      throw new Error("Invalid WeChat context")
    const previous = await this.loadContext(botId, userId)
    await this.write("contexts", JSON.stringify([botId, userId, value.messageId]), value)
    if (!previous || previous.timestamp <= value.timestamp)
      await this.write("contexts", JSON.stringify([botId, userId, "latest"]), value)
  }
  async acquireLock(botId: string): Promise<() => Promise<void>> {
    const dir = this.location("locks", botId)
    await this.directory(path.dirname(dir))
    try {
      await fs.mkdir(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("WeChat account lock could not be acquired")
      let reclaim: Flock.Lease
      // Reuse the repository's heartbeat lease for the short recovery critical section.
      // Unlike an untracked .reclaim directory it recovers after a reclaimer crash.
      try {
        reclaim = await Flock.acquire(`wechat-reclaim:${botId}`, {
          dir: path.join(this.root, "reclaim-locks"),
          timeoutMs: 0,
        })
      } catch {
        throw new AccountLockedError()
      }
      try {
        const raw = await fs.readFile(path.join(dir, "owner.json"), "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw new AccountLockedError()
        })
        if (raw) {
          let pid: number
          try {
            pid = JSON.parse(raw).pid
          } catch {
            throw new AccountLockedError()
          }
          if (!Number.isSafeInteger(pid!) || pid! <= 0) throw new AccountLockedError()
          try {
            process.kill(pid!, 0)
            throw new AccountLockedError()
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new AccountLockedError()
          }
          if ((await fs.readFile(path.join(dir, "owner.json"), "utf8")) !== raw) throw new AccountLockedError()
        } else {
          // A creator may not have written metadata yet; only recover abandoned initialization.
          if (Date.now() - (await fs.stat(dir)).mtimeMs < 60_000) throw new AccountLockedError()
        }
        const abandoned = `${dir}.abandoned.${randomUUID()}`
        await fs.rename(dir, abandoned)
        try {
          await fs.mkdir(dir, { mode: 0o700 })
        } finally {
          await fs.rm(abandoned, { recursive: true, force: true })
        }
        log.info("abandoned account lock recovered")
      } finally {
        await reclaim.release()
      }
    }
    const owner = randomUUID()
    try {
      await fs.writeFile(
        path.join(dir, "owner.json"),
        JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }),
        { mode: 0o600, flag: "wx" },
      )
    } catch {
      await fs.rm(dir, { recursive: true, force: true })
      throw new Error("WeChat account lock could not be initialized")
    }
    log.info("account lock acquired")
    let released = false
    return async () => {
      if (released) return
      const current = JSON.parse(await fs.readFile(path.join(dir, "owner.json"), "utf8"))
      if (current.owner !== owner) throw new Error("WeChat account lock ownership changed")
      await fs.rm(dir, { recursive: true })
      released = true
      log.info("account lock released")
    }
  }
}
export * as WechatStore from "./wechat-storage"
