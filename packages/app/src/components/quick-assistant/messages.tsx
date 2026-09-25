import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { render, splitInjectedSessionContext } from "./helpers"
import { createBottomFollow } from "./bottom-follow"

type Props = {
  list: Message[]
  parts: Record<string, Part[] | undefined> | undefined
  busy: boolean
  waiting: boolean
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
  const follow = createBottomFollow()
  let frame: number | undefined
  let observer: ResizeObserver | undefined
  let content: HTMLDivElement | undefined

  const scrollKey = createMemo(() =>
    props.list
      .map((item) => {
        const text = quickAssistantMessageText(props.parts?.[item.id])
        const completed = "completed" in item.time ? (item.time.completed ?? "") : ""
        return `${item.id}:${item.role}:${text.length}:${completed}`
      })
      .join("|"),
  )

  const scheduleBottomFollow = () => {
    if (!follow.following() || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!follow.following() || !viewport) return
      viewport.scrollTop = viewport.scrollHeight
      follow.written(viewport)
    })
  }

  createEffect(() => {
    if (props.list.length === 0) follow.reset()
    scrollKey()
    props.busy
    scheduleBottomFollow()
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    observer?.disconnect()
  })

  return (
    <Show when={props.list.length > 0}>
      <div
        ref={(node) => {
          viewport = node
          follow.reset()
          observer?.disconnect()
          observer = new ResizeObserver(() => {
            scheduleBottomFollow()
          })
          observer.observe(node)
          if (content) observer.observe(content)
          console.debug("[quick-assistant] bottom-follow mounted")
          scheduleBottomFollow()
        }}
        data-component="quick-assistant-viewport"
        style={{ "overflow-anchor": "none" }}
        class="min-h-0 overflow-y-auto bg-background-base/20 px-4 py-4"
        classList={{
          "flex-1": props.waiting,
          "max-h-[calc(100dvh-200px)] shrink": !props.waiting,
        }}
        onScroll={(event) => {
          const before = follow.following()
          follow.scrolled(event.currentTarget)
          if (before !== follow.following()) {
            console.debug(`[quick-assistant] bottom-follow ${follow.following() ? "resumed" : "paused"}`)
          }
        }}
        onWheel={(event) => {
          if (event.deltaY >= 0) return
          follow.pause()
          console.debug("[quick-assistant] bottom-follow paused wheel-up")
        }}
      >
        <div
          ref={(node) => {
            content = node
            observer?.observe(node)
          }}
          class="flex flex-col gap-3"
        >
          <For each={props.list}>
            {(item) => {
              const text = createMemo(() => quickAssistantMessageText(props.parts?.[item.id]))
              const display = createMemo(() =>
                item.role === "user" ? splitInjectedSessionContext(text()) : { message: text() },
              )
              return (
                <div data-component="quick-assistant-message" data-role={item.role} class="flex flex-col gap-2">
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
                        <div class="max-h-64 overflow-y-auto border-t border-border-weak-base px-3.5 py-3 font-mono text-12-regular leading-5 whitespace-pre-wrap break-all text-text-weak">
                          {context()}
                        </div>
                      </details>
                    )}
                  </Show>
                  <div
                    data-slot="quick-assistant-bubble"
                    classList={{
                      "group/message relative px-3.5 py-3 pr-11": true,
                      "ml-10 rounded-[18px] border border-border-weak-base bg-surface-panel": item.role === "user",
                      "mr-10 rounded-[20px] border border-border-weaker-base bg-background-stronger":
                        item.role === "assistant",
                    }}
                  >
                    <Show
                      when={item.role === "assistant"}
                      fallback={
                        <div class="whitespace-pre-wrap break-words text-[15px] leading-7 text-text-strong">
                          {display().message}
                        </div>
                      }
                    >
                      <div class="quick-assistant-markdown text-[15px] leading-7 text-text-base">
                        <Markdown text={text() || (props.busy ? "Thinking..." : "")} math="defer" />
                      </div>
                    </Show>
                    <Show when={text().length > 0}>
                      <CopyMessageButton text={text()} />
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
