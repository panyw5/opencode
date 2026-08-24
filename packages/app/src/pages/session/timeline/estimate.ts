import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

/**
 * Height estimation for timeline rows that have no cached measurement yet.
 *
 * Constants below were calibrated against the live app (CDP measurements over
 * the claude theme, 18px base font) rather than derived from CSS by hand:
 * - TurnGap renders `h-6` → 24.
 * - A collapsed tool-collapsible is padding 8+8 + trigger 32 + border 1+1 → 50
 *   (the deferred ToolPartPlaceholder reuses the same outer box).
 * - `[data-slot="session-turn-assistant-content"]` stacks context-group tools
 *   with `gap: 12px`.
 * - A collapsed reasoning-collapsible is padding 0 + trigger 32 → 32.
 * - TurnDivider measures 40; a collapsed DiffSummary trigger measures 44.
 * - `[data-slot="text-part"]` carries `margin-top: 24px`.
 * - The row frame adds `pt-3` (12px) when `previousAssistantPart` is set.
 *
 * Estimates are deliberately conservative-high (risk mitigation: first entry
 * into the viewport should grow a row downward, never shrink it abruptly) and
 * clamped to [MIN_ROW_ESTIMATE, viewportHeight × 3].
 */

export const TURN_GAP_HEIGHT = 24
export const PREVIOUS_PART_SPACING = 12
export const COLLAPSED_TOOL_HEIGHT = 50
export const TOOL_SPACING = 12
export const COLLAPSED_REASONING_HEIGHT = 32
/** Streaming reasoning keeps a fixed three-line preview below its trigger. */
export const REASONING_PREVIEW_HEIGHT = 76
/** `reasoning-collapsible` uses an 8px gap between trigger and preview. */
export const REASONING_PREVIEW_GAP = 8
export const TURN_DIVIDER_HEIGHT = 40
export const DIFF_SUMMARY_HEIGHT = 44
/** session-turn-thinking measures 24px; the row itself lands at ~40 once wrapped. */
export const THINKING_HEIGHT = 24
export const TEXT_PART_MARGIN = 24
/** Copy/meta row shown under the final assistant text: margin-top 4 + min-height 24. */
export const TEXT_PART_META_HEIGHT = 28
/** Tools explicitly expanded by user settings render their full output. */
export const OPEN_TOOL_HEIGHT = 160
/** Fallback for shapes the estimator does not model (keeps today's 60px behavior). */
export const UNKNOWN_ROW_HEIGHT = 60
/** UserMessage text padding + meta bar + the gap/margin between them. */
export const USER_MESSAGE_CHROME = 50
/** Collapsed synthetic information panel measured in the live app. */
export const INJECTED_PROMPT_HEIGHT = 59
/** CommentStrip bubble: py-2 + filename row + pt-1. */
export const COMMENT_STRIP_CHROME = 34
/** Comment bubbles are horizontally arranged and individually capped by CSS. */
export const COMMENT_STRIP_WIDTH = 260
/** Error/Retry card padding around the message text. */
export const ERROR_CARD_CHROME = 44
/** `.error-card` is a nested scroller and never grows beyond this height. */
export const ERROR_CARD_MAX_HEIGHT = 240

export const MIN_ROW_ESTIMATE = 40
export const MAX_VIEWPORT_MULTIPLIER = 3
const DEFAULT_VIEWPORT_HEIGHT = 800
const DEFAULT_TEXT_LINE_HEIGHT = 25.2 // 14px × 1.8 (base theme markdown)
const DEFAULT_CHAR_WIDTH = 7.7 // ~0.55em sans at 14px
/** px-4 md:px-5 horizontal padding plus a small safety margin for text wrap. */
const TEXT_WIDTH_INSET = 48
const USER_MESSAGE_WIDTH_SHARE = 0.82
const USER_MESSAGE_MAX_CHARS = 64
const USER_MESSAGE_TEXT_INSET = 24
const COMMENT_STRIP_TEXT_INSET = 20
const MIN_TEXT_WIDTH = 240
const MIN_CHARS_PER_LINE = 24
/** CJK/full-width glyphs occupy substantially more horizontal space than Latin glyphs. */
const WIDE_GLYPH_UNITS = 1.75

function textWidthUnits(text: string) {
  let units = 0
  for (const glyph of text) {
    if (/\p{Mark}/u.test(glyph)) continue
    units += (glyph.codePointAt(0) ?? 0) > 0xff ? WIDE_GLYPH_UNITS : 1
  }
  return units
}

/**
 * Input shape mirroring the relevant subset of {@link TimelineRow.TimelineRow}
 * without importing the class (same rationale as RowContentVersionInput in
 * measure.ts: keeps this module free of a rows.ts dependency for tests).
 */
