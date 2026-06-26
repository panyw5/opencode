export type SessionLayoutMetricValue = string | number | boolean
export type SessionLayoutMetrics = Record<string, SessionLayoutMetricValue | undefined>

type SessionLayoutInput = {
  root?: HTMLDivElement
  content?: HTMLElement
  sessionId?: string
  directory?: string
  renderedCount?: number
  visibleCount?: number
  canWindow?: boolean
  windowStart?: number
  windowEnd?: number
  windowTop?: number
  windowBottom?: number
  totalHeight?: number
  measuredCount?: number
  currentId?: string
  seekingId?: string
  live?: boolean
}

const none = "none"

function round(value: number): number {
  return Math.round(value)
}

function numeric(value: SessionLayoutMetricValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

function rectMetrics(rootBox: DOMRect, node?: Element): SessionLayoutMetrics {
  if (!node) {
    return {
      top: none,
      bottom: none,
      height: none,
    }
  }
  const rect = node.getBoundingClientRect()
  return {
    top: round(rect.top - rootBox.top),
    bottom: round(rect.bottom - rootBox.top),
    height: round(rect.height),
  }
}

function prefixed(prefix: string, metrics: SessionLayoutMetrics): SessionLayoutMetrics {
  const result: SessionLayoutMetrics = {}
  for (const [key, value] of Object.entries(metrics)) {
    result[`${prefix}${key}`] = value
  }
  return result
}

export function collectSessionLayoutMetrics(input: SessionLayoutInput): SessionLayoutMetrics {
  const root = input.root
  const base: SessionLayoutMetrics = {
    hasRoot: !!root,
    session: input.sessionId ?? none,
    directory: input.directory ?? none,
    rendered: input.renderedCount,
    visible: input.visibleCount,
    canWindow: input.canWindow,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    windowTop: input.windowTop === undefined ? undefined : round(input.windowTop),
    windowBottom: input.windowBottom === undefined ? undefined : round(input.windowBottom),
    totalEstimate: input.totalHeight === undefined ? undefined : round(input.totalHeight),
    measured: input.measuredCount,
    current: input.currentId ?? none,
    seeking: input.seekingId ?? none,
    live: input.live,
  }
  if (!root) return base

  const scrollTop = root.scrollTop
  const scrollHeight = root.scrollHeight
  const clientHeight = root.clientHeight
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  const rootBox = root.getBoundingClientRect()
  const content = input.content
  const list =
    content?.querySelector<HTMLElement>('[data-slot="session-turn-list"]') ??
    root.querySelector<HTMLElement>('[data-slot="session-turn-list"]') ??
    undefined
  const turns = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
  const first = turns[0]
  const last = turns.at(-1)
  const firstRect = rectMetrics(rootBox, first)
  const lastRect = rectMetrics(rootBox, last)
  const listRect = rectMetrics(rootBox, list)
  const contentRect = rectMetrics(rootBox, content)
  const lastBottom = numeric(lastRect.bottom)
  const listBottom = numeric(listRect.bottom)
  const contentBottom = numeric(contentRect.bottom)

  return {
    ...base,
    scrollTop: round(scrollTop),
    scrollHeight: round(scrollHeight),
    clientHeight: round(clientHeight),
    maxScrollTop: round(maxScrollTop),
    bottomGap: round(maxScrollTop - scrollTop),
    rootHeight: round(rootBox.height),
    bodyScrollHeight: typeof document === "undefined" ? undefined : round(document.body.scrollHeight),
    documentScrollHeight: typeof document === "undefined" ? undefined : round(document.documentElement.scrollHeight),
    windowInnerHeight: typeof window === "undefined" ? undefined : round(window.innerHeight),
    devicePixelRatio: typeof window === "undefined" ? undefined : window.devicePixelRatio,
    turnNodes: turns.length,
    domNodes: root.querySelectorAll("*").length,
    markdownNodes: root.querySelectorAll('[data-component="markdown"]').length,
    fullMarkdown: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="full"]').length,
    structureMarkdown: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="structure"]').length,
    liteMarkdown: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="lite"]').length,
    katexNodes: root.querySelectorAll(".katex,.katex-display,.katex-html,.katex-mathml").length,
    dataVirtualized: list?.dataset.virtualized ?? none,
    ...prefixed("content", contentRect),
    ...prefixed("list", listRect),
    ...prefixed("first", firstRect),
    firstId: first?.dataset.messageId ?? none,
    ...prefixed("last", lastRect),
    lastId: last?.dataset.messageId ?? none,
    visualBlankAfterLast: lastBottom === undefined ? none : round(clientHeight - lastBottom),
    visualBlankAfterList: listBottom === undefined ? none : round(clientHeight - listBottom),
    visualBlankAfterContent: contentBottom === undefined ? none : round(clientHeight - contentBottom),
    scrollableAfterLast: lastBottom === undefined ? none : round(scrollHeight - (scrollTop + lastBottom)),
    scrollableAfterList: listBottom === undefined ? none : round(scrollHeight - (scrollTop + listBottom)),
    scrollableAfterContent: contentBottom === undefined ? none : round(scrollHeight - (scrollTop + contentBottom)),
  }
}

export function sessionLayoutLooksBlank(metrics: SessionLayoutMetrics): boolean {
  const scrollHeight = numeric(metrics.scrollHeight)
  const clientHeight = numeric(metrics.clientHeight)
  if (scrollHeight !== undefined && clientHeight !== undefined && scrollHeight <= clientHeight + 1) return false
  const bottomGap = numeric(metrics.bottomGap)
  if (bottomGap === undefined || bottomGap > 16) return false
  const rendered = numeric(metrics.rendered) ?? 0
  const turnNodes = numeric(metrics.turnNodes) ?? 0
  if (rendered > 0 && turnNodes === 0) return true
  const visualBlankAfterLast = numeric(metrics.visualBlankAfterLast) ?? 0
  const visualBlankAfterList = numeric(metrics.visualBlankAfterList) ?? 0
  const scrollableAfterLast = numeric(metrics.scrollableAfterLast) ?? 0
  return visualBlankAfterLast > 180 || visualBlankAfterList > 180 || scrollableAfterLast > 180
}

export function formatSessionLayoutMetrics(metrics: SessionLayoutMetrics): string {
  return Object.entries(metrics)
    .filter((entry): entry is [string, SessionLayoutMetricValue] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
}

export function logSessionLayout(
  source: string,
  metrics: SessionLayoutMetrics,
  extra: SessionLayoutMetrics = {},
): void {
  const fields: SessionLayoutMetrics = { ...metrics, ...extra }
  if (sessionLayoutLooksBlank(fields)) {
    console.warn(`[session-layout] source=${source} ${formatSessionLayoutMetrics(fields)}`)
  }
}
