import { checksum } from "@opencode-ai/core/util/encode"

type Entry = Readonly<{ hash: string; source: string; html: string; htmlHash: string }>
const rendererScopes = new WeakMap<object, number>()
let rendererSequence = 0

export function markdownRendererScope(renderer: object) {
  const hit = rendererScopes.get(renderer)
  if (hit !== undefined) return hit
  const id = ++rendererSequence
  rendererScopes.set(renderer, id)
  return id
}

export class MarkdownHtmlCache {
  protected entries = new Map<string, Entry>()
  private latest = new Map<string, { source: string; ticket: number }>()
  private sequence = 0
  constructor(private limit = 200) {}

  begin(key: string, hash: string, source = hash) {
    const ticket = ++this.sequence
    this.latest.delete(key)
    this.latest.set(key, { source, ticket })
    while (this.latest.size > this.limit) {
      const oldest = this.latest.keys().next().value
      if (oldest === undefined) break
      this.latest.delete(oldest)
    }
    return ticket
  }

  get(key: string, hash: string, source = hash): string | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    if (
      !entry ||
      typeof entry.html !== "string" ||
      typeof entry.hash !== "string" ||
      entry.hash !== hash ||
      entry.source !== source ||
      entry.htmlHash !== (checksum(entry.html) ?? "empty")
    ) {
      this.entries.delete(key)
      console.debug(`[markdown-cache] discard key=${key} reason=integrity-or-source`)
      return
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.html
  }

  set(
    key: string,
    hash: string,
    html: string,
    options: { streaming?: boolean; fallback?: boolean; ticket?: number; source?: string } = {},
  ) {
    if (
      options.streaming ||
      options.fallback ||
      !key ||
      typeof hash !== "string" ||
      !hash ||
      typeof html !== "string"
    ) {
      if (options.fallback) console.debug(`[markdown-cache] skip key=${key} reason=render-fallback`)
      return false
    }
    const source = options.source ?? hash
    if (options.ticket !== undefined) {
      const latest = this.latest.get(key)
      if (
        !latest ||
        latest.source !== source ||
        !Number.isSafeInteger(options.ticket) ||
        options.ticket <= 0 ||
        options.ticket > latest.ticket
      ) {
        console.debug(`[markdown-cache] skip key=${key} reason=stale-render`)
        return false
      }
    } else {
      this.begin(key, hash, source)
    }
    this.entries.delete(key)
    this.entries.set(key, Object.freeze({ hash, source, html, htmlHash: checksum(html) ?? "empty" }))
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return true
  }

  get size() {
    return this.entries.size
  }
}

export const markdownHtmlCache = new MarkdownHtmlCache()

export async function renderMarkdownWithFallback(input: {
  render: () => string | Promise<string>
  fallback: () => string | Promise<string>
  onError?: (error: unknown) => void
  timeout?: number
}): Promise<{ html: string; fallback: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fallback = async () => ({ html: await input.fallback(), fallback: true })
  const render = Promise.resolve()
    .then(input.render)
    .then((html) => ({ html, fallback: false }))
    .catch((error) => {
      input.onError?.(error)
      return fallback()
    })
  try {
    return await Promise.race([
      render,
      new Promise<{ html: string; fallback: boolean }>((resolve, reject) => {
        timer = setTimeout(() => {
          input.onError?.(new Error("Markdown render timed out"))
          void fallback().then(resolve, reject)
        }, input.timeout ?? 8_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