export type EstimateRowInput = {
  _tag: string
  userMessageID?: string
  previousAssistantPart?: boolean
  topSpacing?: boolean
  label?: string
  phase?: string
  group?: {
    type: "part" | "context"
    ref?: { messageID: string; partID: string }
    refs?: ReadonlyArray<{ messageID: string; partID: string }>
  }
  diffs?: ReadonlyArray<{ file: string }>
  text?: string
}

export type EstimateRowHeightOptions = {
  /** Resolve the underlying Part for AssistantPart rows. */
  parts?: (messageID: string, partID: string) => Part | undefined
  /** Whether a tool part renders expanded by default (bash/edit settings). */
  toolDefaultOpen?: (part: ToolPart) => boolean
  /** Rendered markdown line height in px (theme + font-size dependent). */
  textLineHeight?: number
  /** Average rendered character width in px, used to wrap text into lines. */
  charWidth?: number
  /** Viewport height driving the upper estimate clamp. */
  viewportHeight?: number
  /** Concatenated text of a user message (drives UserMessage line count). */
  userMessageText?: (messageID: string) => string | undefined
  /** CommentStrip cards are horizontal; only the tallest comment controls row height. */
  commentStripTexts?: (messageID: string) => ReadonlyArray<string>
  /** Whether the user message renders a collapsed injected-prompt panel. */
  userMessageHasInjectedPrompt?: (messageID: string) => boolean
  /** Whether this text part renders the assistant copy/meta row. */
  textPartHasMeta?: (messageID: string, partID: string) => boolean
  /** Match ReasoningPartDisplay's live preview predicate for this message. */
  reasoningStreaming?: (messageID: string, part: Part) => boolean
}

/** Live tools are cheap in height but expensive to keep mounted and reactive. */
const toolPartLive = (part: ToolPart) => part.state.status === "pending" || part.state.status === "running"

/** Per-paragraph wrap so explicit newlines and short paragraphs stay conservative. */
export function estimateTextLines(text: string, width: number, charWidth: number, widthInset = TEXT_WIDTH_INSET) {
  const charsPerLine = Math.max(
    MIN_CHARS_PER_LINE,
    Math.floor(Math.max(width - widthInset, MIN_TEXT_WIDTH) / Math.max(charWidth, 1)),
  )
  let lines = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const paragraph = raw.trim()
    lines += paragraph.length > 0 ? Math.ceil(textWidthUnits(paragraph) / charsPerLine) : 1
  }
  return Math.max(1, lines)
}

function estimateTextHeight(
  text: string | undefined,
  width: number,
  options: { textLineHeight?: number; charWidth?: number },
  widthInset = TEXT_WIDTH_INSET,
) {
  const lines = estimateTextLines(text ?? "", width, options.charWidth ?? DEFAULT_CHAR_WIDTH, widthInset)
  return lines * (options.textLineHeight ?? DEFAULT_TEXT_LINE_HEIGHT)
}

function estimateToolPartHeight(part: ToolPart, options: EstimateRowHeightOptions) {
  if (options.toolDefaultOpen?.(part)) return OPEN_TOOL_HEIGHT
  return COLLAPSED_TOOL_HEIGHT
}

type GroupEstimate = {
  height: number
  /** Text rows wrap unpredictably; structural rows render a known box. */
  uncertain: boolean
}

function estimatePartGroupHeight(
  row: EstimateRowInput,
  width: number,
  options: EstimateRowHeightOptions,
): GroupEstimate {
  const group = row.group
  if (!group) return { height: UNKNOWN_ROW_HEIGHT, uncertain: false }

  if (group.type === "context" && group.refs) {
    let total = 0
    let count = 0
    for (const ref of group.refs) {
      const part = options.parts?.(ref.messageID, ref.partID)
      if (part?.type === "tool") {
        total += estimateToolPartHeight(part, options)
      } else {
        total += COLLAPSED_TOOL_HEIGHT
      }
      count += 1
    }
    // session-turn-assistant-content gap between stacked tools.
    return { height: total + Math.max(0, count - 1) * TOOL_SPACING, uncertain: false }
  }

  if (group.type === "part" && group.ref) {
    const part = options.parts?.(group.ref.messageID, group.ref.partID)
    if (!part) return { height: UNKNOWN_ROW_HEIGHT, uncertain: false }
    if (part.type === "tool") return { height: estimateToolPartHeight(part, options), uncertain: false }
    if (part.type === "text")
      return {
        height:
          TEXT_PART_MARGIN +
          estimateTextHeight(part.text, width, options) +
          (options.textPartHasMeta?.(group.ref.messageID, group.ref.partID) ? TEXT_PART_META_HEIGHT : 0),
        uncertain: true,
      }
    if (part.type === "reasoning") {
      const preview = options.reasoningStreaming?.(group.ref.messageID, part)
        ? REASONING_PREVIEW_GAP + REASONING_PREVIEW_HEIGHT
        : 0
      return { height: COLLAPSED_REASONING_HEIGHT + preview, uncertain: false }
    }
    return { height: UNKNOWN_ROW_HEIGHT, uncertain: false }
  }

  return { height: UNKNOWN_ROW_HEIGHT, uncertain: false }
}

