import type { Platform } from "@/context/platform"
import type { Prompt } from "@/context/prompt"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { normalizePromptHistoryEntry, type PromptHistoryComment, type PromptHistoryStoredEntry } from "./history"

export type PromptHistoryKind = "normal" | "shell"

export type PromptHistoryPage = {
  entries: PromptHistoryStoredEntry[]
  nextOffset: number
  hasMore: boolean
}

type Storage = AsyncStorage | SyncStorage
type IndexEntry = { id: string; fingerprint: string; images: string[] }

const HISTORY_STORAGE = "opencode.prompt-history.dat"
const IMAGE_STORAGE = "opencode.prompt-history-images.dat"
const MAX_ENTRIES = 100

function browserStorage(name: string): Storage {
  const prefix = `${name}:`
  return {
    getItem: (key) => localStorage.getItem(prefix + key),
    setItem: (key, value) => localStorage.setItem(prefix + key, value),
    removeItem: (key) => localStorage.removeItem(prefix + key),
  }
}

function storage(platform: Platform, name: string) {
  return platform.storage?.(name) ?? browserStorage(name)
}

function getItem(store: Storage, key: string) {
  return Promise.resolve(store.getItem(key))
}

function setItem(store: Storage, key: string, value: string) {
  return Promise.resolve(store.setItem(key, value))
}

function removeItem(store: Storage, key: string) {
  return Promise.resolve(store.removeItem(key))
}

function parseEntries(raw: string | null) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || !("entries" in parsed)) return []
    const entries = (parsed as { entries?: unknown }).entries
    return Array.isArray(entries) ? (entries as PromptHistoryStoredEntry[]) : []
  } catch {
    return []
  }
}

async function digest(value: string) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(value)
    const result = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  return `${checksum(value) ?? "0"}-${value.length}`
}

function canonical(entry: ReturnType<typeof normalizePromptHistoryEntry>) {
  return {
    prompt: entry.prompt.map((part) => (part.type === "image" ? { ...part, id: "" } : part)),
    comments: entry.comments.map(({ id: _id, time: _time, ...comment }) => comment),
  }
}

