import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"

import { write as writeLog } from "./logging"
import { getStore } from "./store"

export type PromptHistoryKind = "normal" | "shell"

type IndexEntry = {
  id: string
  fingerprint: string
  images: string[]
}

type HistoryIndex = {
  version: 1
  normal: IndexEntry[]
  shell: IndexEntry[]
}

type StoredImagePart = {
  type: "image"
  id: string
  filename: string
  mime: string
  historyImage: string
}

const MAX_ENTRIES = 100
const EMPTY_INDEX: HistoryIndex = { version: 1, normal: [], shell: [] }
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

function assertKind(kind: PromptHistoryKind) {
  if (kind === "normal" || kind === "shell") return kind
  throw new Error("Invalid prompt history kind")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asEntry(value: unknown) {
  if (Array.isArray(value)) return { prompt: value, comments: [] }
  if (!isRecord(value) || !Array.isArray(value.prompt)) throw new Error("Invalid prompt history entry")
  return {
    prompt: value.prompt,
    comments: Array.isArray(value.comments) ? value.comments : [],
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class PromptHistoryStore {
  private queue = Promise.resolve()
  private migration?: Promise<void>

  constructor(
    private readonly root = join(app.getPath("userData"), "prompt-history"),
    private readonly legacyEnabled = true,
  ) {}

  private get indexPath() {
    return join(this.root, "index.json")
  }

  private get entriesRoot() {
    return join(this.root, "entries")
  }

  private get imagesRoot() {
    return join(this.root, "images")
  }

  private entryPath(id: string) {
    return join(this.entriesRoot, `${id}.json`)
  }

  private imagePath(hash: string) {
    return join(this.imagesRoot, hash)
  }

  private async ensureDirectories() {
    await Promise.all([mkdir(this.entriesRoot, { recursive: true }), mkdir(this.imagesRoot, { recursive: true })])
  }

  private async readIndex(): Promise<HistoryIndex> {
    const raw = await readFile(this.indexPath, "utf8").catch(() => "")
    if (!raw) return structuredClone(EMPTY_INDEX)
    try {
      const parsed = JSON.parse(raw) as Partial<HistoryIndex>
      return {
        version: 1,
        normal: Array.isArray(parsed.normal) ? parsed.normal : [],
        shell: Array.isArray(parsed.shell) ? parsed.shell : [],
      }
    } catch (error) {
      writeLog(
        "prompt-history",
        "index parse failed; starting with an empty index",
        { error: errorMessage(error) },
        "error",
      )
      return structuredClone(EMPTY_INDEX)
    }
  }

  private async writeIndex(index: HistoryIndex) {
    const temp = `${this.indexPath}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(index), "utf8")
    await rename(temp, this.indexPath)
  }

  private async storeImage(dataUrl: string) {
    const match = DATA_URL.exec(dataUrl)
    if (!match) throw new Error("Prompt history image is not a base64 data URL")
    const bytes = Buffer.from(match[2]!, "base64")
    const hash = createHash("sha256").update(bytes).digest("hex")
    const path = this.imagePath(hash)
    let created = false
    try {
      await writeFile(path, bytes, { flag: "wx" })
      created = true
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error
    }
    writeLog("prompt-history", "image externalized", { hash: hash.slice(0, 12), bytes: bytes.length, created })
    return hash
  }

  private async externalize(value: unknown) {
    const entry = asEntry(value)
    const images: string[] = []
    const prompt = await Promise.all(
      entry.prompt.map(async (part) => {
        if (!isRecord(part) || part.type !== "image" || typeof part.dataUrl !== "string") return part
        const hash = await this.storeImage(part.dataUrl)
        images.push(hash)
        const stored: StoredImagePart = {
          type: "image",
          id: typeof part.id === "string" ? part.id : randomUUID(),
          filename: typeof part.filename === "string" ? part.filename : "image",
          mime: typeof part.mime === "string" ? part.mime : "application/octet-stream",
          historyImage: hash,
        }
        return stored
      }),
    )
    const stored = { prompt, comments: entry.comments }
    const canonical = {
      prompt: prompt.map((part) => {
        if (!isRecord(part) || part.type !== "image") return part
        const { id: _id, ...rest } = part
        return rest
      }),
      comments: entry.comments.map((comment) => {
        if (!isRecord(comment)) return comment
        const { id: _id, time: _time, ...rest } = comment
        return rest
      }),
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
    return { stored, images: [...new Set(images)], fingerprint }
  }

  private async hydrate(raw: string) {
    const entry = asEntry(JSON.parse(raw))
    const prompt = await Promise.all(
      entry.prompt.map(async (part) => {
        if (!isRecord(part) || part.type !== "image" || typeof part.historyImage !== "string") return part
        const bytes = await readFile(this.imagePath(part.historyImage))
        const mime = typeof part.mime === "string" ? part.mime : "application/octet-stream"
        const { historyImage: _historyImage, ...rest } = part
        return { ...rest, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` }
      }),
    )
    return JSON.stringify({ prompt, comments: entry.comments })
  }

  private serialized<T>(task: () => Promise<T>) {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async appendInternal(kind: PromptHistoryKind, value: unknown, index: HistoryIndex) {
    const converted = await this.externalize(value)
    const current = index[kind]
    if (current[0]?.fingerprint === converted.fingerprint) {
      writeLog("prompt-history", "append skipped duplicate", { kind, fingerprint: converted.fingerprint.slice(0, 12) })
      return false
    }

    const id = `${Date.now()}-${randomUUID()}`
    await writeFile(this.entryPath(id), JSON.stringify(converted.stored), "utf8")
    const pruned = current.slice(MAX_ENTRIES - 1)
    index[kind] = [{ id, fingerprint: converted.fingerprint, images: converted.images }, ...current].slice(
      0,
      MAX_ENTRIES,
    )

    for (const item of pruned) await unlink(this.entryPath(item.id)).catch(() => undefined)
    const referenced = new Set([...index.normal, ...index.shell].flatMap((item) => item.images))
    const candidates = new Set(pruned.flatMap((item) => item.images))
    for (const hash of candidates) {
      if (!referenced.has(hash)) await unlink(this.imagePath(hash)).catch(() => undefined)
    }
    return true
  }

  private async migrateLegacy() {
    if (this.migration) return this.migration
    this.migration = this.serialized(async () => {
      await this.ensureDirectories()
      if (!this.legacyEnabled) return
      const index = await this.readIndex()
      const sources = [
        { kind: "normal" as const, store: "opencode.global.dat", key: "prompt-history" },
        { kind: "shell" as const, store: "opencode.global.dat", key: "prompt-history-shell" },
        { kind: "normal" as const, store: "default.dat", key: "prompt-history.v1" },
        { kind: "shell" as const, store: "default.dat", key: "prompt-history-shell.v1" },
      ]
      let changed = false
      for (const source of sources) {
        const store = getStore(source.store)
        const raw = store.get(source.key)
        if (raw === undefined || raw === null) continue
        writeLog("prompt-history", "legacy migration started", {
          kind: source.kind,
          store: source.store,
          key: source.key,
        })
        try {
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
          const entries = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : []
          let added = 0
          for (const entry of entries.slice().reverse()) {
            if (await this.appendInternal(source.kind, entry, index)) added += 1
          }
          store.delete(source.key)
          changed = changed || added > 0
          writeLog("prompt-history", "legacy migration completed", {
            kind: source.kind,
            entries: entries.length,
            added,
          })
        } catch (error) {
          writeLog(
            "prompt-history",
            "legacy migration failed; source retained",
            { kind: source.kind, error: errorMessage(error) },
            "error",
          )
        }
      }
      if (changed) await this.writeIndex(index)
    })
    return this.migration
  }

  async append(kind: PromptHistoryKind, serializedEntry: string) {
    assertKind(kind)
    await this.migrateLegacy()
    return this.serialized(async () => {
      const started = Date.now()
      const index = await this.readIndex()
      const added = await this.appendInternal(kind, JSON.parse(serializedEntry), index)
      if (added) await this.writeIndex(index)
      writeLog("prompt-history", "append completed", {
        kind,
        added,
        entries: index[kind].length,
        durationMs: Date.now() - started,
      })
      return { added }
    })
  }

  async page(kind: PromptHistoryKind, offset: number, limit: number) {
    assertKind(kind)
    await this.migrateLegacy()
    return this.serialized(async () => {
      const started = Date.now()
      const index = await this.readIndex()
      const safeOffset = Math.max(0, Math.floor(offset))
      const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
      const selected = index[kind].slice(safeOffset, safeOffset + safeLimit)
      const entries: string[] = []
      for (const item of selected) {
        const raw = await readFile(this.entryPath(item.id), "utf8").catch((error) => {
          writeLog("prompt-history", "entry read failed", { kind, id: item.id, error: errorMessage(error) }, "error")
          return ""
        })
        if (!raw) continue
        try {
          entries.push(await this.hydrate(raw))
        } catch (error) {
          writeLog("prompt-history", "entry hydrate failed", { kind, id: item.id, error: errorMessage(error) }, "error")
        }
      }
      const nextOffset = safeOffset + selected.length
      const hasMore = nextOffset < index[kind].length
      writeLog("prompt-history", "page loaded", {
        kind,
        offset: safeOffset,
        requested: safeLimit,
        returned: entries.length,
        hasMore,
        durationMs: Date.now() - started,
      })
      return { entries, nextOffset, hasMore }
    })
  }

  async inspect() {
    await this.migrateLegacy()
    const index = await this.readIndex()
    const images = await readdir(this.imagesRoot).catch(() => [])
    return { normal: index.normal.length, shell: index.shell.length, images: images.length, root: this.root }
  }
}

let store: PromptHistoryStore | undefined

export function getPromptHistoryStore() {
  store ??= new PromptHistoryStore()
  return store
}