/** Clamp into [MIN_ROW_ESTIMATE, viewportHeight × MAX_VIEWPORT_MULTIPLIER]. */
export function clampRowEstimate(height: number, viewportHeight: number) {
  const max = Math.max(viewportHeight * MAX_VIEWPORT_MULTIPLIER, MIN_ROW_ESTIMATE)
  return Math.min(Math.max(height, MIN_ROW_ESTIMATE), max)
}

/**
 * Structural heights (collapsed tools, dividers, gaps) are calibrated against
 * the real DOM, so raising them to MIN_ROW_ESTIMATE would only introduce an
 * avoidable jump when the exact measure lands. Only the huge-row cap applies.
 */
export function capRowEstimate(height: number, viewportHeight: number) {
  const max = Math.max(viewportHeight * MAX_VIEWPORT_MULTIPLIER, MIN_ROW_ESTIMATE)
  return Math.min(height, max)
}

/**
 * Estimate the rendered height of a timeline row without touching the DOM.
 * Pure: same row + width + options always yields the same number.
 */
export function estimateRowHeight(row: EstimateRowInput, width: number, options: EstimateRowHeightOptions = {}) {
  // createVirtualizer calls estimateSize synchronously before the list
  // ResizeObserver publishes its first dimensions. Treat that transient 0 as
  // unknown; otherwise every uncertain text row is incorrectly capped at the
  // 40px minimum during the initial geometry pass.
  const viewportHeight =
    options.viewportHeight !== undefined && options.viewportHeight > 0
      ? options.viewportHeight
      : DEFAULT_VIEWPORT_HEIGHT
  const previousSpacing = (row.topSpacing ?? row.previousAssistantPart) ? PREVIOUS_PART_SPACING : 0

  switch (row._tag) {
    case "TurnGap":
      return TURN_GAP_HEIGHT

    case "CommentStrip":
      return clampRowEstimate(
        COMMENT_STRIP_CHROME +
          Math.max(
            options.textLineHeight ?? DEFAULT_TEXT_LINE_HEIGHT,
            ...(options.commentStripTexts?.(row.userMessageID ?? "") ?? []).map((text) =>
              estimateTextHeight(
                text,
                Math.min(width * USER_MESSAGE_WIDTH_SHARE, COMMENT_STRIP_WIDTH),
                options,
                COMMENT_STRIP_TEXT_INSET,
              ),
            ),
          ),
        viewportHeight,
      )

    case "UserMessage": {
      const text = options.userMessageText?.(row.userMessageID ?? "")
      const injected = options.userMessageHasInjectedPrompt?.(row.userMessageID ?? "") ?? false
      if (!text && injected) return capRowEstimate(INJECTED_PROMPT_HEIGHT, viewportHeight)
      const userWidth = Math.min(
        width * USER_MESSAGE_WIDTH_SHARE,
        USER_MESSAGE_MAX_CHARS * (options.charWidth ?? DEFAULT_CHAR_WIDTH),
      )
      return clampRowEstimate(
        USER_MESSAGE_CHROME +
          estimateTextHeight(
            text,
            userWidth,
            options,
            USER_MESSAGE_TEXT_INSET,
          ) +
          (injected ? INJECTED_PROMPT_HEIGHT : 0),
        viewportHeight,
      )
    }

    case "TurnDivider":
      return TURN_DIVIDER_HEIGHT

    case "AssistantPart": {
      const group = estimatePartGroupHeight(row, width, options)
      const raw = previousSpacing + group.height
      return group.uncertain ? clampRowEstimate(raw, viewportHeight) : capRowEstimate(raw, viewportHeight)
    }

    case "Thinking":
      return THINKING_HEIGHT

    case "Retry":
      return capRowEstimate(ERROR_CARD_CHROME, viewportHeight)

    case "DiffSummary":
      return DIFF_SUMMARY_HEIGHT

    case "Error":
      return Math.min(
        ERROR_CARD_MAX_HEIGHT,
        clampRowEstimate(ERROR_CARD_CHROME + estimateTextHeight(row.text, width, options), viewportHeight),
      )

    default:
      return clampRowEstimate(UNKNOWN_ROW_HEIGHT, viewportHeight)
  }
}

export type TimelineTextMetrics = {
  lineHeight: number
  charWidth: number
}

/**
 * Relative render cost of a row (1 ≈ one collapsed tool card). Drives the
 * overscan budget: cheap rows can prefetch many, expensive rows few.
 */
