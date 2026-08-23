import { createMemo, createSignal, Show, type JSX } from "solid-js"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../context/i18n"
import { Markdown, type MarkdownStage } from "./markdown"
import {
  injectionTextLength,
  injectionSummaryFromText,
  injectionTitleFromParts,
  injectionKindFromPart,
  isInjectionPartsPending,
  joinInjectionText,
  selectInjectionParts,
  type InjectionKind,
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
  backgroundTaskInjectionPart,
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
  /** Full injected prompt body, optionally supplied lazily for collapsed panels. */
  text: string | (() => string)
  /** Show "injecting..." instead of char summary. */
  pending?: boolean
  /** Optional summary on the right (defaults to char count). */
  summary?: string
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

function InjectedPromptContent(props: InjectedPromptProps) {
  const body = createMemo(() => (typeof props.text === "function" ? props.text() : (props.text ?? "")))
  const rendered = createMemo(() => preserveLineBreaks(escapeHtmlTags(body())))
  return (
    <div data-slot="injected-prompt-content">
      <Show
        when={props.children}
        fallback={
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
        }
      >
        {props.children}
      </Show>
    </div>
  )
}

/**
 * Shared collapsible panel for any injected prompt source
 * (hooks, slash commands, scheduled tasks, future project-task UI, etc.).
 */
export function InjectedPrompt(props: InjectedPromptProps) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(!!props.defaultExpanded)

  // Keep lazy bodies as plain accessors. createMemo evaluates eagerly when it
  // is created, which would join/escape large injected prompts even while the
  // panel is collapsed.
  const body = () => (typeof props.text === "function" ? props.text() : (props.text ?? ""))
  const pending = createMemo(() => !!props.pending)
  const summary = createMemo(() => {
    if (pending()) return i18n.t("ui.message.injection.injecting")
    if (props.summary !== undefined) return props.summary
    return injectionSummaryFromText(body(), (key, params) => i18n.t(key as any, params))
  })

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
        aria-expanded={expanded()}
        onClick={() => setExpanded(!expanded())}
        onMouseDown={(e) => e.preventDefault()}
        type="button"
      >
        <span data-slot="injected-prompt-title">{props.title}</span>
        <span data-slot="injected-prompt-summary">{summary()}</span>
      </button>
      <Show when={expanded()}>
        <InjectedPromptContent {...props} />
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
  const pending = createMemo(() => isInjectionPartsPending(selected()))
  const summary = createMemo(() =>
    i18n.t("ui.message.injection.chars", { count: injectionTextLength(selected()).toLocaleString() }),
  )
  const title = createMemo(() =>
    injectionTitleFromParts(selected(), (key, params) => i18n.t(key as any, params)),
  )
  const kind = createMemo(() => {
    const kinds = new Set(
      selected()
        .map(injectionKindFromPart)
        .filter((value): value is InjectionKind => value !== undefined),
    )
    return kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? "mixed" : undefined
  })

  return (
    <Show when={selected().length > 0}>
      <InjectedPrompt
        title={title()}
        text={() => joinInjectionText(selected())}
        pending={pending()}
        summary={summary()}
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
