import { createMemo, Show } from "solid-js"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { useI18n } from "../context/i18n"

export function toolCallStartMs(state: ToolState | undefined): number | undefined {
  if (!state || state.status === "pending") return undefined
  const start = state.time.start
  if (typeof start !== "number" || start <= 0) return undefined
  return start
}

export function formatToolCallTime(start: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(start)
}

export function ToolCallTime(props: { part?: ToolPart }) {
  const i18n = useI18n()
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))
  const titlefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { dateStyle: "medium", timeStyle: "medium" }))

  const start = createMemo(() => toolCallStartMs(props.part?.state))
  const label = createMemo(() => {
    const value = start()
    if (value === undefined) return ""
    return timefmt().format(value)
  })
  const title = createMemo(() => {
    const value = start()
    if (value === undefined) return ""
    return titlefmt().format(value)
  })

  return (
    <Show when={label()}>
      {(value) => (
        <span data-slot="basic-tool-tool-time" title={title()}>
          {value()}
        </span>
      )}
    </Show>
  )
}
