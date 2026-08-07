import { createMemo, createSignal, Show, type JSX } from "solid-js"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../context/i18n"
import { Markdown, type MarkdownStage } from "./markdown"
import {
  formatInjectionPreview,
  injectionSummaryFromText,
  injectionTitleFromParts,
  isInjectionPending,
  joinInjectionText,
  selectInjectionParts,
} from "./injected-prompt-model"

export {
  INJECTION_KINDS,
  formatInjectionPreview,
  injectionPreviewFromParts,
  injectionSummaryFromText,
  injectionTitleFromParts,
  isInjectionKind,
  isInjectionPending,
  isInjectionTextPart,
  joinInjectionText,
  scheduledInjectionPart,
  projectTaskInjectionPart,
  selectInjectionParts,
  type InjectionKind,
  type InjectionTitleTranslator,
} from "./injected-prompt-model"

function escapeHtmlTags(str: string) {
  // Only escape tags that look like real HTML tags (alphanumeric tag names with optional attributes)
  return str.replace(/<(\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)??)>/g, "&lt;$1&gt;")
}

function preserveLineBreaks(str: string) {
  return str.replace(/\n/g, "  \n")
}

export type InjectedPromptProps = {
  /** Panel title (e.g. "计划任务注入提示词"). */
  title: string
  /** Full injected prompt body. */
  text: string
  /** Show "injecting..." instead of char summary. */
  pending?: boolean
  /** Optional summary on the right (defaults to char count). */
  summary?: string
  /** Collapsed one-line preview (defaults to truncated text). */
  preview?: string
  defaultExpanded?: boolean
  /** Stable key for markdown cache. */
  cacheKey?: string
  /** Optional data-kind for styling/tests (hook-injection, scheduled-injection, …). */
  kind?: string
  markdownStage?: MarkdownStage
  onMarkdownStage?: (key: string, stage: MarkdownStage | undefined) => void
  markdownEager?: boolean
  markdownViewport?: HTMLDivElement
  markdownHighlight?: "full" | "defer"
  markdownMath?: "full" | "defer"
  class?: string
  children?: JSX.Element
}

/**
 * Shared collapsible panel for any injected prompt source
 * (hooks, slash commands, scheduled tasks, future project-task UI, etc.).
 */
export function InjectedPrompt(props: InjectedPromptProps) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(!!props.defaultExpanded)

  const body = createMemo(() => props.text ?? "")
  const pending = createMemo(() => !!props.pending)
  const preview = createMemo(() => {
    if (props.preview !== undefined) return props.preview
    return formatInjectionPreview(body())
  })
  const summary = createMemo(() => {
    if (props.summary !== undefined) return props.summary
    if (pending()) return i18n.t("ui.message.injection.injecting")
    return injectionSummaryFromText(body(), (key, params) => i18n.t(key as any, params))
  })
  const rendered = createMemo(() => preserveLineBreaks(escapeHtmlTags(body())))

  return (
    <div
      data-component="injected-prompt"
      data-kind={props.kind}
      data-expanded={expanded() ? "true" : undefined}
      class={props.class}
    >
      <button
        data-slot="injected-prompt-trigger"
        data-expanded={expanded() ? "true" : undefined}
        onClick={() => setExpanded(!expanded())}
        onMouseDown={(e) => e.preventDefault()}
        type="button"
      >
        <span data-slot="injected-prompt-title">{props.title}</span>
        <span data-slot="injected-prompt-summary">{summary()}</span>
      </button>
      <Show when={!expanded() && preview()}>
        <div data-slot="injected-prompt-preview">{preview()}</div>
      </Show>
      <Show when={expanded()}>
        <div data-slot="injected-prompt-content">
          <Show when={props.children} fallback={
            <Markdown
              text={rendered()}
              cacheKey={props.cacheKey}
              stage={props.markdownStage}
              onStage={props.onMarkdownStage}
              eager={props.markdownEager}
              viewport={props.markdownViewport}
              highlight={props.markdownHighlight}
              math={props.markdownMath}
            />
          }>
            {props.children}
          </Show>
        </div>
      </Show>
    </div>
  )
}

export type InjectedPromptFromPartsProps = {
  parts: Part[] | undefined
  cacheKey: string
  defaultExpanded?: boolean
  markdownStage?: MarkdownStage
  onMarkdownStage?: (key: string, stage: MarkdownStage | undefined) => void
  markdownEager?: boolean
  markdownViewport?: HTMLDivElement
  markdownHighlight?: "full" | "defer"
  markdownMath?: "full" | "defer"
  class?: string
}

/**
 * Convenience wrapper: select injection text parts from a user message and render
 * the shared collapsible panel with auto title.
 */
export function InjectedPromptFromParts(props: InjectedPromptFromPartsProps) {
  const i18n = useI18n()
  const selected = createMemo(() => selectInjectionParts(props.parts))
  const text = createMemo(() => joinInjectionText(selected()))
  const pending = createMemo(() => isInjectionPending(selected(), text()))
  const title = createMemo(() =>
    injectionTitleFromParts(selected(), (key, params) => i18n.t(key as any, params)),
  )
  const kind = createMemo(() => {
    const kinds = new Set(
      selected()
        .map((part) => part.metadata?.kind)
        .filter((value): value is string => typeof value === "string"),
    )
    return kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? "mixed" : undefined
  })

  return (
    <Show when={selected().length > 0}>
      <InjectedPrompt
        title={title()}
        text={text()}
        pending={pending()}
        kind={kind()}
        cacheKey={props.cacheKey}
        defaultExpanded={props.defaultExpanded}
        markdownStage={props.markdownStage}
        onMarkdownStage={props.onMarkdownStage}
        markdownEager={props.markdownEager}
        markdownViewport={props.markdownViewport}
        markdownHighlight={props.markdownHighlight}
        markdownMath={props.markdownMath}
        class={props.class}
      />
    </Show>
  )
}

/** Type helper for callers that already filtered injection parts. */
export type InjectedPromptParts = TextPart[]