export function rowRenderCost(row: EstimateRowInput, options: EstimateRowHeightOptions = {}): number {
  switch (row._tag) {
    case "TurnGap":
    case "Thinking":
    case "Retry":
      return 0.25
    case "TurnDivider":
    case "DiffSummary":
      return 0.5
    case "CommentStrip":
    case "Error":
      return 1

    case "UserMessage":
      return (
        1.5 +
        estimateTextLines(
          options.userMessageText?.(row.userMessageID ?? "") ?? "",
          800,
          options.charWidth ?? DEFAULT_CHAR_WIDTH,
        ) /
          12
      )

    case "AssistantPart": {
      const group = row.group
      if (!group) return 1
      if (group.type === "context" && group.refs) {
        // One collapsible card per member plus a shared trigger.
        return 0.5 + group.refs.length
      }
      if (group.type === "part" && group.ref) {
        const part = options.parts?.(group.ref.messageID, group.ref.partID)
        if (!part) return 1
        if (part.type === "tool") {
          if (toolPartLive(part)) return 6
          if (options.toolDefaultOpen?.(part)) return 6
          return 1
        }
        if (part.type === "text") {
          const lines = estimateTextLines(part.text, 800, options.charWidth ?? DEFAULT_CHAR_WIDTH)
          return Math.min(Math.max(lines / 6, 1), 8)
        }
        if (part.type === "reasoning") return 0.75
        return 1
      }
      return 1
    }

    default:
      return 1
  }
}

/**
 * Keep the visible window plus as many overscan rows as the budget allows,
 * expanding outward from the visible edges (closest rows first). Indexes
 * outside the visible window that exceed the budget are dropped; the visible
 * window itself is never trimmed. Each side always keeps at least
 * `minPerSide` rows regardless of budget so scrolling never reveals blanks.
 */
export function trimRangeToBudget(input: {
  indexes: ReadonlyArray<number>
  startIndex: number
  endIndex: number
  costOf: (index: number) => number
  budget: number
  minPerSide?: number
}): number[] {
  const { indexes, startIndex, endIndex, costOf, budget } = input
  const minPerSide = input.minPerSide ?? 0
  if (indexes.length === 0) return []
  let visibleCost = 0
  const keep = new Set<number>()
  const below: number[] = []
  const above: number[] = []
  for (const index of indexes) {
    if (index >= startIndex && index <= endIndex) {
      keep.add(index)
      visibleCost += costOf(index)
    } else if (index < startIndex) {
      below.push(index)
    } else {
      above.push(index)
    }
  }
  let remaining = Math.max(0, budget - visibleCost)
  // Closest-to-viewport first: below in descending order, above ascending.
  below.sort((a, b) => b - a)
  above.sort((a, b) => a - b)
  const expand = (candidates: number[]) => {
    let kept = 0
    for (const index of candidates) {
      const guaranteed = kept < minPerSide
      const cost = costOf(index)
      if (!guaranteed && cost > remaining) continue
      keep.add(index)
      kept += 1
      if (!guaranteed) remaining -= cost
    }
  }
  expand(below)
  expand(above)
  return [...keep].sort((a, b) => a - b)
}

/**
 * Width available to timeline row content. Centered layouts cap rows with the
 * same `contentWidth * 0.8 * 0.25rem` formula used by settings.tsx; estimating
 * against the full scroll viewport undercounts wrapped lines on wide windows.
 */
export function timelineEstimateWidth(input: {
  viewportWidth: number
  centered: boolean
  contentWidth: number
  remSize?: number
}) {
  if (!input.centered || input.viewportWidth < 768) return input.viewportWidth
  const max = input.contentWidth * 0.8 * 0.25 * (input.remSize ?? 16)
  return Math.min(input.viewportWidth, max)
}

const DEFAULT_TEXT_METRICS: TimelineTextMetrics = {
  lineHeight: DEFAULT_TEXT_LINE_HEIGHT,
  charWidth: DEFAULT_CHAR_WIDTH,
}

/**
 * Read the live text metrics used by estimateRowHeight from the document's
 * theme (claude scales the base font by +1px and uses a monospace face with
 * 1.65 line-height; other themes use 1.8 and a sans face).
 */
export function timelineTextMetrics(root: HTMLElement | undefined): TimelineTextMetrics {
  const doc = root?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined)
  const element = doc?.documentElement
  if (!element) return DEFAULT_TEXT_METRICS
  const base = Number.parseFloat(getComputedStyle(element).getPropertyValue("--font-size-base"))
  if (!Number.isFinite(base) || base <= 0) return DEFAULT_TEXT_METRICS
  const claude = element.dataset.theme === "claude"
  const fontSize = base + (claude ? 1 : 0)
  return {
    lineHeight: fontSize * (claude ? 1.65 : 1.8),
    charWidth: fontSize * (claude ? 0.6 : 0.55),
  }
}
