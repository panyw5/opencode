import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Part as MessagePart, type MessagePartProps } from "@opencode-ai/ui/message-part"
import {
  isToolPartHydrated,
  markToolPartHydrated,
  scheduleIdleHydrate,
  shouldDeferToolPart,
  toolHydrationKey,
} from "./deferred-tool-helpers"

/** Fixed skeleton paint — no text, no path, no continuous animation (scroll-friendly). */
const bone = "background-color: color-mix(in oklch, var(--text-weak) 18%, transparent); border-radius: 9999px;"

/**
 * Same outer box as collapsed BasicTool / tool-collapsible
 * (padding 8+8 + trigger 32) so virtual row height stays stable across hydrate.
 * Inner content is neutral gray bars only — no tool labels or paths.
 */
function ToolPartPlaceholder() {
  return (
    <div
      data-component="collapsible"
      class="tool-collapsible"
      data-tool-placeholder="true"
      aria-hidden="true"
    >
      <div data-slot="collapsible-trigger" style={{ "pointer-events": "none" }}>
        <div
          data-slot="tool-skeleton"
          style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            width: "100%",
            height: "32px",
            "min-width": "0",
          }}
        >
          <div
            data-slot="tool-skeleton-icon"
            style={{
              width: "16px",
              height: "16px",
              "flex-shrink": "0",
              "border-radius": "4px",
              "background-color": "color-mix(in oklch, var(--text-weak) 18%, transparent)",
            }}
          />
          <div
            data-slot="tool-skeleton-lines"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "flex": "1 1 auto",
              "min-width": "0",
            }}
          >
            <div style={`width: 64px; height: 10px; flex-shrink: 0; ${bone}`} />
            <div style={`width: min(220px, 45%); height: 8px; flex: 0 1 auto; opacity: 0.75; ${bone}`} />
          </div>
        </div>
      </div>
    </div>
  )
}

export type DeferredMessagePartProps = MessagePartProps & {
  sessionID: string
}

export function DeferredMessagePart(props: DeferredMessagePartProps) {
  const key = () => toolHydrationKey(props.sessionID, props.part.id)
  const deferrable = () => shouldDeferToolPart(props.part, props.defaultOpen)
  const [hydrated, setHydrated] = createSignal(!deferrable() || isToolPartHydrated(key()))

  const hydrate = () => {
    if (hydrated()) return
    markToolPartHydrated(key())
    setHydrated(true)
  }

  createEffect(() => {
    // Live or force-open tools must never stay as a placeholder.
    if (!deferrable()) hydrate()
  })

  onMount(() => {
    if (hydrated()) return
    const cancel = scheduleIdleHydrate(hydrate)
    onCleanup(cancel)
  })

  return (
    <Show
      when={hydrated()}
      fallback={
        <div data-slot="deferred-tool-part" onPointerEnter={hydrate} onFocusIn={hydrate}>
          <ToolPartPlaceholder />
        </div>
      }
    >
      <MessagePart
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        assistantCopyText={props.assistantCopyText}
        turnDurationMs={props.turnDurationMs}
        markdownEager={props.markdownEager}
        markdownViewport={props.markdownViewport}
        markdownHighlight={props.markdownHighlight}
        markdownMath={props.markdownMath}
        markdownStage={props.markdownStage}
        onMarkdownStage={props.onMarkdownStage}
        onBackgroundShell={props.onBackgroundShell}
        onBackgroundTask={props.onBackgroundTask}
      />
    </Show>
  )
}
