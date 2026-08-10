import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Part as MessagePart, type MessagePartProps } from "@opencode-ai/ui/message-part"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  isToolPartHydrated,
  markToolPartHydrated,
  scheduleIdleHydrate,
  shouldDeferToolPart,
  toolHydrationKey,
  toolPlaceholderCopy,
} from "./deferred-tool-helpers"

/**
 * Same outer box as collapsed BasicTool / tool-collapsible:
 * padding 8+8 + trigger 32 (+ 1px borders from CSS) so measure stays stable across hydrate.
 */
function ToolPartPlaceholder(props: { part: ToolPart }) {
  const copy = () => toolPlaceholderCopy(props.part)
  return (
    <div
      data-component="collapsible"
      class="tool-collapsible"
      data-tool-placeholder="true"
      data-tool={props.part.tool}
      aria-hidden="true"
    >
      <div data-slot="collapsible-trigger">
        <div data-component="tool-trigger">
          <div data-slot="basic-tool-tool-trigger-content">
            <div data-slot="basic-tool-tool-indicator" />
            <div data-slot="basic-tool-tool-info">
              <div data-slot="basic-tool-tool-info-structured">
                <div data-slot="basic-tool-tool-info-main">
                  <span data-slot="basic-tool-tool-title" class="tool-exec">
                    {copy().title}
                  </span>
                  <Show when={copy().subtitle}>
                    {(subtitle) => <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                  </Show>
                </div>
              </div>
            </div>
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
        <div
          data-slot="deferred-tool-part"
          onPointerEnter={hydrate}
          onFocusIn={hydrate}
        >
          <ToolPartPlaceholder part={props.part as ToolPart} />
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
