import { Accordion } from "./accordion"
import { Button } from "./button"
import { DropdownMenu } from "./dropdown-menu"
import { RadioGroup } from "./radio-group"
import { DiffChanges } from "./diff-changes"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Tooltip } from "./tooltip"
import { ScrollView } from "./scroll-view"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { type FileContent, type SnapshotFileDiff } from "@opencode-ai/sdk/v2"

// Fork extends SnapshotFileDiff with before/after rendered content (populated server-side)
type FileDiff = SnapshotFileDiff & { before?: string; after?: string }
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { type SelectedLineRange } from "@pierre/diffs"
import { Dynamic } from "solid-js/web"
import { mediaKindFromPath } from "../pierre/media"
import { cloneSelectedLineRange, previewSelectedLines } from "../pierre/selection-bridge"
import { createLineCommentController } from "./line-comment-annotations"
import { diffContents } from "./session-diff"

const MAX_DIFF_CHANGED_LINES = 500

// Windowed rendering of the review list (specs/performance/
// right-side-panels-optimization.md §7.2): with thousands of changed files,
// mounting every (collapsed) header keeps the full DOM in the layout/layerize
// path and scrolling drops to ~30ms/frame. Only a viewport+overscan window of
// items is mounted; consistent collapsed-header heights make the offset model
// O(log n) per scroll frame, and measured heights of expanded items are fed
// back so positions stay exact.
const ESTIMATED_ITEM_HEIGHT = 31
const WINDOW_OVERSCAN = 10
const MIN_WINDOW = 40

export type SessionReviewDiffStyle = "unified" | "split"

export type SessionReviewComment = {
  id: string
  file: string
  selection: SelectedLineRange
  comment: string
}

export type SessionReviewLineComment = {
  file: string
  selection: SelectedLineRange
  comment: string
  preview?: string
}

export type SessionReviewCommentUpdate = SessionReviewLineComment & {
  id: string
}

export type SessionReviewCommentDelete = {
  id: string
  file: string
}

export type SessionReviewCommentActions = {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  saveLabel: string
}

export type SessionReviewFocus = { file: string; id: string }

type ReviewDiff = FileDiff & { preloaded?: PreloadMultiFileDiffResult<any> }

export interface SessionReviewProps {
  title?: JSX.Element
  empty?: JSX.Element
  split?: boolean
  diffStyle?: SessionReviewDiffStyle
  onDiffStyleChange?: (diffStyle: SessionReviewDiffStyle) => void
  onDiffRendered?: () => void
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
  focusedFile?: string
  open?: string[]
  onOpenChange?: (open: string[]) => void
  scrollRef?: (el: HTMLDivElement) => void
  onScroll?: JSX.EventHandlerUnion<HTMLDivElement, Event>
  class?: string
  classList?: Record<string, boolean | undefined>
  classes?: { root?: string; header?: string; container?: string }
  actions?: JSX.Element
  diffs: ReviewDiff[]
  onViewFile?: (file: string) => void
  readFile?: (path: string) => Promise<FileContent | undefined>
}

