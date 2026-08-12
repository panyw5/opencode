import type { Part, TextPart } from "@opencode-ai/sdk/v2"

/** Synthetic text parts that render as a collapsible injected-prompt panel. */
export const INJECTION_KINDS = [
  "hook-injection",
  "command-injection",
  "scheduled-injection",
  "project-task-injection",
  "background-task-injection",
] as const

export type InjectionKind = (typeof INJECTION_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(INJECTION_KINDS)

export function isInjectionKind(kind: unknown): kind is InjectionKind {
  return typeof kind === "string" && KIND_SET.has(kind)
}

export function isInjectionTextPart(part: Part): part is TextPart {
  if (part.type !== "text" || !part.synthetic) return false
  return isInjectionKind(part.metadata?.kind)
}

/** Filter message parts that belong in the injected-prompt UI. */
export function selectInjectionParts(parts: Part[] | undefined): TextPart[] {
  if (!parts?.length) return []
  return parts.filter(isInjectionTextPart)
}

export function joinInjectionText(parts: TextPart[]): string {
  return parts
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n\n")
}

export function isInjectionPending(parts: TextPart[], text: string): boolean {
  return text.trim().length === 0 && parts.some((part) => part.metadata?.pending === true)
}

export function formatInjectionPreview(text: string, max = 180): string {
  const compact = text.trim().replace(/\s+/g, " ")
  if (compact.length <= max) return compact
  return compact.slice(0, max) + "…"
}

/**
 * Flat single-line preview for menus / lists when ordinary user text is empty.
 */
export function injectionPreviewFromParts(parts: Part[] | undefined): string | undefined {
  const selected = selectInjectionParts(parts)
  if (selected.length === 0) return undefined
  const text = joinInjectionText(selected).trim().replace(/\s+/g, " ")
  return text.length > 0 ? text : undefined
}

function uniqueMetadataStrings(parts: TextPart[], kind: InjectionKind, key: string): string[] {
  const values = new Set<string>()
  for (const part of parts) {
    if (part.metadata?.kind !== kind) continue
    const raw = part.metadata?.[key]
    if (typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (trimmed) values.add(trimmed)
  }
  return [...values]
}

export type InjectionTitleTranslator = (key: string, params?: Record<string, string | number | boolean>) => string

/**
 * Resolve the collapsible panel title from injection part kinds / metadata.
 * Callers pass their i18n `t` function (ui package keys under `ui.message.injection.*`).
 */
export function injectionTitleFromParts(parts: TextPart[], t: InjectionTitleTranslator): string {
  const kinds = new Set(parts.map((part) => part.metadata?.kind).filter(isInjectionKind))

  if (kinds.size === 1 && kinds.has("hook-injection")) {
    const hooks = uniqueMetadataStrings(parts, "hook-injection", "hook")
    const hook = hooks.length > 0 ? hooks.join(", ") : undefined
    return hook ? t("ui.message.injection.hookPrompt", { hook }) : t("ui.message.injection.hookPromptFallback")
  }

  if (kinds.size === 1 && kinds.has("command-injection")) {
    const commands = uniqueMetadataStrings(parts, "command-injection", "command")
    const command = commands.length === 1 ? commands[0] : undefined
    return command
      ? t("ui.message.injection.commandPrompt", { command: "/" + command })
      : t("ui.message.injection.slashCommandPrompt")
  }

  if (kinds.size === 1 && kinds.has("scheduled-injection")) {
    const names = uniqueMetadataStrings(parts, "scheduled-injection", "taskName")
    const name = names.length === 1 ? names[0] : undefined
    return name
      ? t("ui.message.injection.scheduledPrompt", { name })
      : t("ui.message.injection.scheduledPromptFallback")
  }

  if (kinds.size === 1 && kinds.has("project-task-injection")) {
    const names = uniqueMetadataStrings(parts, "project-task-injection", "taskName")
    const name = names.length === 1 ? names[0] : undefined
    return name
      ? t("ui.message.injection.projectTaskPrompt", { name })
      : t("ui.message.injection.projectTaskPromptFallback")
  }

  if (kinds.size === 1 && kinds.has("background-task-injection")) {
    const descriptions = uniqueMetadataStrings(parts, "background-task-injection", "description")
    const states = uniqueMetadataStrings(parts, "background-task-injection", "state")
    const description = descriptions.length === 1 ? descriptions[0] : undefined
    const state = states.length === 1 ? states[0] : undefined
    if (state === "completed") {
      return description
        ? t("ui.message.injection.backgroundTaskCompleted", { description })
        : t("ui.message.injection.backgroundTaskCompletedFallback")
    }
    if (state === "error") {
      return description
        ? t("ui.message.injection.backgroundTaskFailed", { description })
        : t("ui.message.injection.backgroundTaskFailedFallback")
    }
  }

  return t("ui.message.injection.prompt")
}

export function injectionSummaryFromText(text: string, t: InjectionTitleTranslator): string {
  return t("ui.message.injection.chars", { count: text.length.toLocaleString() })
}

/** Build a text part payload for a scheduled-task run (backend / tests). */
export function scheduledInjectionPart(input: {
  text: string
  taskID: string
  taskName: string
}): {
  type: "text"
  text: string
  synthetic: true
  metadata: {
    kind: "scheduled-injection"
    taskID: string
    taskName: string
  }
} {
  return {
    type: "text",
    text: input.text,
    synthetic: true,
    metadata: {
      kind: "scheduled-injection",
      taskID: input.taskID,
      taskName: input.taskName,
    },
  }
}

/** Build a text part payload for mounted project-task context (backend / tests). */
export function projectTaskInjectionPart(input: {
  text: string
  taskID: string
  taskName: string
  mode?: "full" | "delta"
}): {
  type: "text"
  text: string
  synthetic: true
  metadata: {
    kind: "project-task-injection"
    taskID: string
    taskName: string
    mode?: "full" | "delta"
  }
} {
  return {
    type: "text",
    text: input.text,
    synthetic: true,
    metadata: {
      kind: "project-task-injection",
      taskID: input.taskID,
      taskName: input.taskName,
      ...(input.mode ? { mode: input.mode } : {}),
    },
  }
}

/** Build a text part payload for a background subagent result (backend / tests). */
export function backgroundTaskInjectionPart(input: {
  text: string
  description: string
  childSessionID: string
  state: "completed" | "error"
}): {
  type: "text"
  text: string
  synthetic: true
  metadata: {
    kind: "background-task-injection"
    description: string
    childSessionID: string
    state: "completed" | "error"
  }
} {
  return {
    type: "text",
    text: input.text,
    synthetic: true,
    metadata: {
      kind: "background-task-injection",
      description: input.description,
      childSessionID: input.childSessionID,
      state: input.state,
    },
  }
}
