import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Virtualizer } from "@tanstack/solid-virtual"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  registerFindHost,
  clearFindHighlights,
  supportsHighlightAPI,
  setFindHighlights,
  type FindHost,
} from "@opencode-ai/ui/pierre/file-find"
import type { FindNavigationTarget, FindPositionResult } from "../message-navigation"
import { TimelineRow } from "./rows"
import type { ScrollOrigin } from "./scroll-ledger"

export type FindMatch = {
  rowKey: string
  rowIndex: number
  messageID: string
  partID: string
  occurrence: number
}

export type SessionFindState = {
  open: () => boolean
  query: () => string
  count: () => number
  index: () => number
  pos: () => { top: number; right: number }
}

export type SessionFindController = SessionFindState & {
  openFind: (query?: string) => void
  close: () => void
  next: (dir: 1 | -1) => void
  setQuery: (value: string) => void
  setInput: (el: HTMLInputElement) => void
  onInputKeyDown: (event: KeyboardEvent) => void
  refreshHighlights: () => void
  positionMatch: (target: FindNavigationTarget) => FindPositionResult
}

export function createSessionFind(opts: {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  listRoot: () => HTMLDivElement | undefined
  timelineRows: () => TimelineRow.TimelineRow[]
  rowByKey: () => Map<string, TimelineRow.TimelineRow>
  getMessageParts: (messageID: string) => Part[]
  sessionID: () => string | undefined
  onNavigate: (target: FindNavigationTarget) => void
  onRelease?: (reason: "open" | "query" | "close" | "empty") => void
  writeScroll?: (root: HTMLDivElement, origin: ScrollOrigin, callback: () => void) => void
}): SessionFindController {
  let input: HTMLInputElement | undefined
  let highlightFrame: number | undefined
  let mountedRowsFrame: number | undefined
  let queryVersion = 0
  let highlightedTarget = ""

  const debugFind = (message: string) => {
    const line = `[session-find] ${message}`
    console.debug(line)
    if (typeof window === "undefined") return
    const debugWindow = window as Window & { __opencodeSessionFindLogs?: string[] }
    const logs = (debugWindow.__opencodeSessionFindLogs ??= [])
    logs.push(line)
    if (logs.length > 200) logs.splice(0, logs.length - 200)
  }

  const [state, setState] = createStore({
    open: false,
    query: "",
    index: 0,
    selected: undefined as FindMatch | undefined,
    count: 0,
    pos: { top: 8, right: 8 },
  })

  // --- Data layer search ---

  function searchParts(query: string): FindMatch[] {
    const sid = opts.sessionID()
    if (!sid || !query) return []

    const allMatches: FindMatch[] = []
    const rows = opts.timelineRows()
    const queryLower = query.toLowerCase()

    // Collect searchable (messageID, partID, rowIndex, rowKey) refs from rows
    const seen = new Set<string>()
    const refs: { messageID: string; partID: string; rowIndex: number; rowKey: string }[] = []

    rows.forEach((row, index) => {
      const rowKey = TimelineRow.key(row)

      if (row._tag === "UserMessage") {
        const parts = opts.getMessageParts(row.userMessageID)
        for (const part of parts) {
          if (part.type !== "text" || part.synthetic || part.ignored) continue
          const key = `${row.userMessageID}:${part.id}`
          if (seen.has(key)) continue
          seen.add(key)
          refs.push({ messageID: row.userMessageID, partID: part.id, rowIndex: index, rowKey })
        }
      } else if (row._tag === "AssistantPart") {
        const partRefs = row.group.type === "part" ? [row.group.ref] : row.group.refs
        for (const ref of partRefs) {
          const key = `${ref.messageID}:${ref.partID}`
          if (seen.has(key)) continue
          seen.add(key)
          refs.push({ messageID: ref.messageID, partID: ref.partID, rowIndex: index, rowKey })
        }
      }
    })

    // Search each referenced part's text
    for (const ref of refs) {
      const parts = opts.getMessageParts(ref.messageID)
      const part = parts.find((p) => p.id === ref.partID)
      if (!part || part.type !== "text") continue
      const text = (part as { text?: string }).text
      if (!text) continue

      const textLower = text.toLowerCase()
      let at = textLower.indexOf(queryLower)
      let occurrence = 0
      while (at !== -1) {
        allMatches.push({
          rowKey: ref.rowKey,
          rowIndex: ref.rowIndex,
          messageID: ref.messageID,
          partID: ref.partID,
          occurrence,
        })
        occurrence++
        at = textLower.indexOf(queryLower, at + queryLower.length)
      }
    }

    debugFind(
      `search sid=${sid} queryLength=${String(query.length)} rows=${String(rows.length)} refs=${String(refs.length)} matches=${String(allMatches.length)} first=${allMatches[0]?.rowIndex ?? "none"} last=${allMatches.at(-1)?.rowIndex ?? "none"}`,
    )

    return allMatches
  }

  // --- DOM scanning for highlights ---

  function scanRowForRanges(
    rowElement: HTMLElement,
    queryLower: string,
  ): { range: Range; node: Text; start: number }[] {
    const results: { range: Range; node: Text; start: number }[] = []
    const walker = document.createTreeWalker(rowElement, NodeFilter.SHOW_TEXT, null)
    let pos = 0

    const nodes: Text[] = []
    const ends: number[] = []
    let node = walker.nextNode()
    while (node) {
      if (node instanceof Text) {
        pos += node.data.length
        nodes.push(node)
        ends.push(pos)
      }
      node = walker.nextNode()
    }
    if (nodes.length === 0) return results

    // Concatenate text content and search
    const fullText = nodes.map((n) => n.data).join("")
    const hay = fullText.toLowerCase()
    let at = hay.indexOf(queryLower)
    if (at === -1) return results

    const locate = (offset: number) => {
      let lo = 0
      let hi = ends.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (ends[mid] >= offset) hi = mid
        else lo = mid + 1
      }
      const prev = lo === 0 ? 0 : ends[lo - 1]
      return { node: nodes[lo], offset: offset - prev }
    }

    while (at !== -1) {
      const start = locate(at)
      const end = locate(at + queryLower.length)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      results.push({ range, node: start.node, start: at })
      at = hay.indexOf(queryLower, at + queryLower.length)
    }

    return results
  }

  function applyHighlights(currentMatch: FindMatch | undefined) {
    const listRoot = opts.listRoot()
    if (!listRoot) return

    if (!supportsHighlightAPI()) return

    const queryLower = state.query.trim().toLowerCase()
    if (!queryLower) {
      clearFindHighlights()
      return
    }

    const allRanges: Range[] = []
    let currentIndex = -1

    // Scan all mounted rows for matches
    const rowElements = listRoot.querySelectorAll<HTMLElement>("[data-timeline-key]")
    for (const rowEl of rowElements) {
      const rowKey = rowEl.dataset.timelineKey
      if (!rowKey) continue

      const partElements = [...rowEl.querySelectorAll<HTMLElement>("[data-part-id]")]
      const scopes = partElements.length ? partElements : [rowEl]
      for (const scope of scopes) {
        const rowRanges = scanRowForRanges(scope, queryLower)
        for (let i = 0; i < rowRanges.length; i++) {
          const { range } = rowRanges[i]
          if (
            currentMatch &&
            rowKey === currentMatch.rowKey &&
            (!partElements.length || scope.dataset.partId === currentMatch.partID) &&
            i === currentMatch.occurrence
          )
            currentIndex = allRanges.length
          allRanges.push(range)
        }
      }
    }

    if (allRanges.length === 0) {
      clearFindHighlights()
      return
    }

    setFindHighlights(allRanges, currentIndex >= 0 ? currentIndex : 0)
  }

  // --- Scroll to match ---

  function scrollToMatch(match: FindMatch) {
    setState("selected", match)
    opts.onNavigate({
      kind: "find",
      rowKey: match.rowKey,
      messageID: match.messageID,
      partID: match.partID,
      occurrence: match.occurrence,
      query: state.query,
      queryVersion,
    })
  }

  function matchCenterDelta(scroller: HTMLElement, rowEl: HTMLElement, match: FindMatch): number {
    const bounds = scroller.getBoundingClientRect()
    const queryLower = state.query.trim().toLowerCase()
    if (queryLower) {
      const partEl = rowEl.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(match.partID)}"]`)
      const ranges = scanRowForRanges(partEl ?? rowEl, queryLower)
      const hit = ranges[match.occurrence]
      if (hit) {
        const rect = hit.range.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          return (rect.top + rect.bottom) / 2 - (bounds.top + bounds.height / 2)
        }
      }
    }
    const rect = rowEl.getBoundingClientRect()
    return (rect.top + rect.bottom) / 2 - (bounds.top + bounds.height / 2)
  }

  // --- State management ---

  const allMatches = createMemo(() => {
    const q = state.query.trim()
    if (!q) return [] as FindMatch[]
    return searchParts(q)
  })

  const currentMatch = createMemo(() => {
    const selected = state.selected
    if (!selected) return undefined
    return allMatches().find(
      (match) =>
        match.rowKey === selected.rowKey &&
        match.messageID === selected.messageID &&
        match.partID === selected.partID &&
        match.occurrence === selected.occurrence,
    )
  })
  let previousMatch: FindMatch | undefined
  let previousQuery = state.query
  createEffect(() => {
    const matches = allMatches()
    setState("count", matches.length)
    const current = currentMatch()
    if (current) setState("index", matches.indexOf(current))
    if (
      state.open &&
      state.query === previousQuery &&
      previousMatch &&
      !matches.some(
        (match) =>
          match.rowKey === previousMatch!.rowKey &&
          match.messageID === previousMatch!.messageID &&
          match.partID === previousMatch!.partID &&
          match.occurrence === previousMatch!.occurrence,
      )
    )
      opts.onRelease?.("empty")
    previousQuery = state.query
    previousMatch = current
  })

  // Re-apply highlights when virtualizer items change (scrolling causes mount/unmount)
  const scheduleMountedRowsHighlight = () => {
    if (!state.open) return
    if (mountedRowsFrame !== undefined) cancelAnimationFrame(mountedRowsFrame)
    mountedRowsFrame = requestAnimationFrame(() => {
      mountedRowsFrame = undefined
      applyHighlights(currentMatch())
    })
  }
  createEffect(() => {
    currentMatch()
    if (state.open) scheduleMountedRowsHighlight()
  })

  // --- Open / close ---

  function positionBar() {
    if (typeof window === "undefined") return
    const root = opts.listRoot()
    if (!root) return

    const rect = root.getBoundingClientRect()
    setState("pos", {
      top: Math.round(rect.top) + 8,
      right: Math.round(window.innerWidth - rect.right) + 8,
    })
  }

  const focus = (query?: string) => {
    opts.onRelease?.("open")
    if (!state.open) setState("open", true)

    if (query !== undefined) {
      queryVersion++
      setState("query", query)
      setState("index", 0)
      setState("count", allMatches().length)

      const matches = allMatches()
      if (matches.length > 0) {
        scrollToMatch(matches[0])
      } else {
        opts.onRelease?.("empty")
      }
    }

    requestAnimationFrame(() => {
      positionBar()
      input?.focus()
      input?.select()
    })
  }

  const close = () => {
    setState("open", false)
    setState("query", "")
    setState("count", 0)
    setState("index", 0)
    setState("selected", undefined)
    clearFindHighlights()
    if (highlightFrame !== undefined) cancelAnimationFrame(highlightFrame)
    if (mountedRowsFrame !== undefined) cancelAnimationFrame(mountedRowsFrame)
    opts.onRelease?.("close")
  }

  const next = (dir: 1 | -1) => {
    if (!state.open) return
    const total = allMatches().length
    if (total <= 0) return

    const nextIndex = (state.index + dir + total) % total
    setState("index", nextIndex)

    const match = allMatches()[nextIndex]
    if (match) scrollToMatch(match)
  }

  const setQuery = (value: string) => {
    opts.onRelease?.("query")
    queryVersion++
    setState("query", value)
    setState("index", 0)
    const matches = allMatches()
    setState("count", matches.length)

    if (matches.length > 0) {
      scrollToMatch(matches[0])
    } else {
      clearFindHighlights()
      opts.onRelease?.("empty")
    }
  }

  // --- FindHost registration ---

  const host: FindHost = {
    element: () => opts.listRoot(),
    open: focus,
    close,
    next,
    isOpen: () => state.open,
  }

  // Register immediately so the page.find command can discover this host.
  const unregister = registerFindHost(host)

  // Cleanup on dispose
  onCleanup(() => {
    unregister()
    if (highlightFrame !== undefined) cancelAnimationFrame(highlightFrame)
    if (mountedRowsFrame !== undefined) cancelAnimationFrame(mountedRowsFrame)
    clearFindHighlights()
  })

  // --- Public API ---

  return {
    open: () => state.open,
    query: () => state.query,
    count: () => state.count,
    index: () => state.index,
    pos: () => state.pos,
    openFind: (query?: string) => {
      focus(query)
    },
    close,
    next,
    setQuery,
    setInput: (el: HTMLInputElement) => {
      input = el
    },
    onInputKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      next(event.shiftKey ? -1 : 1)
    },
    refreshHighlights: scheduleMountedRowsHighlight,
    positionMatch: (target: FindNavigationTarget): FindPositionResult => {
      const listRoot = opts.listRoot()
      if (!state.open || target.query !== state.query || target.queryVersion !== queryVersion) {
        debugFind(
          `position-stale key=${target.rowKey} targetVersion=${String(target.queryVersion)} currentVersion=${String(queryVersion)}`,
        )
        return { available: false, aligned: false, geometry: "stale" }
      }
      const expected = currentMatch()
      if (
        expected &&
        (expected.rowKey !== target.rowKey ||
          expected.messageID !== target.messageID ||
          expected.partID !== target.partID ||
          expected.occurrence !== target.occurrence)
      ) {
        return { available: false, aligned: false, geometry: "superseded-match" }
      }
      if (!expected) return { available: false, aligned: false, geometry: "missing" }
      const row = listRoot?.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(target.rowKey)}"]`)
      if (!listRoot || !row) {
        const index = opts.timelineRows().findIndex((item) => TimelineRow.key(item) === target.rowKey)
        if (index >= 0) opts.virtualizer.scrollToIndex(index, { align: "center" })
        return { available: false, aligned: false, geometry: "unmounted" }
      }
      const match: FindMatch = {
        ...target,
        rowIndex: opts.timelineRows().findIndex((item) => TimelineRow.key(item) === target.rowKey),
      }
      const highlightKey = `${queryVersion}:${target.rowKey}:${target.partID}:${target.occurrence}`
      if (highlightedTarget !== highlightKey) {
        applyHighlights(expected)
        highlightedTarget = highlightKey
      }
      const delta = matchCenterDelta(listRoot, row, match)
      const top = Math.max(
        0,
        Math.min(listRoot.scrollTop + delta, Math.max(0, opts.virtualizer.getTotalSize() - listRoot.clientHeight)),
      )
      const adjustment = top - listRoot.scrollTop
      if (Math.abs(adjustment) > 2) {
        const write = () => (listRoot.scrollTop = top)
        if (opts.writeScroll) opts.writeScroll(listRoot, "navigation", write)
        else write()
        debugFind(`position-write key=${target.rowKey} targetTop=${Math.round(top)} delta=${Math.round(adjustment)}`)
      }
      return {
        available: true,
        aligned: Math.abs(adjustment) <= 2,
        geometry: `${Math.round(top)}:${Math.round(row.getBoundingClientRect().height)}:${listRoot.clientHeight}`,
      }
    },
  }
}
