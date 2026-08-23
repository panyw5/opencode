import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import {
  createVirtualizer,
  defaultRangeExtractor,
  elementScroll,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/solid-virtual"
import { Accordion } from "@opencode-ai/ui/accordion"
import { Button } from "@opencode-ai/ui/button"
import { Card } from "@opencode-ai/ui/card"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import {
  Message,
  MessageDivider,
  normalizeTool,
  type MessageProps,
  type UserActions,
} from "@opencode-ai/ui/message-part"
import { clearToolPartHydration, markToolHydrationScrollActivity } from "./deferred-tool-helpers"
import { DeferredMessagePart } from "./deferred-tool-part"
import { SessionRetry } from "@opencode-ai/ui/session-retry"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { normalize } from "@opencode-ai/ui/session-diff"
import { normalizeWheelDelta, shouldMarkBoundaryGesture } from "@/pages/session/message-gesture"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import {
  captureVirtualViewportAnchor,
  heightFromResizeObserverEntry,
  markdownMeasurementPending,
  READING_LINE_RATIO,
  restoreVirtualViewportAnchor,
  rowContentVersion,
  sameVirtualItemGeometry,
  shouldAdjustVirtualScroll,
  shouldCommitVirtualRowHeight,
  shouldDeferFastRowMeasurement,
  snapshotVirtualItems,
  timelineMeasurementsMatchWidth,
  timelinePartIsLive,
  timelineRowContentVisibility,
  virtualRowOverflow,
  type ViewportAnchor,
} from "./measure"
import {
  estimateRowHeight,
  rowRenderCost,
  timelineEstimateWidth,
  timelineTextMetrics,
  trimRangeToBudget,
} from "./estimate"
import { assistantCopySummary } from "./model"
import { createTimelineProjection } from "./projection"
import { sortMessages } from "@/utils/message-order"
import { MessageComment, type SummaryDiff, TimelineRow, TimelineRowMap } from "./rows"
import { timelineRowCache } from "./row-cache"
import { createSessionFind } from "./session-find"
import { FileSearchBar } from "@opencode-ai/ui/file-search"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }
const unknownRow = { _tag: "unknown" }
const overscanExpansionDelayMs = 750
/** Overscan budget: visible-row cost × multiplier (+ base so small viewports still prefetch). */
const OVERSCAN_COST_MULTIPLIER = 2
const OVERSCAN_COST_BASE = 8
/** Fast scrolling drops prefetch to a couple of cheap rows to protect frame time. */
const FAST_SCROLL_OVERSCAN = 2
const FAST_SCROLL_BUDGET_SHARE = 0.4
const FAST_SCROLL_SPEED = 1.5 // px per ms
const FAST_SCROLL_WINDOW_MS = 140

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root || !(nested instanceof HTMLElement)) return root
  return nested
}

function TimelineThinkingRow(props: {
  phase: "sending" | "thinking"
  reasoningHeading?: string
  showReasoningSummaries: boolean
}) {
  const language = useLanguage()
  const label = () =>
    language.t(props.phase === "sending" ? "ui.sessionTurn.status.sending" : "ui.sessionTurn.status.thinking")
  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={label()} active={props.phase === "thinking"} />
      <Show when={!props.showReasoningSummaries && props.phase === "thinking"}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[] }) {
  const language = useLanguage()
  const maxFiles = 10
  const [state, setState] = createStore({ open: false, showAll: false, expanded: [] as string[] })
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (state.showAll ? props.diffs : props.diffs.slice(0, maxFiles)))
  const onOpenChange = (open: boolean) => {
    setState("open", open)
    if (!open) setState("expanded", [])
  }

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={state.showAll || undefined}
    >
      <Collapsible open={state.open} onOpenChange={onOpenChange} variant="ghost">
        <Collapsible.Trigger>
          <div data-slot="session-turn-diffs-header">
            <span data-slot="session-turn-diffs-label">
              {language.t("ui.sessionTurn.diffs.summary", { count: String(props.diffs.length) })}
            </span>
            <div data-slot="session-turn-diffs-summary">
              <DiffChanges changes={props.diffs} />
              <Collapsible.Arrow />
            </div>
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Show when={state.open}>
            <div data-component="session-turn-diffs-content">
              <Accordion
                multiple
                style={{ "--sticky-accordion-offset": "44px" }}
                value={state.expanded}
                onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
              >
                <For each={visible()}>
                  {(diff) => (
                    <Accordion.Item value={diff.file}>
                      <StickyAccordionHeader>
                        <Accordion.Trigger>
                          <div data-slot="session-turn-diff-trigger">
                            <span data-slot="session-turn-diff-path">
                              <Show when={diff.file.includes("/")}>
                                <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                              </Show>
                              <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                            </span>
                            <div data-slot="session-turn-diff-meta">
                              <span data-slot="session-turn-diff-changes">
                                <DiffChanges changes={diff} />
                              </span>
                              <span data-slot="session-turn-diff-chevron">
                                <Icon name="chevron-down" size="small" />
                              </span>
                            </div>
                          </div>
                        </Accordion.Trigger>
                      </StickyAccordionHeader>
                      <Accordion.Content>
                        <Show when={state.expanded.includes(diff.file)}>
                          <TimelineDiffView diff={diff} />
                        </Show>
                      </Accordion.Content>
                    </Accordion.Item>
                  )}
                </For>
              </Accordion>
              <Show when={!state.showAll && overflow() > 0}>
                <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
                  {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
                </div>
              </Show>
            </div>
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)
  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view.fileDiff} />
    </div>
  )
}

