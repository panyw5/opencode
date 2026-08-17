import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { render } from "./helpers"

type Props = {
  list: Message[]
  parts: Record<string, Part[] | undefined> | undefined
  busy: boolean
}

const BOTTOM_GAP = 8

export function quickAssistantMessageText(parts: Part[] | undefined) {
  return render(parts)
}

function isAtBottom(node: HTMLDivElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_GAP
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
  let viewport: HTMLDivElement | undefined
  let followBottom = true
  let frame: number | undefined

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
    if (!followBottom) return
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!followBottom || !viewport) return
        viewport.scrollTop = viewport.scrollHeight
      })
    })
  }

  createEffect(() => {
    if (props.list.length === 0) followBottom = true
    scrollKey()
    props.busy
    scheduleBottomFollow()
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return (
    <Show when={props.list.length > 0}>
      <div
        ref={(node) => {
          viewport = node
          scheduleBottomFollow()
        }}
        class="max-h-[48vh] overflow-y-auto border-b border-border-weak-base bg-background-base/20 px-4 py-4"
        onScroll={(event) => {
          followBottom = isAtBottom(event.currentTarget)
        }}
      >
        <div class="flex flex-col gap-3">
          <For each={props.list}>
            {(item) => {
              const text = createMemo(() => quickAssistantMessageText(props.parts?.[item.id]))
              return (
                <div
                  data-component="quick-assistant-message"
                  data-role={item.role}
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
                        {text()}
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
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
