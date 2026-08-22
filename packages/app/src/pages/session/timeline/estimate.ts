import type { Part, ToolPart } from "@opencode-ai/sdk/v2"

/**
 * Mirrors normalizeTool from @opencode-ai/ui/tool-meta without importing the
 * component package (whose module graph is client-only and breaks unit tests).
 */
function normalizedToolName(tool: string) {
  const name = tool.trim().toLowerCase() || "tool"
  if (name === "terminal") return "bash"
  if (name === "read_file") return "read"
  if (name === "web_search") return "websearch"
  return name
}

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
export const TURN_DIVIDER_HEIGHT = 40
export const DIFF_SUMMARY_HEIGHT = 44
/** session-turn-thinking measures 24px; the row itself lands at ~40 once wrapped. */
export const THINKING_HEIGHT = 24
export const TEXT_PART_MARGIN = 24
/** Live or user-expanded tools render full output; give them a generous base. */
export const OPEN_TOOL_HEIGHT = 160
/** Fallback for shapes the estimator does not model (keeps today's 60px behavior). */
export const UNKNOWN_ROW_HEIGHT = 60
/** UserMessage chrome: body padding + meta bar + inner gaps (no attachments). */
export const USER_MESSAGE_CHROME = 70
/** CommentStrip bubble: py-2 + filename row + pt-1. */
export const COMMENT_STRIP_CHROME = 34
/** Error/Retry card padding around the message text. */
export const ERROR_CARD_CHROME = 44

export const MIN_ROW_ESTIMATE = 40
export const MAX_VIEWPORT_MULTIPLIER = 3
const DEFAULT_VIEWPORT_HEIGHT = 800
const DEFAULT_TEXT_LINE_HEIGHT = 25.2 // 14px × 1.8 (base theme markdown)
const DEFAULT_CHAR_WIDTH = 7.7 // ~0.55em sans at 14px
/** px-4 md:px-5 horizontal padding plus a small safety margin for text wrap. */
const TEXT_WIDTH_INSET = 48
const MIN_TEXT_WIDTH = 240
const MIN_CHARS_PER_LINE = 24

/**
 * Input shape mirroring the relevant subset of {@link TimelineRow.TimelineRow}
 * without importing the class (same rationale as RowContentVersionInput in
 * measure.ts: keeps this module free of a rows.ts dependency for tests).
 */
export type EstimateRowInput = {
  _tag: string
  userMessageID?: string
  previousAssistantPart?: boolean
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
}

const toolPartLive = (part: ToolPart) =>
  part.state.status === "pending" || part.state.status === "running"

/** Per-paragraph wrap so explicit newlines and short paragraphs stay conservative. */
export function estimateTextLines(text: string, width: number, charWidth: number) {
  const charsPerLine = Math.max(
    MIN_CHARS_PER_LINE,
    Math.floor(Math.max(width - TEXT_WIDTH_INSET, MIN_TEXT_WIDTH) / Math.max(charWidth, 1)),
  )
  let lines = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const paragraph = raw.trim()
    lines += paragraph.length > 0 ? Math.ceil(paragraph.length / charsPerLine) : 1
  }
  return Math.max(1, lines)
}

function estimateTextHeight(
  text: string | undefined,
  width: number,
  options: { textLineHeight?: number; charWidth?: number },
) {
  const lines = estimateTextLines(text ?? "", width, options.charWidth ?? DEFAULT_CHAR_WIDTH)
  return lines * (options.textLineHeight ?? DEFAULT_TEXT_LINE_HEIGHT)
}

function estimateToolPartHeight(
  part: ToolPart,
  options: EstimateRowHeightOptions,
) {
  if (toolPartLive(part)) return OPEN_TOOL_HEIGHT
  // Answered questions render their full answer card expanded (the question
  // tool registers defaultOpen={completed}), never the collapsed box.
  if (normalizedToolName(part.tool) === "question") return OPEN_TOOL_HEIGHT
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
        height: TEXT_PART_MARGIN + estimateTextHeight(part.text, width, options),
        uncertain: true,
      }
    if (part.type === "reasoning") return { height: COLLAPSED_REASONING_HEIGHT, uncertain: false }
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
  const viewportHeight = options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT
  const previousSpacing = row.previousAssistantPart ? PREVIOUS_PART_SPACING : 0

  switch (row._tag) {
    case "TurnGap":
      return TURN_GAP_HEIGHT

    case "CommentStrip":
      return clampRowEstimate(
        COMMENT_STRIP_CHROME + estimateTextHeight(options.userMessageText?.(row.userMessageID ?? ""), width, options),
        viewportHeight,
      )

    case "UserMessage":
      return clampRowEstimate(
        USER_MESSAGE_CHROME + estimateTextHeight(options.userMessageText?.(row.userMessageID ?? ""), width, options),
        viewportHeight,
      )

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
      return clampRowEstimate(ERROR_CARD_CHROME + estimateTextHeight(row.text, width, options), viewportHeight)

    default:
      return clampRowEstimate(UNKNOWN_ROW_HEIGHT, viewportHeight)
  }
}

export type TimelineTextMetrics = {
  lineHeight: number
  charWidth: number
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
