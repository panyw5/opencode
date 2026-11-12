import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { quickAssistantMessageContent, render, splitInjectedSessionContext } from "./helpers"
import { quickAssistantToolName } from "./tool-label"
import { createQuickAssistantScroll, type QuickAssistantScroll } from "./scroll-controller"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { normalizeWheelDelta } from "@/pages/session/message-gesture"

type Props = {
  list: Message[]
  parts: Record<string, Part[] | undefined> | undefined
  busy: boolean
  waiting: boolean
  fill?: boolean
  scroll?: QuickAssistantScroll
}

export function quickAssistantMessageText(parts: Part[] | undefined) {
  return render(parts)
}

function CopyMessageButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[quick-assistant] copy message length=${props.text.length}`)
    if (!clipboard?.writeText || props.text.length === 0) {
      console.debug(`[quick-assistant] clipboard unavailable or message empty length=${props.text.length}`)
      showToast({ variant: "error", title: "Copy failed" })
      return
    }

    void clipboard.writeText(props.text).then(
      () => {
        console.debug(`[quick-assistant] copied message length=${props.text.length}`)
        setCopied(true)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => setCopied(false), 1_200)
      },
      (error: unknown) => {
        console.debug(`[quick-assistant] copy message failed error=${String(error)}`)
        showToast({ variant: "error", title: "Copy failed" })
      },
    )
  }

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  return (
    <button
      type="button"
      class="inset-control absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak opacity-0 shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base group-hover/message:opacity-100"
      aria-label="Copy message"
      title="Copy message"
      onClick={(event) => {
        event.stopPropagation()
        copy()
      }}
    >
      <Icon name={copied() ? "check" : "copy"} size="small" />
    </button>
  )
}

export function QuickAssistantMessages(props: Props) {
  const language = useLanguage()
  const scroll = props.scroll ?? createQuickAssistantScroll()
  const [view, setView] = createStore<{ viewport?: HTMLDivElement }>({})
  let touchY: number | undefined
  const beforeDomUpdate = (node: HTMLDivElement) => scroll.beforeUpdate(node)
  const selectionChanged = () => {
    const selection = window.getSelection()
    const viewport = view.viewport
    if (
      viewport &&
      selection &&
      !selection.isCollapsed &&
      viewport.contains(selection.anchorNode) &&
      viewport.contains(selection.focusNode) &&
      scroll.following()
    )
      scroll.takeover()
  }
  document.addEventListener("selectionchange", selectionChanged)
  onCleanup(() => document.removeEventListener("selectionchange", selectionChanged))
  createEffect(() => {
    if (props.list.length) return
    scroll.bind(undefined)
    scroll.content(undefined)
    setView("viewport", undefined)
  })
  onCleanup(() => {
    scroll.bind(undefined)
    scroll.content(undefined)
    if (!props.scroll) scroll.dispose()
  })

  return (
    <Show
      when={props.list.length > 0}
      fallback={
        <Show when={props.fill}>
          <div
            data-component="quick-assistant-empty"
            class="min-h-0 flex-1 rounded-t-[calc(var(--radius-4xl)+0.75rem)]"
          />
        </Show>
      }
    >
      <div
        class="relative min-h-0 flex flex-col"
        classList={{
          "flex-1": props.waiting || props.fill,
          "max-h-[calc(100dvh-200px)] shrink": !props.waiting && !props.fill,
        }}
      >
        <ScrollView
          class="min-h-0 flex-1 rounded-t-[calc(var(--radius-4xl)+0.75rem)] [&_[data-slot=scroll-view-viewport]]:px-4 [&_[data-slot=scroll-view-viewport]]:py-4"
          viewportRef={(node) => {
            node.dataset.component = "quick-assistant-viewport"
            node.style.overflowAnchor = "none"
            setView("viewport", node)
            scroll.bind(node)
          }}
          onWheel={(event) =>
            scroll.input(
              normalizeWheelDelta({
                deltaY: event.deltaY,
                deltaMode: event.deltaMode,
                rootHeight: event.currentTarget.clientHeight,
              }),
              event.target,
            )
          }
          onTouchStart={(event) => {
            touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined
          }}
          onTouchMove={(event) => {
            const next = event.touches.length === 1 ? event.touches[0].clientY : undefined
            if (next !== undefined && touchY !== undefined) scroll.input(touchY - next, event.target)
            touchY = next
          }}
          onTouchCancel={() => {
            touchY = undefined
            scroll.endInput()
          }}
          onScrollEnd={() => scroll.endInput()}
          onScrollGeometry={() => scroll.scroll()}
          onScrollInput={(_node, input) => {
            if (input?.delta) scroll.input(input.delta)
            else scroll.takeover()
          }}
          onScrollPosition={(_node, top, input) => scroll.position(top, input.delta)}
          onMouseUp={selectionChanged}
        >
          <div ref={(node) => scroll.content(node)} class="flex flex-col gap-3">
            <For each={props.list}>
              {(item) => {
                const text = createMemo(() => quickAssistantMessageText(props.parts?.[item.id]))
                const content = createMemo(() => quickAssistantMessageContent(props.parts?.[item.id]))
                const display = createMemo(() =>
                  item.role === "user" ? splitInjectedSessionContext(content().text) : { message: content().text },
                )
                const toolLogKey = createMemo(() =>
                  content()
                    .tools.map((tool) => `${tool.id}:${tool.tool}:${tool.state.status}`)
                    .join("|"),
                )
                createEffect(() => {
                  const tools = toolLogKey()
                  if (!tools) return
                  console.debug(`[quick-assistant] tool capsules render message=${item.id} tools=${tools}`)
                })
                createEffect(() => {
                  if (item.role !== "user") return
                  console.debug(
                    `[quick-assistant] user markdown render message=${item.id} length=${display().message.length} context=${!!display().context}`,
                  )
                })
                return (
                  <div
                    data-component="quick-assistant-message"
                    data-message-id={item.id}
                    data-role={item.role}
                    class="flex flex-col gap-2"
                  >
                    <Show when={display().context}>
                      {(context) => (
                        <details
                          data-component="quick-assistant-context"
                          class="group ml-auto w-fit max-w-[calc(100%-2.5rem)] overflow-hidden rounded-[10px] border border-border-weak-base bg-surface-panel/70 open:w-[calc(100%-2.5rem)]"
                          onToggle={(event) =>
                            console.debug(
                              `[quick-assistant] context ${event.currentTarget.open ? "expanded" : "collapsed"} message=${item.id}`,
                            )
                          }
                        >
                          <summary class="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1 text-13-medium text-text-base [&::-webkit-details-marker]:hidden">
                            <Icon name="link" size="small" class="text-icon-weak" />
                            <span class="min-w-0 flex-1 truncate">{language.t("quickAssistant.context.attached")}</span>
                            <Icon
                              name="chevron-down"
                              size="small"
                              class="text-icon-weak transition-transform group-open:rotate-180"
                            />
                          </summary>
                          <div
                            data-scrollable
                            class="max-h-64 overflow-y-auto border-t border-border-weak-base px-3.5 py-3 font-mono text-12-regular leading-5 whitespace-pre-wrap break-all text-text-weak select-text"
                          >
                            {context()}
                          </div>
                        </details>
                      )}
                    </Show>
                    <Show when={display().message || content().tools.length === 0}>
                      <div
                        data-slot="quick-assistant-bubble"
                        classList={{
                          "group/message relative px-3.5 py-3 pr-11": true,
                          "ml-auto w-fit max-w-[min(82%,64ch)] rounded-[18px] border border-border-weak-base bg-surface-panel":
                            item.role === "user",
                          "mr-10 rounded-[20px] border border-border-weaker-base bg-background-stronger":
                            item.role === "assistant",
                        }}
                      >
                        <div class="quick-assistant-markdown break-words text-14-regular text-text-base select-text">
                          <Markdown
                            text={display().message || (item.role === "assistant" && props.busy ? "Thinking..." : "")}
                            math={item.role === "user" ? "full" : "defer"}
                            viewport={view.viewport}
                            anchorBlocks
                            onBeforeDomUpdate={beforeDomUpdate}
                          />
                        </div>
                        <Show when={text().length > 0}>
                          <CopyMessageButton text={text()} />
                        </Show>
                      </div>
                    </Show>
                    <Show when={content().tools.length > 0}>
                      <div
                        data-component="quick-assistant-tools"
                        role="list"
                        aria-label={language.t("quickAssistant.tools")}
                        class="flex min-w-0 flex-wrap items-center gap-1.5 px-1"
                        classList={{ "mr-10": item.role === "assistant", "ml-10": item.role === "user" }}
                      >
                        <For each={content().tools}>
                          {(tool) => {
                            const name = () => quickAssistantToolName(tool.tool, language.t)
                            const status = () => language.t(`quickAssistant.tool.${tool.state.status}`)
                            const detail = () =>
                              tool.state.status === "error"
                                ? tool.state.error
                                : "title" in tool.state
                                  ? tool.state.title
                                  : undefined
                            return (
                              <span
                                data-slot="quick-assistant-tool"
                                data-status={tool.state.status}
                                role="listitem"
                                aria-label={`${name()}: ${status()}`}
                                title={[`${name()}: ${status()}`, detail()].filter(Boolean).join("\n")}
                                class="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-surface-panel/70 px-2.5 py-1 text-12-medium"
                                classList={{
                                  "border-border-weak-base text-text-weak": tool.state.status !== "error",
                                  "border-border-critical-base text-text-critical-base": tool.state.status === "error",
                                }}
                              >
                                <Icon
                                  name={
                                    tool.state.status === "completed"
                                      ? "check-small"
                                      : tool.state.status === "error"
                                        ? "circle-x"
                                        : "arrow-sync"
                                  }
                                  size="small"
                                  classList={{
                                    "motion-safe:animate-spin": tool.state.status === "running",
                                    "text-icon-success-base": tool.state.status === "completed",
                                  }}
                                />
                                <span class="min-w-0 truncate">{name()}</span>
                              </span>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </ScrollView>
        <Show when={scroll.overflow() && scroll.reading()}>
          <button
            type="button"
            data-action="quick-assistant-latest"
            class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base shadow-xs-border"
            onClick={() => scroll.resume()}
          >
            {language.t("session.messages.jumpToLatest")}
          </button>
        </Show>
      </div>
    </Show>
  )
}
