import {
  MAX_HIGHLIGHT_CHARACTERS,
  MAX_HIGHLIGHT_TOKENS,
  scanWolfram,
  wolframCursor,
  type WolframToken,
} from "@opencode-ai/extension-kit/wolfram"

export const HIGHLIGHT_CACHE_LINES = 256
const SCAN_CHUNK = 16 * 1024

/** Index lexical state without retaining tokens for offscreen lines. */
export function createWlsHighlight(source: string, lines: string[]) {
  const offsets = [0]
  for (let index = 0; index < lines.length - 1; index++) offsets.push(offsets[index] + lines[index].length + 1)
  // Two low bits encode string/escape state; the remaining bits hold comment depth.
  const states = [0]
  const cursor = wolframCursor()
  const cache = new Map<number, WolframToken[]>()
  let line = 0
  let disposed = false

  return {
    get cachedLines() {
      return cache.size
    },
    get indexedLines() {
      return states.length
    },
    advance(budget = 64 * 1024) {
      if (disposed) return true
      const end = cursor.offset + Math.max(1, budget)
      while (line < lines.length && cursor.offset < end) {
        const boundary = offsets[line + 1] ?? source.length
        scanWolfram(source, cursor, undefined, Math.min(boundary, cursor.offset + SCAN_CHUNK, end))
        if (cursor.offset >= boundary) {
          line++
          if (line < lines.length)
            states[line] = cursor.commentDepth * 4 + Number(cursor.string) * 2 + Number(cursor.escaped)
        }
      }
      return line >= lines.length
    },
    tokens(index: number): WolframToken[] {
      const text = lines[index] ?? ""
      if (disposed || states[index] === undefined || !text) return [{ kind: "plain", text }]
      const hit = cache.get(index)
      if (hit) {
        cache.delete(index)
        cache.set(index, hit)
        return hit
      }
      const state = states[index]
      const local = wolframCursor({
        commentDepth: Math.floor(state / 4),
        string: Boolean(state & 2),
        escaped: Boolean(state & 1),
      })
      local.offset = offsets[index]
      const tokens: WolframToken[] = []
      let fallback = -1
      // Rendering a pathological line degrades locally, not the rest of the file.
      if (text.length > MAX_HIGHLIGHT_CHARACTERS) return [{ kind: "plain", text }]
      scanWolfram(
        source,
        local,
        (kind, start, end) => {
          if (fallback >= 0) return
          if (tokens.length >= MAX_HIGHLIGHT_TOKENS) {
            fallback = start
            return
          }
          const value = source.slice(start, end)
          const previous = tokens.at(-1)
          if (previous?.kind === kind) previous.text += value
          else tokens.push({ kind, text: value })
        },
        offsets[index] + text.length,
      )
      if (fallback >= 0) tokens.push({ kind: "plain", text: source.slice(fallback, offsets[index] + text.length) })
      cache.set(index, tokens)
      if (cache.size > HIGHLIGHT_CACHE_LINES) cache.delete(cache.keys().next().value!)
      return tokens
    },
    dispose() {
      disposed = true
      cache.clear()
    },
  }
}
