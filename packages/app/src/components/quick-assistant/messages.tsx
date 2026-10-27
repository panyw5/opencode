import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { quickAssistantMessageContent, render, splitInjectedSessionContext } from "./helpers"
import { quickAssistantToolName } from "./tool-label"
import { createQuickAssistantReadingAnchor } from "./reading-anchor"
import {
  bindBottomFollowWheel,
  createBottomFollow,
  observeBottomFollowTargets,
  replaceBottomFollowContent,
} from "./bottom-follow"

type Props = {
  list: Message[]
  parts: Record<string, Part[] | undefined> | undefined
  busy: boolean
  waiting: boolean
  fill?: boolean
}

export function quickAssistantMessageText(parts: Part[] | undefined) {
  return render(parts)
}

function CopyMessageButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug("[quick-assistant] copy message", { length: props.text.length })
    if (!clipboard?.writeText || props.text.length === 0) {
      console.debug("[quick-assistant] clipboard unavailable or message empty", { length: props.text.length })
      showToast({ variant: "error", title: "Copy failed" })
      return
    }

    void clipboard.writeText(props.text).then(
      () => {
        console.debug("[quick-assistant] copied message", { length: props.text.length })
        setCopied(true)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => setCopied(false), 1_200)
      },
      (error: unknown) => {
        console.debug("[quick-assistant] copy message failed", { error })
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
      class="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak opacity-0 shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base group-hover/message:opacity-100"
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
  let viewport: HTMLDivElement | undefined
  const [view, setView] = createStore<{ viewport?: HTMLDivElement }>({})
  const follow = createBottomFollow()
  const anchor = createQuickAssistantReadingAnchor({
    viewport: () => viewport,
    following: follow.following,
    written: (node) => follow.written(node),
    log: (message) => console.debug(message),
  })
  let readingSnapshot: ReturnType<typeof anchor.snapshot>
  const beforeDomUpdate = (node: HTMLDivElement) => {
    const restore = anchor.beforeUpdate(node)
    return () => {
      restore()
      readingSnapshot = anchor.snapshot()
    }
  }
  const readingTakeover = (reason: string) => {
    if (!follow.pause()) return
    readingSnapshot = anchor.snapshot()
    console.debug(`[quick-assistant] bottom-follow paused reason=${reason}`)
  }
  let frame: number | undefined
  let observer: ResizeObserver | undefined
  let content: HTMLDivElement | undefined
  let removeWheelListener: (() => void) | undefined

  const detachViewport = (clearContent = true) => {
    if (viewport) console.debug("[quick-assistant] bottom-follow viewport detached")
    removeWheelListener?.()
    removeWheelListener = undefined
    observer?.disconnect()
    observer = undefined
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
    viewport = undefined
    setView("viewport", undefined)
    anchor.reset()
    readingSnapshot = undefined
    if (clearContent) content = undefined
  }

  const scrollKey = createMemo(() =>
    props.list
      .map((item) => {
        const text = quickAssistantMessageText(props.parts?.[item.id])
        const completed = "completed" in item.time ? (item.time.completed ?? "") : ""
        return `${item.id}:${item.role}:${text.length}:${completed}`
      })
      .join("|"),
  )

  const scheduleBottomFollow = (reason: string) => {
    if (!follow.following() || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!follow.following() || !viewport) return
      const before = viewport.scrollTop
      viewport.scrollTop = viewport.scrollHeight
      follow.written(viewport)
      readingSnapshot = anchor.snapshot()
      if (Math.abs(viewport.scrollTop - before) > 1) {
        console.debug(
          `[quick-assistant] bottom-follow write reason=${reason} from=${before} to=${viewport.scrollTop} height=${viewport.scrollHeight} client=${viewport.clientHeight}`,
        )
      }
    })
  }

  createEffect(() => {
    if (props.list.length === 0) {
      follow.reset()
      detachViewport()
    }
    scrollKey()
    props.busy
    scheduleBottomFollow("messages")
  })

  onCleanup(detachViewport)

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
        ref={(node) => {
          detachViewport(false)
          viewport = node
          setView("viewport", node)
          follow.reset()
          observer = new ResizeObserver((entries) => {
            console.debug(
              `[quick-assistant] layout resize following=${follow.following()} targets=${entries.map((entry) => `${entry.target === node ? "viewport" : "content"}:${Math.round(entry.contentRect.height)}`).join(",")}`,
            )
            if (!follow.following() && readingSnapshot) anchor.restoreSnapshot(readingSnapshot)
            readingSnapshot = anchor.snapshot()
            scheduleBottomFollow("resize")
          })
          observeBottomFollowTargets(observer, node, content)
          removeWheelListener = bindBottomFollowWheel(node, follow, () => {
            readingSnapshot = anchor.snapshot()
            console.debug("[quick-assistant] bottom-follow paused wheel-up")
          })
          console.debug("[quick-assistant] bottom-follow mounted")
          scheduleBottomFollow("mount")
        }}
        data-component="quick-assistant-viewport"
        style={{ "overflow-anchor": "none" }}
        class="min-h-0 overflow-y-auto rounded-t-[calc(var(--radius-4xl)+0.75rem)] px-4 py-4"
        classList={{
          "flex-1": props.waiting || props.fill,
          "max-h-[calc(100dvh-200px)] shrink": !props.waiting && !props.fill,
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "touch" || event.target === event.currentTarget) readingTakeover("pointer")
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
          if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
            readingTakeover("keyboard")
          }
        }}
        onScroll={(event) => {
          const before = follow.following()
          if (!anchor.scrolled(event.currentTarget)) {
            follow.scrolled(event.currentTarget)
            readingSnapshot = anchor.snapshot()
          }
          if (before !== follow.following()) {
            console.debug(`[quick-assistant] bottom-follow ${follow.following() ? "resumed" : "paused"}`)
          }
        }}
      >
        <div
          ref={(node) => {
            content = replaceBottomFollowContent(observer, content, node)
          }}
          class="flex flex-col gap-3"
        >
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
                console.debug("[quick-assistant] tool capsules render", {
                  messageID: item.id,
                  tools,
                })
              })
              createEffect(() => {
                if (item.role !== "user") return
                console.debug("[quick-assistant] user markdown render", {
                  messageID: item.id,
                  length: display().message.length,
                  context: !!display().context,
                })
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
                        class="group ml-10 overflow-hidden rounded-[16px] border border-border-weak-base bg-surface-panel/70"
                        onToggle={(event) =>
                          console.debug(
                            `[quick-assistant] context ${event.currentTarget.open ? "expanded" : "collapsed"} message=${item.id}`,
                          )
                        }
                      >
                        <summary class="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-13-medium text-text-base [&::-webkit-details-marker]:hidden">
                          <Icon name="link" size="small" class="text-icon-weak" />
                          <span class="flex-1">{language.t("quickAssistant.context.attached")}</span>
                          <Icon
                            name="chevron-down"
                            size="small"
                            class="text-icon-weak transition-transform group-open:rotate-180"
                          />
                        </summary>
                        <div class="max-h-64 overflow-y-auto border-t border-border-weak-base px-3.5 py-3 font-mono text-12-regular leading-5 whitespace-pre-wrap break-all text-text-weak select-text">
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
                        "ml-10 rounded-[18px] border border-border-weak-base bg-surface-panel": item.role === "user",
                        "mr-10 rounded-[20px] border border-border-weaker-base bg-background-stronger":
                          item.role === "assistant",
                      }}
                    >
                      <div class="quick-assistant-markdown break-words text-[15px] leading-7 text-text-base select-text">
                        <Markdown
                          text={display().message || (item.role === "assistant" && props.busy ? "Thinking..." : "")}
                          math={item.role === "user" ? "full" : "defer"}
                          viewport={view.viewport}
                          anchorBlocks
                          onBeforeDomUpdate={beforeDomUpdate}
                          onStage={(_, stage) => {
                            console.debug(
                              `[quick-assistant] markdown stage message=${item.id} role=${item.role} stage=${stage ?? "unmounted"}`,
                            )
                          }}
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
      </div>
    </Show>
  )
}