async function createFallback(platform: Platform) {
  const records = storage(platform, HISTORY_STORAGE)
  const images = storage(platform, IMAGE_STORAGE)

  const readIndex = async (kind: PromptHistoryKind): Promise<IndexEntry[]> => {
    const raw = await getItem(records, `index:${kind}`)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  const appendInternal = async (kind: PromptHistoryKind, serialized: string) => {
    const started = performance.now()
    const entry = normalizePromptHistoryEntry(JSON.parse(serialized) as PromptHistoryStoredEntry)
    const refs: string[] = []
    const prompt = await Promise.all(
      entry.prompt.map(async (part) => {
        if (part.type !== "image") return part
        const hash = await digest(part.dataUrl)
        refs.push(hash)
        if ((await getItem(images, hash)) === null) await setItem(images, hash, part.dataUrl)
        const { dataUrl: _dataUrl, ...rest } = part
        return { ...rest, historyImage: hash }
      }),
    )
    const stored = { prompt, comments: entry.comments }
    const fingerprint = await digest(
      JSON.stringify(canonical(entry)).replaceAll(/"dataUrl":"[^"]*"/g, `"dataUrl":"${refs.join(",")}"`),
    )
    const index = await readIndex(kind)
    if (index[0]?.fingerprint === fingerprint) return { added: false }
    const id = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
    await setItem(records, `entry:${id}`, JSON.stringify(stored))
    const pruned = index.slice(MAX_ENTRIES - 1)
    const next = [{ id, fingerprint, images: [...new Set(refs)] }, ...index].slice(0, MAX_ENTRIES)
    await setItem(records, `index:${kind}`, JSON.stringify(next))
    for (const item of pruned) await removeItem(records, `entry:${item.id}`)
    const other = await readIndex(kind === "normal" ? "shell" : "normal")
    const referenced = new Set([...next, ...other].flatMap((item) => item.images))
    for (const hash of new Set(pruned.flatMap((item) => item.images))) {
      if (!referenced.has(hash)) await removeItem(images, hash)
    }
    console.debug("[prompt-history] append completed", {
      kind,
      entries: next.length,
      durationMs: Math.round(performance.now() - started),
    })
    return { added: true }
  }

  let migration: Promise<void> | undefined
  const migrate = () => {
    migration ??= (async () => {
      const sources = [
        { kind: "normal" as const, name: "opencode.global.dat", key: "prompt-history" },
        { kind: "shell" as const, name: "opencode.global.dat", key: "prompt-history-shell" },
        { kind: "normal" as const, name: "default.dat", key: "prompt-history.v1" },
        { kind: "shell" as const, name: "default.dat", key: "prompt-history-shell.v1" },
      ]
      for (const source of sources) {
        const legacy = storage(platform, source.name)
        const raw = await getItem(legacy, source.key)
        if (!raw) continue
        const entries = parseEntries(raw)
        console.debug("[prompt-history] legacy migration started", { kind: source.kind, entries: entries.length })
        try {
          for (const entry of entries.slice().reverse()) {
            await appendInternal(source.kind, JSON.stringify(normalizePromptHistoryEntry(entry)))
          }
          await removeItem(legacy, source.key)
          console.debug("[prompt-history] legacy migration completed", { kind: source.kind, entries: entries.length })
        } catch (error) {
          console.error("[prompt-history] legacy migration failed; source retained", { kind: source.kind, error })
        }
      }
    })()
    return migration
  }

  const pageInternal = async (kind: PromptHistoryKind, offset: number, limit: number): Promise<PromptHistoryPage> => {
    const started = performance.now()
    const index = await readIndex(kind)
    const selected = index.slice(offset, offset + limit)
    const entries: PromptHistoryStoredEntry[] = []
    for (const item of selected) {
      const raw = await getItem(records, `entry:${item.id}`)
      if (!raw) continue
      const stored = normalizePromptHistoryEntry(JSON.parse(raw) as PromptHistoryStoredEntry)
      const prompt = await Promise.all(
        stored.prompt.map(async (part) => {
          const ref = (part as unknown as { historyImage?: string }).historyImage
          if (part.type !== "image" || !ref) return part
          const dataUrl = await getItem(images, ref)
          if (!dataUrl) return undefined
          const { historyImage: _historyImage, ...rest } = part as typeof part & { historyImage: string }
          return { ...rest, dataUrl }
        }),
      )
      entries.push({ prompt: prompt.filter((part): part is Prompt[number] => !!part), comments: stored.comments })
    }
    const nextOffset = offset + selected.length
    console.debug("[prompt-history] page loaded", {
      kind,
      offset,
      returned: entries.length,
      durationMs: Math.round(performance.now() - started),
    })
    return { entries, nextOffset, hasMore: nextOffset < index.length }
  }

  return {
    append: async (kind: PromptHistoryKind, serialized: string) => {
      await migrate()
      return appendInternal(kind, serialized)
    },
    page: async (kind: PromptHistoryKind, offset: number, limit: number) => {
      await migrate()
      return pageInternal(kind, offset, limit)
    },
  }
}

export function createPromptHistoryStorage(platform: Platform) {
  if (platform.promptHistory) {
    return {
      append: (kind: PromptHistoryKind, prompt: Prompt, comments: PromptHistoryComment[]) =>
        platform.promptHistory!.append(kind, JSON.stringify({ prompt, comments })),
      page: async (kind: PromptHistoryKind, offset: number, limit: number): Promise<PromptHistoryPage> => {
        const result = await platform.promptHistory!.page(kind, offset, limit)
        return {
          entries: result.entries.map((entry) => JSON.parse(entry) as PromptHistoryStoredEntry),
          nextOffset: result.nextOffset,
          hasMore: result.hasMore,
        }
      },
    }
  }

  const fallback = createFallback(platform)
  return {
    append: async (kind: PromptHistoryKind, prompt: Prompt, comments: PromptHistoryComment[]) =>
      (await fallback).append(kind, JSON.stringify({ prompt, comments })),
    page: async (kind: PromptHistoryKind, offset: number, limit: number) => (await fallback).page(kind, offset, limit),
  }
}