export function MessageTimeline(props: {
  actions?: UserActions
  onBackgroundShell?: MessageProps["onBackgroundShell"]
  onBackgroundTask?: MessageProps["onBackgroundTask"]
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (
    el: HTMLDivElement,
    geometry?: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => void
  onAutoScrollHandleScroll: (geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: (scrollTop: number) => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  isInitialScrollSettling: () => boolean
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: (done: boolean) => void }) => void
  onRenderOverlayStatusChange?: (status: "showing" | "hiding" | "hidden") => void
}) {
  const sync = useSync()
  const settings = useSettings()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const ownerSessionKey = sessionKey()
  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()

  const sessionID = createMemo(() => params.id)
  // Debug profiling is intentionally sampled once per timeline mount. Reading
  // localStorage in resize/scroll hot paths caused hundreds of synchronous IPC
  // reads during a short wheel gesture. Set the flag and reload to profile.
  const lagDebug = typeof window !== "undefined" && window.localStorage.getItem("opencode.session.lag.debug") === "1"
  const lagging = () => lagDebug
  type TimelineDebugWindow = Window & {
    __opencodeTimelineDebug?: string[]
    __opencodeTimelineStates?: Record<
      string,
      {
        sessionID?: string
        ownerSessionKey: string
        rowCount: number
        messageCount: number
        initialMeasurementCount: number
        mountedKeys: string[]
        scrollTop: number
        scrollHeight: number
        clientHeight: number
      }
    >
  }
  const debugWindow = typeof window === "undefined" ? undefined : (window as TimelineDebugWindow)
  const recordTimelineDebug = (line: string) => {
    if (!lagDebug || !debugWindow) return
    const entries = (debugWindow.__opencodeTimelineDebug ??= [])
    entries.push(`${Math.round(performance.now())} ${line}`)
    if (entries.length > 4000) entries.splice(0, entries.length - 4000)
  }
  const timelineLag = (kind: string, fields: string) => {
    if (!lagging()) return
    const line = `[lag] timeline-${kind} sid=${sessionID() ?? "none"} ${fields}`
    recordTimelineDebug(line)
    console.debug(line)
  }
  createEffect(
    on(
      sessionID,
      (id, prev) => {
        if (lagging())
          console.debug(`[timeline] session-id from=${prev ?? "none"} to=${id ?? "none"} owner=${ownerSessionKey}`)
        if (prev && prev !== id) clearToolPartHydration(prev)
        if (!id) clearToolPartHydration()
      },
      { defer: true },
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    return id ? (sync.session.status.get(id) ?? idle) : idle
  })
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    const all = sync.data.message[id] ?? emptyMessages
    if (all.length < 2) return all
    const ordered = sortMessages(all)
    if (all[0] && ordered[0] && all[0].id !== ordered[0].id) {
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      if (lagging()) {
        console.debug(
          `[timeline] message-order corrected sid=${id} n=${String(ordered.length)} first=${first.id}:${String(first.time.created)} last=${last.id}:${String(last.time.created)}`,
        )
      }
    }
    return ordered
  })
  const getMessageParts = (messageID: string) => sync.data.part[messageID] ?? emptyParts
  const getMessagePart = (messageID: string, partID: string) =>
    getMessageParts(messageID).find((part) => part.id === partID)
  const userMessageText = (messageID: string) => {
    const texts = getMessageParts(messageID).flatMap((part) =>
      part.type === "text" && part.text && !part.synthetic ? [part.text] : [],
    )
    // UserMessageDisplay initially collapses long prompts to its first 1000
    // characters. The estimator must describe that first DOM state rather than
    // the full text that is only mounted after explicit user expansion.
    return texts.length > 0 ? texts.join("\n").slice(0, 1000) : undefined
  }
  const userMessageHasInjectedPrompt = (messageID: string) =>
    getMessageParts(messageID).some((part) => part.type === "text" && !!part.synthetic && !!part.text)
  const commentStripTexts = (messageID: string) =>
    getMessageParts(messageID).flatMap((part) => MessageComment.fromPart(part)?.comment ?? [])

  // Row-size inputs tracked outside estimateSize so the virtualizer's reactive
  // update re-estimates uncached rows without forcing layout (no clientWidth
  // read inside the estimate path).
  const [listSize, setListSize] = createSignal({ width: 0, height: 0 })
  let listResizeObserver: ResizeObserver | undefined
  const textMetrics = createMemo(() => {
    // Markdown metrics scale with the user's base font size setting.
    settings.appearance.fontSize()
    return timelineTextMetrics(listRoot())
  })
  const defaultOpen = (part: PartType) => {
    if (part.type !== "tool") return
    const tool = normalizeTool(part.tool)
    if (tool === "bash") return settings.general.shellToolPartsExpanded()
    if (["edit", "write", "apply_patch"].includes(tool)) return settings.general.editToolPartsExpanded()
  }
  // --- Batched row measurement (single ResizeObserver owned by the virtualizer) ---
  // All height commits funnel through the measureElement option below: the
  // virtualizer's own ResizeObserver delivers border-box entry heights without
  // explicit layout reads, and each committed height goes through the owning row's handler
  // (live-shrink guard + contentHeight signal + row cache persistence).
  const rowHeightHandlers = new Map<string, (raw: number) => number>()
  const elementRowKey = new WeakMap<HTMLElement, string>()
  const pendingNearBottomShrinks = new Map<number, { key: string; size: number }>()
  const deferredFastMeasurements = new Map<number, { key: string; size: number }>()
  let deferredFastMeasurementTimer: number | undefined

  // Programmatic scrolls (anchor restore, TanStack scroll adjustments,
  // scrollToIndex/scrollToEnd) must not be mistaken for user scrolling: they
  // neither mark the user as detached from the bottom nor arm history loads.
  // Real wheel/touch input clears the marker immediately. The cumulative
  // programmatic delta lets the post-batch anchor math separate user scrolling
  // from compensation writes.
  const programmaticScrollWindowMs = 160
  let programmaticScrollAt = 0
  let programmaticScrollDelta = 0
  const markProgrammaticScroll = (delta = 0) => {
    programmaticScrollAt = performance.now()
    programmaticScrollDelta += delta
  }
  const isProgrammaticScrollActive = () => performance.now() - programmaticScrollAt < programmaticScrollWindowMs

  // Scroll velocity (px/ms, exponentially smoothed) drives overscan: fast
  // flings shrink the prefetch window so mounting rows cannot overrun frames.
  let velocityTrackedAt = 0
  let velocityTrackedTop = 0
  let scrollVelocity = 0
  const trackScrollVelocity = (scrollTop: number) => {
    const now = performance.now()
    const dt = now - velocityTrackedAt
    if (dt > 2 && dt < 300) {
      const speed = Math.abs(scrollTop - velocityTrackedTop) / dt
      scrollVelocity = scrollVelocity * 0.7 + speed * 0.3
    }
    velocityTrackedAt = now
    velocityTrackedTop = scrollTop
  }
  const fastScrolling = () =>
    scrollVelocity > FAST_SCROLL_SPEED && performance.now() - velocityTrackedAt < FAST_SCROLL_WINDOW_MS

  // Anchors captured after the previous measurement batch; restored right
  // after the next one (synchronously inside the ResizeObserver callback,
  // before paint) so height commits never show a frame of displaced content.
  // The top anchor keeps the viewport-top row steady (TanStack only adjusts
  // rows fully above the viewport); the reading anchor keeps the mid-viewport
  // row steady against in-view growth between the two — markdown parse
  // landing, deferred hydration, content-visibility un-skip.
  let viewportAnchor: ViewportAnchor | undefined
  let readingAnchor: ViewportAnchor | undefined
  let measurementBatchPending = false
  let measurementPassQueued = false
  const queueMeasurementPass = () => {
    if (!measurementBatchPending || measurementPassQueued) return
    measurementPassQueued = true
    queueMicrotask(() => {
      measurementPassQueued = false
      if (!measurementBatchPending) return
      measurementBatchPending = false
      if (lagging()) {
        timelineLag(
          "batch-dispatch",
          `top=${Math.round(listRoot()?.scrollTop ?? 0)} bottom=${String(props.shouldAnchorBottom())} prepend=${String(prependLoading)} viewport=${viewportAnchor?.key ?? "none"} reading=${readingAnchor?.key ?? "none"}`,
        )
      }
      afterMeasurementBatch()
    })
  }
  const afterMeasurementBatch = () => {
    const root = listRoot()
    if (!root) return
    if (props.shouldAnchorBottom()) {
      viewportAnchor = undefined
      readingAnchor = undefined
      // TanStack already adjusts by each committed delta while bottom-anchored;
      // this only closes residual gaps (e.g. a guarded shrink committing late).
      // Never while the user is gesturing: writing scrollTop mid-gesture
      // locks the user to the bottom.
      if (!props.isInitialScrollSettling() && !props.hasScrollGesture()) {
        const gap = virtualizer.getTotalSize() - listSize().height - root.scrollTop
        if (gap > 0.5) {
          markProgrammaticScroll(gap)
          root.scrollTop += gap
          if (lagging()) timelineLag("batch-pin", `gap=${Math.round(gap)}`)
        }
      }
      return
    }
    if (prependLoading) return
    const items = virtualizer.measurementsCache
    // measurementsCache is sparse while virtual rows are being discovered;
    // snapshotVirtualItems removes empty slots before building the lookup.
    const byKey = snapshotVirtualItems(items).byKey
    if (viewportAnchor) {
      // Split the raw scrollTop change into the user's own scrolling and
      // programmatic writes; only height-commit displacement gets corrected.
      const userDelta =
        root.scrollTop - viewportAnchor.scrollTop - (programmaticScrollDelta - viewportAnchor.programmaticDelta)
      const delta = restoreVirtualViewportAnchor({
        root,
        anchor: viewportAnchor,
        itemByKey: (key) => byKey.get(key),
        userScrollDelta: userDelta,
      })
      if (lagging()) {
        timelineLag(
          "virtual-anchor",
          `phase=restore key=${viewportAnchor.key} offset=${Math.round(viewportAnchor.offset)} user=${Math.round(userDelta)} delta=${Math.round(delta)} top=${Math.round(root.scrollTop)} item=${(() => {
            const item = byKey.get(viewportAnchor.key)
            return item ? `${Math.round(item.start)}/${Math.round(item.size)}` : "missing"
          })()}`,
        )
      }
      if (delta !== 0) markProgrammaticScroll(delta)
      if (lagging() && Math.abs(delta) > 0.5) {
        timelineLag(
          "anchor-restore",
          `key=${viewportAnchor.key} delta=${Math.round(delta)} user=${Math.round(userDelta)}`,
        )
      }
      if (readingAnchor) {
        // Residual displacement of the reading row after the top restore: the
        // two anchors only disagree when a row between them changed size, and
        // then the reading line wins — that is the content being read.
        const readingUserDelta =
          root.scrollTop - readingAnchor.scrollTop - (programmaticScrollDelta - readingAnchor.programmaticDelta)
        const readingDelta = restoreVirtualViewportAnchor({
          root,
          anchor: readingAnchor,
          itemByKey: (key) => byKey.get(key),
          userScrollDelta: readingUserDelta,
        })
        if (lagging()) {
          timelineLag(
            "virtual-anchor",
            `phase=reading-restore key=${readingAnchor.key} offset=${Math.round(readingAnchor.offset)} user=${Math.round(readingUserDelta)} delta=${Math.round(readingDelta)} top=${Math.round(root.scrollTop)} item=${(() => {
              const item = byKey.get(readingAnchor.key)
              return item ? `${Math.round(item.start)}/${Math.round(item.size)}` : "missing"
            })()}`,
          )
        }
        if (readingDelta !== 0) markProgrammaticScroll(readingDelta)
        if (lagging() && Math.abs(readingDelta) > 0.5) {
          timelineLag(
            "reading-restore",
            `key=${readingAnchor.key} delta=${Math.round(readingDelta)} user=${Math.round(readingUserDelta)}`,
          )
        }
      }
    }
    viewportAnchor = captureVirtualViewportAnchor(root, items, programmaticScrollDelta)
    readingAnchor = captureVirtualViewportAnchor(root, items, programmaticScrollDelta, READING_LINE_RATIO)
    if (lagging()) {
      timelineLag(
        "virtual-anchor",
        `phase=capture top=${Math.round(root.scrollTop)} viewport=${viewportAnchor?.key ?? "none"}/${Math.round(viewportAnchor?.offset ?? 0)} reading=${readingAnchor?.key ?? "none"}/${Math.round(readingAnchor?.offset ?? 0)}`,
      )
    }
  }

  const projection = createTimelineProjection({
    messages: sessionMessages,
    userMessages: () => props.userMessages,
    parts: getMessageParts,
    status: sessionStatus,
    showReasoningSummaries: settings.general.showReasoningSummaries,
    showCustomHookParts: settings.general.showCustomHookParts,
  })
  const timelineRows = projection.rows
  const timelineRowByKey = projection.rowByKey
  const messageRowIndex = projection.messageRowIndex
  const messageByID = projection.messageByID
  const assistantMessagesByParent = projection.assistantMessagesByParent
  const activeMessageID = projection.activeMessageID
  const queuedMessageIDs = projection.queuedMessageIDs
  const lastAssistantGroupKey = projection.lastAssistantGroupKey
  const activeAssistantRowIndex = createMemo(() => {
    const activeID = activeMessageID()
    const groupKey = activeID ? lastAssistantGroupKey().get(activeID) : undefined
    if (!activeID || !groupKey) return
    const index = timelineRows().findIndex(
      (row) => row._tag === "AssistantPart" && row.userMessageID === activeID && row.group.key === groupKey,
    )
    return index >= 0 ? index : undefined
  })
  const estimatorWidth = createMemo(() =>
    timelineEstimateWidth({
      viewportWidth: listSize().width,
      centered: props.centered,
      contentWidth: settings.appearance.contentWidth(),
    }),
  )
  const textPartMetaIDs = createMemo(() => {
    const result = new Set<string>()
    for (const user of props.userMessages) {
      const partID = assistantCopySummary(
        assistantMessagesByParent().get(user.id) ?? emptyAssistantMessages,
        getMessageParts,
      ).partID
      if (partID) result.add(partID)
    }
    return result
  })
  const estimatorOptions = () => {
    const metrics = textMetrics()
    return {
      parts: getMessagePart,
      toolDefaultOpen: (part: ToolPart) => defaultOpen(part) ?? false,
      userMessageText,
      commentStripTexts,
      userMessageHasInjectedPrompt,
      textPartHasMeta: (_messageID: string, partID: string) => textPartMetaIDs().has(partID),
      reasoningStreaming: (messageID: string, part: PartType) => {
        if (part.type !== "reasoning") return false
        const message = messageByID().get(messageID)
        if (message?.role !== "assistant") return false
        return typeof part.time?.end !== "number" && typeof message.time.completed !== "number"
      },
      charWidth: metrics.charWidth,
    }
  }

  // Build the virtualizer's initial measurement cache from the row-level
  // measurement cache. Each row is validated independently against its own
  // contentVersion, so a new message elsewhere does not invalidate rows
  // whose content is unchanged (C2). Width is taken from the cached row
  // entry itself; rows whose stored width is incompatible with 0 (unknown)
  // are still accepted because rowWidthCompatible treats 0 as always valid.
  const initialMeasurements: VirtualItem[] = []
  {
    const rowsNow = timelineRows()
    let start = 0
    for (let index = 0; index < rowsNow.length; index++) {
      const row = rowsNow[index]
      const key = TimelineRow.key(row)
      const version = rowContentVersion(row, getMessagePart)
      // Use width=0 so any cached width is accepted on initial mount.
      const height = timelineRowCache.getHeight(key, version, 0)
      if (height !== undefined && height > 0) {
        initialMeasurements.push({
          key,
          index,
          start,
          end: start + height,
          size: height,
          lane: 0,
        } as VirtualItem)
      }
      start += height ?? 0
    }
  }
  const hasCachedMeasurements = initialMeasurements.length > 0
  const coldBottomMount = !hasCachedMeasurements && props.shouldAnchorBottom()
  const [renderOverscan, setRenderOverscan] = createSignal(hasCachedMeasurements || coldBottomMount ? 6 : 20)

  type PrependAnchor = {
    key: string
    offset: number
    scrollTop: number
    contentHeight: number
  }
  let prependAnchor: PrependAnchor | undefined
  let prependLoading = false
  let prependRestoreDone = false
  let prependAnchorFrame: number | undefined
  // Prefer the virtual spacer height (full list) over the viewport scrollHeight.
  const contentHeight = (root: HTMLDivElement) => virtualContent?.offsetHeight ?? root.scrollHeight
  const clearPrependAnchor = () => {
    prependAnchor = undefined
    prependLoading = false
    prependRestoreDone = false
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    prependRestoreDone = false
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const height = contentHeight(root)
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    const key = anchor?.element.dataset.timelineKey
    if (anchor && key) {
      prependAnchor = {
        key,
        offset: anchor.rect.top - view.top,
        scrollTop: root.scrollTop,
        contentHeight: height,
      }
      return
    }
    // No mounted row (rare) — still pin by content growth so prepend does not jump to top.
    prependAnchor = {
      key: "",
      offset: 0,
      scrollTop: root.scrollTop,
      contentHeight: height,
    }
  }
  const restorePrependAnchor = (done: boolean) => {
    // Keep prependLoading true until the pin loop settles, otherwise scroll events
    // re-trigger history loads and the anchor is cleared mid-restore.
    if (done) prependRestoreDone = true
    const root = listRoot()
    const saved = prependAnchor
    if (!root || !saved) {
      if (done) clearPrependAnchor()
      return
    }
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const restore = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) {
        if (prependRestoreDone) prependLoading = false
        return
      }
      const height = contentHeight(root)
      let delta = 0
      if (anchor.key) {
        const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
        if (element) {
          delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
        } else {
          // Anchor row not mounted yet (virtualizer range) — use total size growth.
          delta = height - anchor.contentHeight
        }
      } else {
        delta = height - anchor.contentHeight
      }
      if (Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        anchor.scrollTop = root.scrollTop
        anchor.contentHeight = height
        stable = 0
      } else {
        anchor.contentHeight = height
        stable += 1
      }
      frames += 1
      if (stable >= 8 || frames >= 180) {
        if (prependRestoreDone) {
          prependAnchor = undefined
          prependLoading = false
          prependRestoreDone = false
        }
        return
      }
      prependAnchorFrame = requestAnimationFrame(restore)
    }
    prependAnchorFrame = requestAnimationFrame(restore)
  }

  let virtualContent: HTMLDivElement | undefined
  let resizePinFrame: number | undefined
  let resizePinnedIndexes: number[] = []
  // Explicit annotation: the measureElement option reads the virtualizer's
  // measurement cache, which would otherwise create a circular type inference.
  const virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement> = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    initialMeasurementsCache: initialMeasurements,
    measureElement: (element: HTMLElement, entry: ResizeObserverEntry | undefined) => {
      const fromEntry = heightFromResizeObserverEntry(entry)
      if (fromEntry !== undefined) {
        const key = elementRowKey.get(element)
        const handler = key ? rowHeightHandlers.get(key) : undefined
        return handler ? handler(fromEntry) : fromEntry
      }
      // Synchronous call path (element registration on mount, no entry):
      // return the current virtual size so resizeItem sees delta 0 — no
      // forced layout per mounted row. The observer's initial entry (same
      // frame, before paint) delivers the real height with zero layout reads.
      const index = Number.parseInt(element.dataset.index ?? "", 10)
      if (Number.isFinite(index)) {
        const size = virtualizer.measurementsCache[index]?.size
        if (typeof size === "number" && size > 0) return size
      }
      return element.offsetHeight
    },
    estimateSize: (index: number) => {
      const size = listSize()
      const metrics = textMetrics()
      return estimateRowHeight(timelineRows()[index] ?? unknownRow, estimatorWidth(), {
        ...estimatorOptions(),
        viewportHeight: size.height,
        textLineHeight: metrics.lineHeight,
      })
    },
    scrollToFn: (offset, options, instance) => {
      const root = listRoot()
      if (root) markProgrammaticScroll(offset + (options.adjustments ?? 0) - root.scrollTop)
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) =>
        TimelineRow.key(rows[index] ?? new TimelineRow.TurnGap({ userMessageID: `removed:${index}` }))
    },
    overscan: 50,
    paddingEnd: 64,
    rangeExtractor: (range) => {
      const rows = timelineRows()
      const fast = fastScrolling()
      const overscan = fast ? Math.min(FAST_SCROLL_OVERSCAN, renderOverscan()) : renderOverscan()
      const indexes = defaultRangeExtractor({ ...range, overscan })
      const options = estimatorOptions()
      const costOf = (index: number) => rowRenderCost(rows[index] ?? unknownRow, options)
      let visibleCost = 0
      for (let index = range.startIndex; index <= range.endIndex; index++) visibleCost += costOf(index)
      const budget = visibleCost * (fast ? FAST_SCROLL_BUDGET_SHARE : OVERSCAN_COST_MULTIPLIER) + OVERSCAN_COST_BASE
      const trimmed = trimRangeToBudget({
        indexes,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        costOf,
        budget,
        // A floor per side guards against budget-starved windows leaving
        // blanks when a huge row dominates the visible cost.
        minPerSide: fast ? 1 : 3,
      })
      const active = activeAssistantRowIndex()
      const lastIndex = rows.length - 1
      return [
        ...new Set([
          ...resizePinnedIndexes,
          ...trimmed,
          ...(active === undefined ? [] : [active]),
          // While pinned to the bottom the tail row must stay mounted so the
          // follow scroll and its live measurement never unmount.
          ...(lastIndex >= 0 && props.shouldAnchorBottom() ? [lastIndex] : []),
        ]),
      ].sort((a, b) => a - b)
    },
  })
  const resizeItem = virtualizer.resizeItem
  const cacheCommittedRowHeight = (rowKey: string, size: number) => {
    const currentRow = timelineRowByKey().get(rowKey)
    if (!currentRow) return
    timelineRowCache.setMeasured(rowKey, size, rowContentVersion(currentRow, getMessagePart), estimatorWidth())
  }
  const scheduleDeferredFastMeasurementFlush = () => {
    if (deferredFastMeasurementTimer !== undefined) window.clearTimeout(deferredFastMeasurementTimer)
    deferredFastMeasurementTimer = window.setTimeout(() => {
      deferredFastMeasurementTimer = undefined
      if (fastScrolling()) {
        scheduleDeferredFastMeasurementFlush()
        return
      }
      for (const [index, pending] of deferredFastMeasurements) {
        const current = virtualizer.measurementsCache[index]
        deferredFastMeasurements.delete(index)
        if (!current || String(current.key) !== pending.key) continue
        measurementBatchPending = true
        virtualizer.resizeItem(index, pending.size)
        cacheCommittedRowHeight(pending.key, pending.size)
      }
    }, 180)
  }
  virtualizer.resizeItem = (index, size) => {
    const profiling = lagging()
    const started = profiling ? performance.now() : 0
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    const beforeScroll = profiling ? (root?.scrollTop ?? 0) : 0
    const rowElement = profiling ? root?.querySelector<HTMLElement>(`[data-index="${index}"]`) : undefined
    const rowTop =
      profiling && root && rowElement ? rowElement.getBoundingClientRect().top - root.getBoundingClientRect().top : 0
    const stages = profiling
      ? [...(rowElement?.querySelectorAll<HTMLElement>('[data-component="markdown"]') ?? [])]
          .map((node) => `${node.dataset.markdownStage ?? "none"}/${node.dataset.markdownRenderedStage ?? "none"}`)
          .join(",") || "none"
      : "none"
    const visibility = profiling && rowElement ? getComputedStyle(rowElement).contentVisibility : "none"
    let pinned = 0
    if (root && previous !== undefined && Math.abs(size - previous) > listSize().height) {
      const view = root.getBoundingClientRect()
      resizePinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > view.top && rect.top < view.bottom
        })
        .map((element) => Number(element.dataset.index))
      pinned = resizePinnedIndexes.length
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
    const afterScroll = profiling ? (root?.scrollTop ?? 0) : 0
    queueMeasurementPass()
    const duration = profiling ? performance.now() - started : 0
    if (profiling && (duration >= 4 || pinned > 0 || Math.abs(size - (previous ?? size)) >= 1)) {
      timelineLag(
        "resize",
        `index=${index} key=${String(item?.key ?? "none")} previous=${Math.round(previous ?? 0)} next=${Math.round(size)} delta=${Math.round(size - (previous ?? size))} rowTop=${Math.round(rowTop)} stages=${stages} visibility=${visibility} scrollBefore=${Math.round(beforeScroll)} scrollAfter=${Math.round(afterScroll)} scrollDelta=${Math.round(afterScroll - beforeScroll)} pinned=${pinned} rendered=${virtualizer.getVirtualItems().length} duration=${Math.round(duration)}`,
      )
      requestAnimationFrame(() => {
        timelineLag(
          "resize-frame",
          `index=${index} key=${String(item?.key ?? "none")} scrollBefore=${Math.round(beforeScroll)} scrollFrame=${Math.round(root?.scrollTop ?? 0)} scrollDelta=${Math.round((root?.scrollTop ?? 0) - beforeScroll)}`,
        )
      })
    }
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    const root = listRoot()
    const scrollOffset = instance.getLogicalScrollOffset()
    // While the user is actively wheeling/touching away from the bottom, the
    // bottom-anchored adjustment would fight the gesture; the first user
    // scroll event then latches user-scrolled and adjustments stop.
    const bottomAnchored = props.shouldAnchorBottom() && !props.hasScrollGesture()
    const adjust = shouldAdjustVirtualScroll({
      itemEnd: item.end,
      scrollOffset,
      bottomAnchored,
      initializing: props.isInitialScrollSettling(),
    })
    if (lagging() && Math.abs(delta) >= 1) {
      timelineLag(
        "resize-adjust",
        `index=${item.index} key=${String(item.key)} delta=${Math.round(delta)} itemStart=${Math.round(item.start)} itemEnd=${Math.round(item.end)} scrollOffset=${Math.round(scrollOffset)} viewport=${Math.round(root?.clientHeight ?? 0)} adjust=${adjust} bottom=${props.shouldAnchorBottom()} initializing=${props.isInitialScrollSettling()}`,
      )
    }
    return adjust
  }
  const virtualSnapshot = createMemo(() => snapshotVirtualItems(virtualizer.getVirtualItems()))
  const virtualItemByKey = createMemo(() => virtualSnapshot().byKey)
  const virtualRowKeys = createMemo(() => virtualSnapshot().keys)
  const refreshUserScrollAnchors = (root: HTMLDivElement, scrollTop: number) => {
    const items = virtualizer.measurementsCache
    const geometry = { scrollTop, clientHeight: listSize().height }
    viewportAnchor = captureVirtualViewportAnchor(geometry, items, programmaticScrollDelta)
    readingAnchor = captureVirtualViewportAnchor(geometry, items, programmaticScrollDelta, READING_LINE_RATIO)
  }

  // --- Session find ---
  const sessionFind = createSessionFind({
    virtualizer,
    listRoot,
    timelineRows,
    rowByKey: timelineRowByKey,
    getMessageParts,
    sessionID,
  })

  if (lagDebug) {
    let lastRenderTrace = ""
    createEffect(() => {
      const rows = timelineRows()
      const snapshot = virtualSnapshot()
      const messageCount = sessionMessages().length
      const trace = `${sessionID() ?? "none"}:${messageCount}:${rows.length}:${snapshot.keys.length}:${snapshot.keys[0] ?? "none"}:${snapshot.keys.at(-1) ?? "none"}`
      if (trace === lastRenderTrace) return
      lastRenderTrace = trace
      if (debugWindow) {
        const root = listRoot()
        const states = (debugWindow.__opencodeTimelineStates ??= {})
        states[ownerSessionKey] = {
          sessionID: sessionID(),
          ownerSessionKey,
          rowCount: rows.length,
          messageCount,
          initialMeasurementCount: initialMeasurements.length,
          mountedKeys: [...snapshot.keys],
          scrollTop: root?.scrollTop ?? 0,
          scrollHeight: root?.scrollHeight ?? 0,
          clientHeight: root?.clientHeight ?? 0,
        }
      }
      console.debug(
        `[timeline] render-state sid=${sessionID() ?? "none"} messages=${String(messageCount)} rows=${String(rows.length)} virtual=${String(snapshot.keys.length)} first=${snapshot.keys[0] ?? "none"} last=${snapshot.keys.at(-1) ?? "none"}`,
      )
    })
  }

  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index !== undefined) virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  let overscanTimer: number | undefined
  onMount(() => {
    if (lagging()) {
      console.debug(
        `[timeline] mount session=${sessionID() ?? "none"} owner=${ownerSessionKey} cached=${String(!!initialMeasurements)} rows=${String(timelineRows().length)}`,
      )
    }
    overscanTimer = window.setTimeout(() => {
      overscanTimer = undefined
      const previousOverscan = renderOverscan()
      if (previousOverscan < 20) setRenderOverscan(20)
    }, overscanExpansionDelayMs)
  })

  onCleanup(() => {
    if (lagging()) {
      console.debug(
        `[timeline] unmount session=${sessionID() ?? "none"} owner=${ownerSessionKey} rows=${String(timelineRows().length)}`,
      )
    }
    clearPrependAnchor()
    pendingNearBottomShrinks.clear()
    deferredFastMeasurements.clear()
    if (deferredFastMeasurementTimer !== undefined) window.clearTimeout(deferredFastMeasurementTimer)
    // Persist measured row heights into the row-level cache so the next mount
    // (tab switch, session re-entry) can reuse them without re-measuring.
    const width = estimatorWidth()
    const rowsNow = timelineRows()
    for (const item of virtualizer.takeSnapshot()) {
      if (!item || item.size <= 0) continue
      const rowKey = String(item.key)
      // Find the row to compute its content version.
      const row = timelineRowByKey().get(rowKey)
      if (!row) continue
      const version = rowContentVersion(row, getMessagePart)
      timelineRowCache.setMeasured(rowKey, item.size, version, width)
    }
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    if (overscanTimer !== undefined) window.clearTimeout(overscanTimer)
    listResizeObserver?.disconnect()
    if (debugWindow?.__opencodeTimelineStates) delete debugWindow.__opencodeTimelineStates[ownerSessionKey]
    restoreScrollTopDebug?.()
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
    if (renderOverlayTimer !== undefined) window.clearTimeout(renderOverlayTimer)
  })

  let renderOverlayTimer: number | undefined
  createEffect(
    on(
      sessionID,
      (id, previous) => {
        if (!id) {
          props.onRenderOverlayStatusChange?.("hidden")
          return
        }
        if (id !== previous) props.onRenderOverlayStatusChange?.("showing")
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    if (!timelineRows().length) return
    requestAnimationFrame(() => {
      props.onRenderOverlayStatusChange?.("hiding")
      if (renderOverlayTimer !== undefined) window.clearTimeout(renderOverlayTimer)
      renderOverlayTimer = window.setTimeout(() => props.onRenderOverlayStatusChange?.("hidden"), 180)
    })
  })

  let restoreScrollTopDebug: (() => void) | undefined
  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    restoreScrollTopDebug?.()
    setListRoot(root)
    props.setScrollRef(root)
    if (lagDebug) {
      const prototypeDescriptor = (() => {
        let current: object | null = root
        while (current) {
          const descriptor = Object.getOwnPropertyDescriptor(current, "scrollTop")
          if (descriptor)
            return descriptor as PropertyDescriptor & {
              get?: () => number
              set?: (value: number) => void
            }
          current = Object.getPrototypeOf(current)
        }
        return undefined
      })()
      if (prototypeDescriptor?.set && prototypeDescriptor.get) {
        const originalScrollTo = root.scrollTo.bind(root)
        const originalScrollBy = root.scrollBy.bind(root)
        Object.defineProperty(root, "scrollTop", {
          configurable: true,
          get: () => prototypeDescriptor.get!.call(root),
          set: (value: number) => {
            const before = prototypeDescriptor.get!.call(root)
            prototypeDescriptor.set!.call(root, value)
            const after = prototypeDescriptor.get!.call(root)
            recordTimelineDebug(
              `[lag] scrollTop-set before=${Math.round(before)} requested=${Math.round(value)} after=${Math.round(after)} stack=${new Error().stack?.split("\\n").slice(2, 6).join("|") ?? "none"}`,
            )
          },
        })
        root.scrollTo = ((...args: Parameters<HTMLDivElement["scrollTo"]>) => {
          recordTimelineDebug(
            `[lag] scrollTo-call args=${args.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(",")} before=${Math.round(root.scrollTop)} stack=${new Error().stack?.split("\\n").slice(2, 6).join("|") ?? "none"}`,
          )
          originalScrollTo(...args)
        }) as HTMLDivElement["scrollTo"]
        root.scrollBy = ((...args: Parameters<HTMLDivElement["scrollBy"]>) => {
          recordTimelineDebug(
            `[lag] scrollBy-call args=${args.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(",")} before=${Math.round(root.scrollTop)} stack=${new Error().stack?.split("\\n").slice(2, 6).join("|") ?? "none"}`,
          )
          originalScrollBy(...args)
        }) as HTMLDivElement["scrollBy"]
        restoreScrollTopDebug = () => {
          Reflect.deleteProperty(root, "scrollTop")
          root.scrollTo = originalScrollTo
          root.scrollBy = originalScrollBy
          restoreScrollTopDebug = undefined
        }
      }
    }
    // Track the scroll viewport size for row height estimation (estimate.ts).
    listResizeObserver?.disconnect()
    listResizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      const box = entry?.borderBoxSize
      const border = Array.isArray(box) ? box[0] : box
      if (border && border.inlineSize > 0 && border.blockSize > 0) {
        setListSize({ width: border.inlineSize, height: border.blockSize })
        return
      }
      if (entry?.contentRect.width && entry.contentRect.height) {
        setListSize({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    listResizeObserver.observe(root)
    setListSize({ width: root.clientWidth, height: root.clientHeight })
    // Initial setup does not know the viewport width and accepts cached rows
    // provisionally. Preserve compatible itemSizeCache entries; a full
    // measure() would otherwise discard every valid cached height on each
    // mount and defeat the row cache. Rebuild only when at least one restored
    // measurement came from a meaningfully different width.
    const cachedWidthCompatible = initialMeasurements.every((item) => {
      const cached = timelineRowCache.get(String(item.key))
      return !cached || timelineMeasurementsMatchWidth(cached.width, estimatorWidth())
    })
    if (!cachedWidthCompatible) virtualizer.measure()
  }
  const markBoundaryGesture = (root: HTMLDivElement, target: EventTarget | null, delta: number) => {
    const nested = boundaryTarget(root, target)
    if (
      nested === root ||
      shouldMarkBoundaryGesture({
        delta,
        scrollTop: nested.scrollTop,
        scrollHeight: nested.scrollHeight,
        clientHeight: nested.clientHeight,
      })
    ) {
      props.onMarkScrollGesture(root)
    }
  }
  let touchGesture: number | undefined
  const handleScroll = (
    geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
    event: Event & { currentTarget: HTMLDivElement },
  ) => {
    const root = event.currentTarget
    if (lagging()) {
      timelineLag(
        "scroll",
        `trusted=${String(event.isTrusted)} top=${Math.round(geometry.scrollTop)} height=${Math.round(geometry.scrollHeight)} client=${Math.round(geometry.clientHeight)} programmatic=${String(isProgrammaticScrollActive())} gesture=${String(props.hasScrollGesture())}`,
      )
    }
    props.onScheduleScrollState(root, geometry)
    trackScrollVelocity(geometry.scrollTop)
    // While history is prepended we programmatically adjust scrollTop. Those events
    // must not clear the pin or request another page (that chain-loads to the top).
    if (prependLoading) return
    // Height-batch anchor restores and virtualizer scroll adjustments are
    // programmatic: they must not mark the user as scrolled-away nor arm
    // history loading. A programmatic scroll event can still report
    // isTrusted=true and inherit the gesture window of the wheel that caused
    // the measurement, so the gesture flag cannot be used as the discriminator.
    // Real wheel/touch handlers clear programmaticScrollAt before the matching
    // user scroll event arrives.
    if (isProgrammaticScrollActive()) return
    refreshUserScrollAnchors(root, geometry.scrollTop)
    if (!props.hasScrollGesture()) {
      props.onHistoryScroll(geometry.scrollTop)
      return
    }
    clearPrependAnchor()
    props.onAutoScrollHandleScroll(geometry)
    props.onUserScroll()
    props.onMarkScrollGesture(root)
    props.onHistoryScroll(geometry.scrollTop)
    if (pendingNearBottomShrinks.size > 0) {
      const maxScrollTop = virtualizer.getTotalSize() - geometry.clientHeight
      for (const [index, pending] of pendingNearBottomShrinks) {
        const item = virtualizer.measurementsCache[index]
        if (!item) {
          pendingNearBottomShrinks.delete(index)
          continue
        }
        const nextMaxScrollTop = maxScrollTop + pending.size - item.size
        if (geometry.scrollTop <= nextMaxScrollTop - 1) {
          pendingNearBottomShrinks.delete(index)
          virtualizer.resizeItem(index, pending.size)
          cacheCommittedRowHeight(pending.key, pending.size)
          if (lagging()) {
            timelineLag(
              "deferred-shrink",
              `index=${index} key=${pending.key} size=${Math.round(pending.size)} top=${Math.round(geometry.scrollTop)}`,
            )
          }
        }
      }
    }
    // Refresh find highlights after scroll (mounted rows change)
    sessionFind.refreshHighlights()
  }

  // activeMessageID is sticky (debounced exit) so brief status blips do not flash the turn.
  const workingTurn = (userMessageID: string) => activeMessageID() === userMessageID
  const turnDurationMs = (userMessageID: string) => {
    const user = messageByID().get(userMessageID)
    if (!user || user.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (latest, message) =>
        typeof message.time.completed === "number" ? Math.max(latest ?? 0, message.time.completed) : latest,
      undefined,
    )
    return typeof end === "number" && end >= user.time.created ? end - user.time.created : undefined
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const row = input.row
    const anchor = () => {
      const value = row()
      if (!value) return false
      return value._tag === "CommentStrip" || (value._tag === "UserMessage" && value.anchor)
    }
    const previousAssistantPart = () => {
      const value = row()
      if (!value) return false
      return value._tag === "AssistantPart" && value.previousAssistantPart
    }
    return (
      <div
        id={anchor() ? props.anchor(row().userMessageID) : undefined}
        data-message-id={row().userMessageID}
        data-timeline-row={row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-[var(--session-content-width)] md:mx-auto": props.centered,
          "pt-3": previousAssistantPart(),
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }
  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>) => {
    switch (row()._tag) {
      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
      case "CommentStrip": {
        const item = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMessageParts(item().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={item}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <For each={comments()}>
                    {(comment) => (
                      <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment.path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment.path)}</span>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment.comment}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const item = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => messageByID().get(item().userMessageID))
        return (
          <TimelineRowFrame row={item}>
            <Show when={message()}>
              {(value) => (
                <div class="w-full px-4 md:px-5">
                  <Message
                    message={value()}
                    parts={getMessageParts(value().id)}
                    queued={queuedMessageIDs().has(value().id)}
                    actions={props.actions}
                    onBackgroundShell={props.onBackgroundShell}
                    onBackgroundTask={props.onBackgroundTask}
                    showCustomHookParts={settings.general.showCustomHookParts()}
                    markdownViewport={listRoot()}
                    markdownHighlight="defer"
                    markdownMath="full"
                  />
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const item = row as Accessor<TimelineRowByTag<"TurnDivider">>
        return (
          <TimelineRowFrame row={item}>
            <div class="w-full px-4 md:px-5">
              <MessageDivider
                label={language.t(
                  item().label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted",
                )}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const item = row as Accessor<TimelineRowByTag<"AssistantPart">>
        const assistantCopy = createMemo(() => {
          const userMessageID = item().userMessageID
          if (workingTurn(userMessageID)) return { partID: null, text: "" }
          return assistantCopySummary(
            assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages,
            getMessageParts,
          )
        })
        const message = createMemo(() => {
          const group = item().group
          return group.type === "part" ? messageByID().get(group.ref.messageID) : undefined
        })
        const part = createMemo(() => {
          const group = item().group
          return group.type === "part" ? getMessagePart(group.ref.messageID, group.ref.partID) : undefined
        })
        const contextParts = createMemo(() => {
          const group = item().group
          if (group.type !== "context") return [] as Array<{ part: ToolPart; message: AssistantMessage }>
          return group.refs.flatMap((ref) => {
            const message = messageByID().get(ref.messageID)
            const part = getMessagePart(ref.messageID, ref.partID)
            return message?.role === "assistant" && part?.type === "tool" ? [{ message, part }] : []
          })
        })
        return (
          <TimelineRowFrame row={item}>
            <div
              class="w-full px-4 md:px-5"
              data-slot="session-turn-assistant-content"
              aria-hidden={workingTurn(item().userMessageID)}
            >
              <Show
                when={item().group.type === "context"}
                fallback={
                  <Show when={message()}>
                    {(message) => (
                      <Show when={part()}>
                        {(part) => (
                          <DeferredMessagePart
                            sessionID={sessionID() ?? item().userMessageID}
                            part={part()}
                            message={message()}
                            defaultOpen={defaultOpen(part())}
                            onBackgroundShell={props.onBackgroundShell}
                            onBackgroundTask={props.onBackgroundTask}
                            showAssistantCopyPartID={assistantCopy().partID}
                            assistantCopyText={assistantCopy().text}
                            turnDurationMs={turnDurationMs(item().userMessageID)}
                            markdownViewport={listRoot()}
                            markdownHighlight="defer"
                            markdownMath="full"
                          />
                        )}
                      </Show>
                    )}
                  </Show>
                }
              >
                <For each={contextParts()}>
                  {(entry) => (
                    <DeferredMessagePart
                      sessionID={sessionID() ?? item().userMessageID}
                      part={entry.part}
                      message={entry.message}
                      defaultOpen={defaultOpen(entry.part)}
                      onBackgroundShell={props.onBackgroundShell}
                      onBackgroundTask={props.onBackgroundTask}
                      markdownViewport={listRoot()}
                      markdownHighlight="defer"
                      markdownMath="full"
                    />
                  )}
                </For>
              </Show>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const item = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={item}>
            <div class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                phase={item().phase}
                reasoningHeading={item().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const item = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={item}>
            <div class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === item().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary":
        return (
          <TimelineRowFrame row={row as Accessor<TimelineRowByTag<"DiffSummary">>}>
            <div class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow diffs={(row() as TimelineRowByTag<"DiffSummary">).diffs} />
            </div>
          </TimelineRowFrame>
        )
      case "Error": {
        const item = row as Accessor<TimelineRowByTag<"Error">>
        return (
          <TimelineRowFrame row={item}>
            <div class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card">
                {item().text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }
  function VirtualTimelineRow(input: { rowKey: string }) {
    const liveItem = createMemo(() => virtualItemByKey().get(input.rowKey))
    if (!untrack(() => liveItem())) {
      console.warn(
        `[timeline] VirtualTimelineRow missing item key=${input.rowKey} session=${sessionID() ?? "none"} snapshot=${String(virtualSnapshot().keys.length)}`,
      )
    }
    return <Show when={liveItem()}>{(item) => <MountedVirtualTimelineRow rowKey={input.rowKey} item={item} />}</Show>
  }
  function MountedVirtualTimelineRow(input: { rowKey: string; item: Accessor<VirtualItem> }) {
    let element: HTMLDivElement | undefined
    let markdownObserver: MutationObserver | undefined
    const initialItem = input.item()
    const initialRow = timelineRowByKey().get(input.rowKey)
    const [contentHeight, setContentHeight] = createSignal(initialItem.size)
    const item = createMemo(() => virtualItemByKey().get(input.rowKey) ?? input.item(), initialItem, {
      equals: sameVirtualItemGeometry,
    })
    const row = createMemo(() => timelineRowByKey().get(input.rowKey) ?? initialRow)
    // Streaming rows (active group + last row) must stay fully rendered:
    // content-visibility would freeze their growing height (risk #1). All
    // other rows skip subtree layout/paint while outside the browser's
    // relevance buffer.
    const rowVisibility = createMemo(() =>
      timelineRowContentVisibility({
        index: item().index,
        activeIndex: activeAssistantRowIndex(),
        lastIndex: timelineRows().length - 1,
      }),
    )
    // Visibility and streaming state are separate concerns. The last row stays
    // visible so completed Markdown can paint immediately, but that must not
    // make a completed text row use the live-growth-only shrink guard.
    const liveMeasured = () => {
      const currentRow = row()
      if (!currentRow || currentRow._tag !== "AssistantPart") return false
      const group = currentRow.group
      if (group.type !== "part" || !group.ref) return false
      return timelinePartIsLive(getMessagePart(group.ref.messageID, group.ref.partID))
    }
    // Completed assistant text parts mount their markdown asynchronously
    // (non-streaming Markdown starts with empty HTML until the parse lands),
    // so the row's first ResizeObserver reports are the empty-box transient
    // (~36px), not the real content height. Adopting that shrink poisons the
    // row cache and collapses contain-intrinsic-size into a state
    // content-visibility never recovers from by itself (observed: row stuck at
    // 36px with 1451px of rendered DOM, un-skipping only when scrolled back
    // into view — then jumping). Until the markdown has actually rendered
    // content (`data-markdown-rendered-stage` present), shrinks are refused.
    const markdownPending = () => {
      const currentRow = row()
      if (!currentRow || currentRow._tag !== "AssistantPart") return false
      const group = currentRow.group
      if (!group || group.type !== "part" || !group.ref) return false
      const part = getMessagePart(group.ref.messageID, group.ref.partID)
      // Streaming text/reasoning renders with `instant` markdown (no empty
      // window), and live rows are already covered by the live-shrink guard.
      // Completed reasoning uses the same deferred Markdown renderer as text;
      // before hydration it also reports only its 52px chrome, so it needs the
      // same rendered-stage guard or that transient height poisons the cache.
      return markdownMeasurementPending(part, {
        rendered: !!element?.querySelector("[data-markdown-rendered-stage]"),
        detailsMounted:
          part?.type !== "reasoning" || !!element?.querySelector('[data-component="reasoning-part"][data-mode="full"]'),
      })
    }
    // Height commits arrive through the virtualizer's single ResizeObserver
    // (see the measureElement option): the observer's border-box entry needs
    // no layout read, and this handler applies the live-shrink guard, keeps
    // the overflow signal fresh, persists into the row cache (C2), and
    // schedules the post-batch anchor/bottom pass. The returned number is the
    // size the virtualizer should adopt.
    const handleRowHeight = (raw: number) => {
      const virtual = item().size
      const live = liveMeasured()
      const pending = markdownPending()
      const measured = virtualizer.itemSizeCache.has(item().key)
      const root = listRoot()
      if (lagging() && Math.abs(raw - virtual) >= 1_000) {
        const markdown = element?.querySelector<HTMLElement>('[data-component="markdown"]')
        timelineLag(
          "measure-large-probe",
          `index=${item().index} key=${input.rowKey} previous=${Math.round(virtual)} next=${Math.round(raw)} visibility=${rowVisibility()} markdownPending=${String(pending)} elementOffset=${Math.round(element?.offsetHeight ?? 0)} elementRect=${Math.round(element?.getBoundingClientRect().height ?? 0)} markdownOffset=${Math.round(markdown?.offsetHeight ?? 0)} markdownScroll=${Math.round(markdown?.scrollHeight ?? 0)} markdownRect=${Math.round(markdown?.getBoundingClientRect().height ?? 0)} markdownText=${String(markdown?.textContent?.length ?? 0)} markdownHtml=${String(markdown?.innerHTML.length ?? 0)} stage=${markdown?.dataset.markdownStage ?? "none"}/${markdown?.dataset.markdownRenderedStage ?? "none"} top=${Math.round(root?.scrollTop ?? 0)}`,
        )
      }
      // Reject transient/live shrink measurements before considering the
      // near-bottom clamp queue. A deferred value is eventually committed
      // directly by handleScroll, so enqueuing an invalid empty-Markdown size
      // here would bypass this guard on the later pass.
      if (!shouldCommitVirtualRowHeight({ next: raw, previous: virtual, live, measured, markdownPending: pending })) {
        setContentHeight(pending ? raw : Math.max(raw, contentHeight()))
        if (lagging()) {
          timelineLag(
            "measure-rejected",
            `index=${item().index} key=${input.rowKey} previous=${Math.round(virtual)} next=${Math.round(raw)} live=${String(live)} measured=${String(measured)} markdownPending=${String(pending)} visibility=${rowVisibility()} top=${Math.round(root?.scrollTop ?? 0)}`,
          )
        }
        if (lagging()) {
          console.debug(
            `[timeline] row-measure:skip-shrink key=${input.rowKey} index=${String(item().index)} height=${String(Math.round(raw))} virtual=${String(Math.round(virtual))} delta=${String(Math.round(raw - virtual))} live=${String(live)} pending=${String(pending)}`,
          )
        }
        return virtual
      }
      // A fresh valid observation supersedes either deferred queue. Without
      // this, reopening a row after a deferred collapse can leave the old
      // shrink armed and apply it later when the user scrolls.
      deferredFastMeasurements.delete(item().index)
      pendingNearBottomShrinks.delete(item().index)
      if (shouldDeferFastRowMeasurement({ fast: fastScrolling(), live, next: raw, previous: virtual })) {
        deferredFastMeasurements.set(item().index, { key: input.rowKey, size: raw })
        setContentHeight(Math.min(raw, virtual))
        scheduleDeferredFastMeasurementFlush()
        return virtual
      }
      const totalSize = virtualizer.getTotalSize()
      const wouldClampScroll =
        !!root &&
        !props.shouldAnchorBottom() &&
        props.hasScrollGesture() &&
        raw < virtual &&
        root.scrollTop > totalSize - listSize().height + raw - virtual + 1
      if (wouldClampScroll) {
        pendingNearBottomShrinks.set(item().index, { key: input.rowKey, size: raw })
        setContentHeight(raw)
        if (lagging()) {
          timelineLag(
            "defer-shrink",
            `index=${item().index} key=${input.rowKey} previous=${Math.round(virtual)} next=${Math.round(raw)} top=${Math.round(root.scrollTop)} newMax=${Math.round(totalSize - root.clientHeight + raw - virtual)}`,
          )
        }
        return virtual
      }
      setContentHeight(raw)
      // The post-batch pass must run after TanStack has consumed this return
      // value and completed resizeItem. Running it here would compensate the
      // same height delta once, then TanStack would compensate it again.
      measurementBatchPending = true
      // TanStack's ResizeObserver closes over its original resizeItem function,
      // so the wrapper below is not a reliable scheduling hook for observed
      // entries. Queue from the measurement handler itself; the microtask runs
      // after TanStack consumes this returned size, and queueMeasurementPass
      // coalesces every entry in the same observer batch.
      queueMeasurementPass()
      cacheCommittedRowHeight(input.rowKey, raw)
      const delta = raw - virtual
      if (lagging() && Math.abs(delta) > 1) {
        console.debug(
          `[timeline] row-measure key=${input.rowKey} index=${String(item().index)} height=${String(Math.round(raw))} virtual=${String(Math.round(virtual))} delta=${String(Math.round(delta))} live=${String(live)} pending=${String(pending)}`,
        )
      }
      return raw
    }

    onMount(() => {
      if (!element) return
      const mountedElement = element
      elementRowKey.set(mountedElement, input.rowKey)
      rowHeightHandlers.set(input.rowKey, handleRowHeight)
      // Registers the element with the virtualizer's shared ResizeObserver.
      // The synchronous path returns the current virtual size (zero layout
      // reads); the observer's initial entry commits the real height in the
      // same frame, before paint.
      virtualizer.measureElement(mountedElement)
      if (lagging()) {
        markdownObserver = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target
            if (!(target instanceof HTMLElement)) continue
            timelineLag(
              "markdown-stage",
              `index=${item().index} key=${input.rowKey} attr=${record.attributeName ?? "none"} old=${record.oldValue ?? "none"} stage=${target.dataset.markdownStage ?? "none"} rendered=${target.dataset.markdownRenderedStage ?? "none"} rowSize=${Math.round(item().size)} contentHeight=${Math.round(contentHeight())} scrollTop=${Math.round(listRoot()?.scrollTop ?? 0)} visibility=${getComputedStyle(mountedElement).contentVisibility}`,
            )
          }
        })
        markdownObserver.observe(mountedElement, {
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ["data-markdown-stage", "data-markdown-rendered-stage"],
        })
      }
    })
    onCleanup(() => {
      rowHeightHandlers.delete(input.rowKey)
      if (element) elementRowKey.delete(element)
      markdownObserver?.disconnect()
    })
    return (
      <div
        data-timeline-key={input.rowKey}
        style={{
          position: "absolute",
          top: `${item().start}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          // Do not hide newly rendered streaming content while the virtualizer
          // catches up with its ResizeObserver measurement.
          // Only streaming output may paint beyond its current virtual size.
          // Completed tool hydration can grow before ResizeObserver commits;
          // letting it overflow overlaps the following virtual row.
          overflow: virtualRowOverflow(contentHeight(), item().size, item().index === activeAssistantRowIndex()),
        }}
      >
        <div
          ref={(value) => (element = value)}
          data-index={item().index}
          style={{
            // Applied to the measured element (not the sized outer box): the
            // outer row keeps its explicit virtual height regardless, while a
            // skipped measured element reports the intrinsic size below to the
            // virtualizer's ResizeObserver — no height churn while offscreen.
            "content-visibility": rowVisibility(),
            // Intrinsic = current virtual size (row cache or estimator), never
            // a fixed 60px; the `auto` keyword remembers the last real height
            // once the row has rendered.
            "contain-intrinsic-size": `auto ${item().size}px`,
          }}
        >
          <Show when={row()} fallback={null}>
            {(value) => renderTimelineRow(value)}
          </Show>
        </div>
      </div>
    )
  }
  return (
    <div class="relative w-full h-full min-w-0">
      <Show when={props.scroll.overflow && !props.scroll.bottom}>
        <button class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60]" onClick={props.onResumeScroll}>
          {language.t("session.messages.jumpToBottom")}
        </button>
      </Show>
      <ScrollView
        viewportRef={bindListRoot}
        scrollContentHeight={virtualizer.getTotalSize()}
        scrollViewportHeight={listSize().height}
        onWheel={(event) => {
          // Real user input immediately revokes the programmatic-scroll marker.
          programmaticScrollAt = 0
          markToolHydrationScrollActivity()
          const delta = normalizeWheelDelta({
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            rootHeight: listSize().height,
          })
          if (lagging()) {
            timelineLag(
              "wheel-input",
              `trusted=${String(event.isTrusted)} delta=${Math.round(delta)} top=${Math.round(event.currentTarget.scrollTop)} height=${Math.round(event.currentTarget.scrollHeight)} client=${Math.round(event.currentTarget.clientHeight)}`,
            )
          }
          if (delta) markBoundaryGesture(event.currentTarget, event.target, delta)
        }}
        onTouchStart={(event) => {
          programmaticScrollAt = 0
          touchGesture = event.touches[0]?.clientY
          if (!prependLoading) clearPrependAnchor()
        }}
        onTouchMove={(event) => {
          const next = event.touches[0]?.clientY
          if (touchGesture === undefined || next === undefined) return
          markToolHydrationScrollActivity()
          markBoundaryGesture(event.currentTarget, event.target, touchGesture - next)
          touchGesture = next
        }}
        onTouchEnd={() => (touchGesture = undefined)}
        onTouchCancel={() => (touchGesture = undefined)}
        onPointerDown={(event) =>
          event.target === event.currentTarget && props.onMarkScrollGesture(event.currentTarget)
        }
        onScrollInput={(root) => {
          programmaticScrollAt = 0
          props.onMarkScrollGesture(root)
        }}
        onScrollGeometry={handleScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
      >
        <div
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
          }}
          data-timeline-virtual-content
          style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
        >
          <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
          <Show when={timelineRows().length > 0}>
            <div
              aria-hidden="true"
              class="h-16 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
      <Show when={sessionFind.open()}>
        <FileSearchBar
          pos={sessionFind.pos}
          query={sessionFind.query}
          index={sessionFind.index}
          count={sessionFind.count}
          setInput={sessionFind.setInput}
          onInput={(value: string) => sessionFind.setQuery(value)}
          onKeyDown={sessionFind.onInputKeyDown}
          onClose={sessionFind.close}
          onPrev={() => sessionFind.next(-1)}
          onNext={() => sessionFind.next(1)}
        />
      </Show>
    </div>
  )
}
