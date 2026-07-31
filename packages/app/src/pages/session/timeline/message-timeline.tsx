import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
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
  Part as MessagePart,
  type UserActions,
} from "@opencode-ai/ui/message-part"
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
  createCoalescedConnectedMeasure,
  partMeasurementKey,
  shouldAdjustVirtualScroll,
  timelineContentVersion,
  timelineMeasurementsMatchWidth,
  virtualRowOverflow,
} from "./measure"
import { createTimelineProjection } from "./projection"
import { MessageComment, type SummaryDiff, TimelineRow, TimelineRowMap } from "./rows"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }
const timelineFallbackItemSize = 60
// Snapshot sizes depend on the rendered row structure and Markdown strategy.
const timelineMeasurementVersion = 2

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

type TimelineCacheEntry = {
  version: number
  measurements: VirtualItem[]
  width?: number
  contentVersion: string
}

const timelineCache = new Map<string, TimelineCacheEntry>()

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root || !(nested instanceof HTMLElement)) return root
  return nested
}

function TimelineThinkingRow(props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  const language = useLanguage()
  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <Show when={!props.showReasoningSummaries}>
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
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
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
  const cached = timelineCache.get(ownerSessionKey)
  const cachedContentVersion = timelineContentVersion(
    params.id ? (sync.data.message[params.id] ?? emptyMessages) : emptyMessages,
    sync.data.part,
  )
  const initialMeasurements =
    cached?.version === timelineMeasurementVersion && cached.contentVersion === cachedContentVersion
      ? cached.measurements
      : undefined
  if (cached && !initialMeasurements) {
    console.warn("[timeline] discarded stale measurement cache", {
      session: params.id,
      cacheVersion: cached.version,
      cacheContentLength: cached.contentVersion.length,
      currentContentLength: cachedContentVersion.length,
    })
  }
  const coldBottomMount = !initialMeasurements?.length && props.shouldAnchorBottom()
  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length || coldBottomMount ? 6 : 20)

  const sessionID = createMemo(() => params.id)
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    return id ? (sync.data.session_status[id] ?? idle) : idle
  })
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    return id ? (sync.data.message[id] ?? emptyMessages) : emptyMessages
  })
  const getMessageParts = (messageID: string) => sync.data.part[messageID] ?? emptyParts
  const getMessagePart = (messageID: string, partID: string) =>
    getMessageParts(messageID).find((part) => part.id === partID)
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
  const lastAssistantGroupKey = projection.lastAssistantGroupKey

  let prependAnchor: { key: string; offset: number } | undefined
  let prependLoading = false
  let prependAnchorFrame: number | undefined
  const clearPrependAnchor = () => {
    prependAnchor = undefined
    prependLoading = false
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    const key = anchor?.element.dataset.timelineKey
    if (anchor && key) prependAnchor = { key, offset: anchor.rect.top - view.top }
  }
  const restorePrependAnchor = (done: boolean) => {
    if (done) prependLoading = false
    const root = listRoot()
    const saved = prependAnchor
    if (!root || !saved) return
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const restore = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) return
      const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
      const delta = element ? element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset : 0
      if (Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 8 || frames >= 180) {
        if (!prependLoading) prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(restore)
    }
    prependAnchorFrame = requestAnimationFrame(restore)
  }

  let virtualContent: HTMLDivElement | undefined
  let resizePinFrame: number | undefined
  let resizePinnedIndexes: number[] = []
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
    scrollToFn: (offset, options, instance) => {
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
      const activeID = activeMessageID()
      const activeRows = activeID
        ? timelineRows().flatMap((row, index) =>
            row._tag === "AssistantPart" && row.userMessageID === activeID ? [index] : [],
          )
        : []
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return [...new Set([...resizePinnedIndexes, ...indexes, ...activeRows])].sort((a, b) => a - b)
    },
  })
  const resizeItem = virtualizer.resizeItem
  virtualizer.resizeItem = (index, size) => {
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight) {
      const view = root.getBoundingClientRect()
      resizePinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > view.top && rect.top < view.bottom
        })
        .map((element) => Number(element.dataset.index))
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustVirtualScroll({
      itemEnd: item.end,
      scrollOffset: instance.getLogicalScrollOffset(),
      bottomAnchored: props.shouldAnchorBottom(),
      initializing: props.isInitialScrollSettling(),
    })
  const virtualItemByKey = createMemo(
    () =>
      new Map(
        virtualizer
          .getVirtualItems()
          .filter((item): item is NonNullable<typeof item> => item !== undefined)
          .map((item) => [item.key, item] as const),
      ),
  )
  const virtualRowKeys = createMemo(() =>
    virtualizer
      .getVirtualItems()
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .map((item) => item.key as string),
  )

  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index !== undefined) virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  onMount(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const previousOverscan = renderOverscan()
        if (previousOverscan < 20) setRenderOverscan(20)
      })
    })
  })
  onCleanup(() => {
    clearPrependAnchor()
    timelineCache.set(ownerSessionKey, {
      version: timelineMeasurementVersion,
      measurements: virtualizer.takeSnapshot(),
      width: listRoot()?.clientWidth,
      contentVersion: timelineContentVersion(sessionMessages(), sync.data.part),
    })
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
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

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
    if (initialMeasurements && !timelineMeasurementsMatchWidth(cached?.width, root.clientWidth)) virtualizer.measure()
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
  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const root = event.currentTarget
    props.onScheduleScrollState(root)
    if (!props.hasScrollGesture()) {
      props.onHistoryScroll()
      return
    }
    clearPrependAnchor()
    props.onAutoScrollHandleScroll()
    props.onUserScroll()
    props.onMarkScrollGesture(root)
    props.onHistoryScroll()
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID
  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages
    for (const message of messages.toReversed()) {
      for (const part of getMessageParts(message.id).toReversed()) {
        if (part.type === "text" && part.text?.trim()) return part.id
      }
    }
  }
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
  const defaultOpen = (part: PartType) => {
    if (part.type !== "tool") return
    const tool = normalizeTool(part.tool)
    if (tool === "bash") return settings.general.shellToolPartsExpanded()
    if (["edit", "write", "apply_patch"].includes(tool)) return settings.general.editToolPartsExpanded()
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const row = input.row
    const anchor = () => {
      const value = row()
      return value._tag === "CommentStrip" || (value._tag === "UserMessage" && value.anchor)
    }
    const previousAssistantPart = () => {
      const value = row()
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
                    actions={props.actions}
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
                          <MessagePart
                            part={part()}
                            message={message()}
                            defaultOpen={defaultOpen(part())}
                            showAssistantCopyPartID={assistantCopyPartID(item().userMessageID)}
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
                    <MessagePart
                      part={entry.part}
                      message={entry.message}
                      defaultOpen={defaultOpen(entry.part)}
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
    let element: HTMLDivElement | undefined
    let resizeObserver: ResizeObserver | undefined
    const [contentHeight, setContentHeight] = createSignal(0)
    const initialItem = virtualItemByKey().get(input.rowKey)!
    const initialRow = timelineRowByKey().get(input.rowKey)!
    const item = createMemo(() => virtualItemByKey().get(input.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(input.rowKey) ?? initialRow)
    const partMeasurements = createMemo(() => {
      const value = row()
      if (value._tag !== "AssistantPart") return ""
      if (value.group.type === "part")
        return partMeasurementKey(getMessagePart(value.group.ref.messageID, value.group.ref.partID))
      return value.group.refs.map((ref) => partMeasurementKey(getMessagePart(ref.messageID, ref.partID))).join("|")
    })
    const measurement = createCoalescedConnectedMeasure({
      element: () => element,
      measure: (target) => target.getBoundingClientRect().height,
      commit: (_target, height) => {
        // TanStack skips measureElement updates during a user scroll. Dynamic
        // Markdown and tool content must still claim their new row height, or
        // the absolutely positioned following row clips it until scrolling ends.
        setContentHeight(height)
        virtualizer.resizeItem(item().index, height)
      },
    })
    const requestMeasure = () => {
      if (element?.isConnected) setContentHeight(element.getBoundingClientRect().height)
      measurement.request()
    }

    onMount(() => {
      if (!element) return
      virtualizer.measureElement(element)
      const height = element.getBoundingClientRect().height
      setContentHeight(height)
      measurement.remember(height)
      resizeObserver = new ResizeObserver(requestMeasure)
      resizeObserver.observe(element)
    })
    createEffect(
      on(
        () => item().index,
        () => {
          if (!element) return
          virtualizer.measureElement(element)
          const height = element.getBoundingClientRect().height
          setContentHeight(height)
          measurement.remember(height)
        },
        { defer: true },
      ),
    )
    createEffect(() => {
      row()
      partMeasurements()
      requestMeasure()
    })
    onCleanup(() => {
      measurement.cancel()
      resizeObserver?.disconnect()
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
          overflow: virtualRowOverflow(contentHeight(), item().size),
        }}
      >
        <div ref={(value) => (element = value)} data-index={item().index}>
          {renderTimelineRow(row)}
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
        onWheel={(event) => {
          const delta = normalizeWheelDelta({
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            rootHeight: event.currentTarget.clientHeight,
          })
          if (delta) markBoundaryGesture(event.currentTarget, event.target, delta)
        }}
        onTouchStart={(event) => {
          touchGesture = event.touches[0]?.clientY
          clearPrependAnchor()
        }}
        onTouchMove={(event) => {
          const next = event.touches[0]?.clientY
          if (touchGesture === undefined || next === undefined) return
          markBoundaryGesture(event.currentTarget, event.target, touchGesture - next)
          touchGesture = next
        }}
        onTouchEnd={() => (touchGesture = undefined)}
        onTouchCancel={() => (touchGesture = undefined)}
        onPointerDown={(event) =>
          event.target === event.currentTarget && props.onMarkScrollGesture(event.currentTarget)
        }
        onScroll={handleScroll}
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
    </div>
  )
}
