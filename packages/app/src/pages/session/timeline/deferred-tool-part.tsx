import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Part as MessagePart, type MessagePartProps } from "@opencode-ai/ui/message-part"
import {
  isToolPartHydrated,
  markToolPartHydrated,
  observeToolPartViewport,
  releaseToolPartHydration,
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
  let placeholder: HTMLDivElement | undefined

  // Sample once per mounted part. Hydration can be a hot path during scrolling;
  // synchronous localStorage reads do not belong in each hydration attempt.
  const lagDebug = typeof window !== "undefined" && window.localStorage.getItem("opencode.session.lag.debug") === "1"
  const lagging = () => lagDebug
  const tool = () => (props.part.type === "tool" ? props.part.tool : props.part.type)
  const status = () => (props.part.type === "tool" ? props.part.state.status : "none")
  const logHydrate = (phase: string, source: string, fields = "") => {
    if (!lagging()) return
    console.debug(
      `[lag] tool-hydrate phase=${phase} source=${source} sid=${props.sessionID} part=${props.part.id} tool=${tool()} status=${status()}${fields ? ` ${fields}` : ""}`,
    )
  }

  const hydrate = (source: "focus" | "pointer" | "reactive" | "viewport") => {
    if (hydrated()) return
    stopViewportObserve?.()
    stopViewportObserve = undefined
    const profiling = lagging()
    const started = profiling ? performance.now() : 0
    const row = profiling ? placeholder?.closest<HTMLElement>("[data-timeline-key]") : undefined
    const rowKey = row?.dataset.timelineKey ?? "none"
    const before = row?.getBoundingClientRect().height ?? 0
    if (profiling) logHydrate("start", source, `row=${rowKey} before=${Math.round(before)}`)
    // Interactions and reactive state latch permanently; viewport-driven
    // hydration is released on unmount (see onCleanup).
    markToolPartHydrated(key(), source === "viewport" ? "viewport" : "user")
    setHydrated(true)
    if (!profiling) return
    const committed = performance.now()
    logHydrate("commit", source, `row=${rowKey} sync=${Math.round(committed - started)} before=${Math.round(before)}`)
    requestAnimationFrame(() => {
      const after = row?.isConnected ? row.getBoundingClientRect().height : 0
      const nodes = row?.isConnected ? row.querySelectorAll("*").length : 0
      logHydrate(
        "frame",
        source,
        `row=${rowKey} total=${Math.round(performance.now() - started)} before=${Math.round(before)} after=${Math.round(after)} delta=${Math.round(after - before)} nodes=${nodes}`,
      )
    })
  }

  createEffect(() => {
    // Live or force-open tools must never stay as a placeholder.
    if (!deferrable()) hydrate("reactive")
  })

  let stopViewportObserve: (() => void) | undefined

  onMount(() => {
    if (hydrated()) return
    // Hydrate as the placeholder approaches the viewport (shared observer,
    // 300px margin) instead of eagerly during the idle callback — offscreen
    // rows stay skeletons and cost nothing.
    stopViewportObserve = observeToolPartViewport(placeholder!, () => hydrate("viewport"))
  })

  onCleanup(() => {
    stopViewportObserve?.()
    // Scrolled away: drop a viewport-only hydration so remounts re-enter the
    // cheap placeholder path; user-opened cards stay hydrated forever.
    releaseToolPartHydration(key())
  })

  return (
    <Show
      when={hydrated()}
      fallback={
        <div
          ref={(element) => (placeholder = element)}
          data-slot="deferred-tool-part"
          onPointerDown={() => hydrate("pointer")}
          onFocusIn={() => hydrate("focus")}
        >
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