function ReviewCommentMenu(props: {
  labels: SessionReviewCommentActions
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.labels.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.labels.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.labels.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

function diffId(file: string): string | undefined {
  const sum = checksum(file)
  if (!sum) return
  return `session-review-diff-${sum}`
}

type SessionReviewSelection = {
  file: string
  range: SelectedLineRange
}

const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"

const selectionPreview = (contents: { before: string; after: string }, range: SelectedLineRange) => {
  const side = selectionSide(range)
  const value = side === "deletions" ? contents.before : contents.after
  if (value.length === 0) return undefined

  return previewSelectedLines(value, range)
}

const EMPTY_COMMENTS: SessionReviewComment[] = []

/**
 * Heavy per-file review body. Mounted only while the item is expanded, so a
 * collapsed list of diffs creates zero content memos, zero patch parses and
 * zero comment controllers (specs/performance/right-side-panels-optimization.md
 * §4.4). Header badges come from the recorded status only and never parse the
 * patch text.
 */
function ReviewDiffBody(props: {
  diff: ReviewDiff
  file: string
  diffStyle: SessionReviewDiffStyle
  comments: SessionReviewComment[]
  selection: SessionReviewSelection | null
  commenting: SessionReviewSelection | null
  opened: SessionReviewFocus | null
  setSelection: (selection: SessionReviewSelection | null) => void
  setCommenting: (commenting: SessionReviewSelection | null) => void
  setOpened: (focus: SessionReviewFocus | null) => void
  force: boolean
  onForce: () => void
  onDiffRendered?: () => void
  onLineComment?: SessionReviewProps["onLineComment"]
  onLineCommentUpdate?: SessionReviewProps["onLineCommentUpdate"]
  onLineCommentDelete?: SessionReviewProps["onLineCommentDelete"]
  lineCommentActions?: SessionReviewCommentActions
  readFile?: SessionReviewProps["readFile"]
}) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const contents = createMemo(() => diffContents(props.diff))
  const commentedLines = () => props.comments.map((c) => c.selection)
  const selectedLines = () => (props.selection && props.selection.file === props.file ? props.selection.range : null)
  const draftRange = () => (props.commenting && props.commenting.file === props.file ? props.commenting.range : null)
  const changedLines = () => props.diff.additions + props.diff.deletions
  const mediaKind = createMemo(() => mediaKindFromPath(props.file))

  const tooLarge = createMemo(() => {
    if (props.force) return false
    if (mediaKind()) return false
    return changedLines() > MAX_DIFF_CHANGED_LINES
  })

  const commentsUi = createLineCommentController<SessionReviewComment>({
    comments: () => props.comments,
    label: i18n.t("ui.lineComment.submit"),
    draftKey: () => props.file,
    state: {
      opened: () => {
        const current = props.opened
        if (!current || current.file !== props.file) return null
        return current.id
      },
      setOpened: (id) => props.setOpened(id ? { file: props.file, id } : null),
      selected: selectedLines,
      setSelected: (range) => props.setSelection(range ? { file: props.file, range } : null),
      commenting: draftRange,
      setCommenting: (range) => props.setCommenting(range ? { file: props.file, range } : null),
    },
    getSide: selectionSide,
    clearSelectionOnSelectionEndNull: false,
    onSubmit: ({ comment, selection }) => {
      props.onLineComment?.({
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(contents(), selection),
      })
    },
    onUpdate: ({ id, comment, selection }) => {
      props.onLineCommentUpdate?.({
        id,
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(contents(), selection),
      })
    },
    onDelete: (comment) => {
      props.onLineCommentDelete?.({
        id: comment.id,
        file: props.file,
      })
    },
    editSubmitLabel: props.lineCommentActions?.saveLabel,
    renderCommentActions: props.lineCommentActions
      ? (comment, controls) => (
          <ReviewCommentMenu
            labels={props.lineCommentActions!}
            onEdit={controls.edit}
            onDelete={controls.remove}
          />
        )
      : undefined,
  })

  const handleLineSelected = (range: SelectedLineRange | null) => {
    if (!props.onLineComment) return
    commentsUi.onLineSelected(range)
  }

  const handleLineSelectionEnd = (range: SelectedLineRange | null) => {
    if (!props.onLineComment) return
    commentsUi.onLineSelectionEnd(range)
  }

  return (
    <Switch>
      <Match when={tooLarge()}>
        <div data-slot="session-review-large-diff">
          <div data-slot="session-review-large-diff-title">{i18n.t("ui.sessionReview.largeDiff.title")}</div>
          <div data-slot="session-review-large-diff-meta">
            {i18n.t("ui.sessionReview.largeDiff.meta", {
              limit: MAX_DIFF_CHANGED_LINES.toLocaleString(),
              current: changedLines().toLocaleString(),
            })}
          </div>
          <div data-slot="session-review-large-diff-actions">
            <Button size="normal" variant="secondary" onClick={() => props.onForce()}>
              {i18n.t("ui.sessionReview.largeDiff.renderAnyway")}
            </Button>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <Dynamic
          component={fileComponent}
          mode="diff"
          preloadedDiff={props.diff.preloaded}
          diffStyle={props.diffStyle}
          onRendered={() => {
            props.onDiffRendered?.()
          }}
          enableLineSelection={props.onLineComment != null}
          enableHoverUtility={props.onLineComment != null}
          onLineSelected={handleLineSelected}
          onLineSelectionEnd={handleLineSelectionEnd}
          onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
          annotations={commentsUi.annotations()}
          renderAnnotation={commentsUi.renderAnnotation}
          renderHoverUtility={props.onLineComment ? commentsUi.renderHoverUtility : undefined}
          selectedLines={selectedLines()}
          commentedLines={commentedLines()}
          before={{
            name: props.file,
            contents: contents().before,
          }}
          after={{
            name: props.file,
            contents: contents().after,
          }}
          media={{
            mode: "auto",
            path: props.file,
            before: props.diff.before,
            after: props.diff.after,
            readFile: props.readFile,
          }}
        />
      </Match>
    </Switch>
  )
}

export const SessionReview = (props: SessionReviewProps) => {
  let scroll: HTMLDivElement | undefined
  let focusToken = 0
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const anchors = new Map<string, HTMLElement>()
  const [store, setStore] = createStore({
    open: [] as string[],
    force: {} as Record<string, boolean>,
    selection: null as SessionReviewSelection | null,
    commenting: null as SessionReviewSelection | null,
    opened: null as SessionReviewFocus | null,
  })
  const selection = () => store.selection
  const commenting = () => store.commenting
  const opened = () => store.opened

  const open = () => props.open ?? store.open
  const files = createMemo(() => props.diffs.map((diff) => diff.file ?? ""))
  const diffStyle = () => props.diffStyle ?? (props.split ? "split" : "unified")
  const hasDiffs = () => files().length > 0
  // O(1) expansion membership and a per-file comment index: list items must
  // not scan the whole open array or filter all comments per file.
  const openSet = createMemo(() => new Set(open()))
  const commentsByFile = createMemo(() => {
    const map = new Map<string, SessionReviewComment[]>()
    for (const comment of props.comments ?? []) {
      const existing = map.get(comment.file)
      if (existing) existing.push(comment)
      else map.set(comment.file, [comment])
    }
    return map
  })

  // --- windowed rendering model -------------------------------------------
  // Measured item heights (file -> px). Kept outside reactivity; `heightsVersion`
  // batches re-computation of the offset table.
  const measured = new Map<string, number>()
  const [heightsVersion, setHeightsVersion] = createSignal(0)
  let heightsFlushScheduled = false
  const noteHeight = (file: string, height: number) => {
    if (!file) return
    if (measured.get(file) === height) return
    measured.set(file, height)
    if (heightsFlushScheduled) return
    heightsFlushScheduled = true
    requestAnimationFrame(() => {
      heightsFlushScheduled = false
      setHeightsVersion((v) => v + 1)
    })
  }

  const offsets = createMemo(() => {
    heightsVersion()
    const list = props.diffs
    const out = new Float64Array(list.length + 1)
    for (let i = 0; i < list.length; i++) {
      out[i + 1] = out[i] + (measured.get(list[i].file ?? "") ?? ESTIMATED_ITEM_HEIGHT)
    }
    return out
  })

  // Prune measurements for files that left the list (session switch / refresh).
  createEffect(() => {
    const list = props.diffs
    if (measured.size === 0) return
    const live = new Set(list.map((d) => d.file ?? ""))
    for (const key of measured.keys()) {
      if (!live.has(key)) measured.delete(key)
    }
    setHeightsVersion((v) => v + 1)
  })

  const [win, setWin] = createSignal({ start: 0, end: MIN_WINDOW })

  const recomputeWindow = (scrollTop: number, viewportHeight: number) => {
    const off = offsets()
    const count = props.diffs.length
    if (count === 0) {
      setWin((w) => (w.start === 0 && w.end === 0 ? w : { start: 0, end: 0 }))
      return
    }
    // First item whose bottom edge is below the viewport top.
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (off[mid + 1]! < scrollTop) lo = mid + 1
      else hi = mid
    }
    const start = Math.max(0, lo - WINDOW_OVERSCAN)
    let end = lo
    const bottom = scrollTop + Math.max(viewportHeight, 600)
    while (end < count && off[end + 1]! <= bottom) end++
    end = Math.min(count, Math.max(end + WINDOW_OVERSCAN, start + MIN_WINDOW))
    setWin((w) => (w.start === start && w.end === end ? w : { start, end }))
  }

  let viewport: HTMLDivElement | undefined
  let viewportHeight = 0
  let windowFrame: number | undefined
  const queueWindowUpdate = () => {
    if (windowFrame !== undefined) return
    windowFrame = requestAnimationFrame(() => {
      windowFrame = undefined
      if (!viewport) return
      viewportHeight = viewport.clientHeight
      recomputeWindow(viewport.scrollTop, viewportHeight)
    })
  }

  const fileIndex = (file: string) => props.diffs.findIndex((d) => (d.file ?? "") === file)

  /** Move the window so `file` is mounted; returns whether it is now covered. */
  const ensureInWindow = (file: string) => {
    const index = fileIndex(file)
    if (index < 0) return false
    const current = win()
    if (index >= current.start && index < current.end) return true
    const start = Math.max(0, Math.min(index - WINDOW_OVERSCAN, Math.max(0, props.diffs.length - MIN_WINDOW)))
    const end = Math.min(props.diffs.length, start + MIN_WINDOW)
    setWin({ start, end })
    return true
  }

  // Keep locate targets mounted: focusedFile (from the changes tree) and the
  // file of a focused comment both drive the window before the DOM retry
  // loops in the app layer go looking for their anchors.
  createEffect(() => {
    const file = props.focusedFile
    if (file) untrack(() => ensureInWindow(file))
  })
  createEffect(() => {
    const focus = props.focusedComment
    if (focus?.file) untrack(() => ensureInWindow(focus.file))
  })

  let resizeObserver: ResizeObserver | undefined
  onMount(() => {
    if (!viewport) return
    viewportHeight = viewport.clientHeight
    recomputeWindow(viewport.scrollTop, viewportHeight)
    resizeObserver = new ResizeObserver(() => queueWindowUpdate())
    resizeObserver.observe(viewport)
  })
  onCleanup(() => {
    resizeObserver?.disconnect()
    if (windowFrame !== undefined) cancelAnimationFrame(windowFrame)
  })

  // Measure mounted items so offsets beyond the first screen reflect real
  // (expanded) heights. The -1 compensates the collapsed border overlap.
  const itemObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement
      const height = (entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight) - 1
      noteHeight(el.dataset.file ?? "", height)
    }
  })
  onCleanup(() => itemObserver.disconnect())

  const handleChange = (open: string[]) => {
    props.onOpenChange?.(open)
    if (props.open !== undefined) return
    setStore("open", open)
  }

  const handleExpandOrCollapseAll = () => {
    const next = open().length > 0 ? [] : files()
    handleChange(next)
  }

  const openFileLabel = () => i18n.t("ui.sessionReview.openFile")

  createEffect(() => {
    const focus = props.focusedComment
    if (!focus) return

    untrack(() => {
      focusToken++
      const token = focusToken

      setStore("opened", focus)

      const comment = (props.comments ?? []).find((c) => c.file === focus.file && c.id === focus.id)
      if (comment) setStore("selection", { file: comment.file, range: cloneSelectedLineRange(comment.selection) })

      const current = open()
      if (!current.includes(focus.file)) {
        handleChange([...current, focus.file])
      }

      const scrollTo = (attempt: number) => {
        if (token !== focusToken) return

        const root = scroll
        if (!root) return

        const wrapper = anchors.get(focus.file)
        const anchor = wrapper?.querySelector(`[data-comment-id="${focus.id}"]`)
        const ready =
          anchor instanceof HTMLElement && anchor.style.pointerEvents !== "none" && anchor.style.opacity !== "0"

        const target = ready ? anchor : wrapper
        if (!target) {
          if (attempt >= 120) return
          requestAnimationFrame(() => scrollTo(attempt + 1))
          return
        }

        const rootRect = root.getBoundingClientRect()
        const targetRect = target.getBoundingClientRect()
        const offset = targetRect.top - rootRect.top
        const next = root.scrollTop + offset - rootRect.height / 2 + targetRect.height / 2
        root.scrollTop = Math.max(0, next)

        if (ready) return
        if (attempt >= 120) return
        requestAnimationFrame(() => scrollTo(attempt + 1))
      }

      requestAnimationFrame(() => scrollTo(0))

      requestAnimationFrame(() => props.onFocusedCommentChange?.(null))
    })
  })

  return (
    <div data-component="session-review" class={props.class} classList={props.classList}>
      <div data-slot="session-review-header" class={props.classes?.header}>
        <div data-slot="session-review-title">
          {props.title === undefined ? i18n.t("ui.sessionReview.title") : props.title}
        </div>
        <div data-slot="session-review-actions">
          <Show when={hasDiffs() && props.onDiffStyleChange}>
            <RadioGroup
              options={["unified", "split"] as const}
              current={diffStyle()}
              size="small"
              value={(style) => style}
              label={(style) =>
                i18n.t(style === "unified" ? "ui.sessionReview.diffStyle.unified" : "ui.sessionReview.diffStyle.split")
              }
              onSelect={(style) => style && props.onDiffStyleChange?.(style)}
            />
          </Show>
          <Show when={hasDiffs()}>
            <Button
              size="small"
              icon="chevron-grabber-vertical"
              class="w-[106px] justify-start"
              onClick={handleExpandOrCollapseAll}
            >
              <Switch>
                <Match when={open().length > 0}>{i18n.t("ui.sessionReview.collapseAll")}</Match>
                <Match when={true}>{i18n.t("ui.sessionReview.expandAll")}</Match>
              </Switch>
            </Button>
          </Show>
          {props.actions}
        </div>
      </div>

      <ScrollView
        data-slot="session-review-scroll"
        viewportRef={(el) => {
          scroll = el
          viewport = el
          props.scrollRef?.(el)
        }}
        onScroll={(e) => {
          queueWindowUpdate()
          ;(props.onScroll as unknown as ((e: unknown) => void) | undefined)?.(e)
        }}
        classList={{
          [props.classes?.root ?? ""]: !!props.classes?.root,
        }}
      >
        <div data-slot="session-review-container" class={props.classes?.container}>
          <Show when={hasDiffs()} fallback={props.empty}>
            <div class="pb-6">
              <Accordion
                multiple
                value={open()}
                onChange={handleChange}
                style={{
                  // Spacers keep the total scroll height stable while only the
                  // viewport window of items is mounted.
                  "padding-top": `${win().start > 0 ? Math.round(offsets()[win().start]!) : 0}px`,
                  "padding-bottom": `${
                    props.diffs.length > win().end ? Math.round(offsets()[props.diffs.length]! - offsets()[win().end]!) : 0
                  }px`,
                }}
              >
                <For each={props.diffs.slice(win().start, win().end)}>
                  {(diff) => {
                    let wrapper: HTMLDivElement | undefined
                    const file = diff.file ?? ""

                    const expanded = () => openSet().has(file)
                    const force = () => !!store.force[file]

                    const comments = () => commentsByFile().get(file) ?? EMPTY_COMMENTS
                    const mediaKind = createMemo(() => mediaKindFromPath(file))

                    // Trust the recorded status: resolving badges from contents
                    // would force a full unified-patch parse per file, which is
                    // wasted work while the item is collapsed. Legacy records
                    // without a status fall back to the generic modified badge.
                    const isAdded = () => diff.status === "added"
                    const isDeleted = () => diff.status === "deleted"

                    onCleanup(() => {
                      anchors.delete(file)
                    })

                    return (
                      <Accordion.Item
                        ref={(el: HTMLDivElement) => {
                          itemObserver.observe(el)
                          onCleanup(() => itemObserver.unobserve(el))
                        }}
                        value={file}
                        id={diffId(file)}
                        data-file={file}
                        data-slot="session-review-accordion-item"
                        data-selected={props.focusedFile === file ? "" : undefined}
                      >
                        <StickyAccordionHeader>
                          <Accordion.Trigger>
                            <div data-slot="session-review-trigger-content">
                              <div data-slot="session-review-file-info">
                                <FileIcon node={{ path: file, type: "file" }} />
                                <div data-slot="session-review-file-name-container">
                                  <Show when={file.includes("/")}>
                                    <span data-slot="session-review-directory">{`\u202A${getDirectory(file)}\u202C`}</span>
                                  </Show>
                                  <span data-slot="session-review-filename">{getFilename(file)}</span>
                                  <Show when={props.onViewFile}>
                                    <Tooltip value={openFileLabel()} placement="top" gutter={4}>
                                      <button
                                        data-slot="session-review-view-button"
                                        type="button"
                                        aria-label={openFileLabel()}
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          props.onViewFile?.(file)
                                        }}
                                      >
                                        <Icon name="open-file" size="small" />
                                      </button>
                                    </Tooltip>
                                  </Show>
                                </div>
                              </div>
                              <div data-slot="session-review-trigger-actions">
                                <Switch>
                                  <Match when={isAdded()}>
                                    <div data-slot="session-review-change-group" data-type="added">
                                      <span data-slot="session-review-change" data-type="added">
                                        {i18n.t("ui.sessionReview.change.added")}
                                      </span>
                                      <DiffChanges changes={diff} />
                                    </div>
                                  </Match>
                                  <Match when={isDeleted()}>
                                    <span data-slot="session-review-change" data-type="removed">
                                      {i18n.t("ui.sessionReview.change.removed")}
                                    </span>
                                  </Match>
                                  <Match when={!!mediaKind()}>
                                    <span data-slot="session-review-change" data-type="modified">
                                      {i18n.t("ui.sessionReview.change.modified")}
                                    </span>
                                  </Match>
                                  <Match when={true}>
                                    <DiffChanges changes={diff} />
                                  </Match>
                                </Switch>
                                <span data-slot="session-review-diff-chevron">
                                  <Icon name="chevron-down" size="small" />
                                </span>
                              </div>
                            </div>
                          </Accordion.Trigger>
                        </StickyAccordionHeader>
                        <Accordion.Content data-slot="session-review-accordion-content">
                          <div
                            data-slot="session-review-diff-wrapper"
                            ref={(el) => {
                              wrapper = el
                              anchors.set(file, el)
                            }}
                          >
                            <Show when={expanded()}>
                              <ReviewDiffBody
                                diff={diff}
                                file={file}
                                diffStyle={diffStyle()}
                                comments={comments()}
                                selection={store.selection}
                                commenting={store.commenting}
                                opened={store.opened}
                                setSelection={(value) => setStore("selection", value)}
                                setCommenting={(value) => setStore("commenting", value)}
                                setOpened={(value) => setStore("opened", value)}
                                force={force()}
                                onForce={() => setStore("force", file, true)}
                                onDiffRendered={() => {
                                  props.onDiffRendered?.()
                                }}
                                onLineComment={props.onLineComment}
                                onLineCommentUpdate={props.onLineCommentUpdate}
                                onLineCommentDelete={props.onLineCommentDelete}
                                lineCommentActions={props.lineCommentActions}
                                readFile={props.readFile}
                              />
                            </Show>
                          </div>
                        </Accordion.Content>
                      </Accordion.Item>
                    )
                  }}
                </For>
              </Accordion>
            </div>
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
