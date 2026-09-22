import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { useNotification } from "@/context/notification"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { Notification } from "@/context/notification-state"
import type { BellToast } from "@/context/notification-bell-state"

const typeIcon = (type: BellToast["type"]) =>
  type === "error"
    ? "circle-exclamation"
    : type === "question"
      ? "question-mark"
      : type === "permission"
        ? "shield-check"
        : "check-small"

const BELL_SIZE = 40
const BELL_CORNER_OFFSET = 20
const BELL_GAP = 8

function formatTime(time: number) {
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function NotificationBell() {
  const notification = useNotification()
  const language = useLanguage()
  const navigate = useNavigate()
  const platform = usePlatform()
  const [open, setOpen] = createSignal(false)

  const unread = createMemo(() => notification.unseenList())
  const count = createMemo(() => notification.unseenTotal())
  const hasError = createMemo(() => notification.unseenHasError())

  // Track the Quick Assistant launcher (fixed right-5 bottom-5 z-40) so the bell
  // can sit on its row, to the horizontal left, whenever it is mounted.
  const [qaAnchor, setQaAnchor] = createSignal<{ left: number; bottom: number; height: number } | null>(null)

  onMount(() => {
    let ro: ResizeObserver | undefined
    const measure = () => {
      const el = document.querySelector<HTMLElement>('[data-component="quick-assistant-launcher"]')
      if (!el || !el.isConnected) {
        setQaAnchor(null)
        ro?.disconnect()
        ro = undefined
        return
      }
      const rect = el.getBoundingClientRect()
      setQaAnchor({ left: rect.left, bottom: window.innerHeight - rect.bottom, height: rect.height })
      if (!ro) {
        ro = new ResizeObserver(measure)
        ro.observe(el)
      }
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener("resize", measure)
    onCleanup(() => {
      mo.disconnect()
      ro?.disconnect()
      window.removeEventListener("resize", measure)
    })
  })

  const bellPosition = createMemo(() => {
    const qa = qaAnchor()
    if (!qa) return { right: `${BELL_CORNER_OFFSET}px`, bottom: `${BELL_CORNER_OFFSET}px` }
    return {
      right: `${Math.max(window.innerWidth - qa.left + BELL_GAP, BELL_CORNER_OFFSET)}px`,
      bottom: `${qa.bottom + (qa.height - BELL_SIZE) / 2}px`,
    }
  })

  const typeLabel = (type: BellToast["type"]) =>
    type === "error"
      ? language.t("notification.bell.type.error")
      : type === "question"
        ? language.t("notification.bell.type.question")
        : type === "permission"
          ? language.t("notification.bell.type.permission")
          : language.t("notification.bell.type.turnComplete")

  const sessionHref = (item: { directory?: string; session?: string }) => {
    if (!item.directory) return undefined
    const base = `/${base64Encode(item.directory)}`
    return item.session ? `${base}/session/${item.session}` : base
  }

  const go = (item: { directory?: string; session?: string }) => {
    const href = sessionHref(item)
    if (!href) return
    if (item.session) notification.session.markViewed(item.session)
    else if (item.directory) notification.project.markViewed(item.directory)
    navigate(href)
    setOpen(false)
  }

  // Resolve session titles for unread rows (cached in the notification context).
  createEffect(() => {
    for (const item of unread()) {
      if (!item.session || !item.directory) continue
      if (notification.titleOf(item.session)) continue
      notification.resolveTitle(item.directory, item.session)
    }
  })

  const rowTitle = (item: Notification) => {
    const title = notification.titleOf(item.session)
    if (title) return title
    if (item.type === "error") {
      const text = typeof item.error === "string" ? item.error : undefined
      if (text) return text
    }
    return language.t("notification.bell.untitledSession")
  }

  return (
    <div class="contents">
      <div
        data-component="notification-bell-toasts"
        class="pointer-events-none fixed right-5 bottom-[106px] z-[999] flex w-[340px] max-w-[calc(100vw-64px)] flex-col items-stretch gap-2"
      >
        <For each={notification.bell.toasts()}>
          {(toast) => (
            <button
              type="button"
              data-component="notification-bell-toast"
              data-variant={toast.type}
              class="pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 text-left shadow-lg backdrop-blur-xl transition-colors"
              classList={{
                "border-border-critical-base/60 bg-surface-critical-weak/80": toast.type === "error",
                "border-border-weak-base bg-surface-raised-base/80": toast.type !== "error",
              }}
              style={{ animation: "bellToastIn 180ms ease-out, bellToastCollapse 260ms ease-in 4720ms forwards" }}
              data-session={toast.session}
              onClick={() => {
                notification.bell.dismiss(toast.id)
                go(toast)
              }}
            >
              <Icon
                name={typeIcon(toast.type)}
                class="size-4 shrink-0"
                classList={{
                  "text-text-critical-base": toast.type === "error",
                  "text-text-interactive-base": toast.type !== "error",
                }}
              />
              <span class="shrink-0 text-12-medium text-text-weak">{typeLabel(toast.type)}</span>
              <span class="shrink-0 text-12-regular text-text-weak">·</span>
              <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">
                {toast.title ?? language.t("notification.bell.untitledSession")}
              </span>
            </button>
          )}
        </For>
      </div>

      {/* When the Quick Assistant launcher is mounted, sit on its row to the
          horizontal left; otherwise take the bottom-right corner. z-30 keeps the
          bell under the expanded Quick Assistant panel (z-40). */}
      <div class="fixed z-30" style={bellPosition()}>
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement="top-end"
          class="notification-bell-popover-shell"
          trigger={
            <div class="relative" data-component="notification-bell">
              <button
                type="button"
                data-action="notification-bell"
                aria-label={language.t("notification.bell.title")}
                class="flex items-center justify-center rounded-full border border-border-weak-base shadow-[var(--shadow-lg-border-base)] transition-colors hover:bg-surface-base-hover"
                style={{
                  width: `${BELL_SIZE}px`,
                  height: `${BELL_SIZE}px`,
                  "background-color":
                    platform.platform === "desktop" && platform.os === "windows"
                      ? "var(--surface-raised-stronger-non-alpha)"
                      : "color-mix(in srgb, var(--background-stronger) 92%, transparent)",
                  "backdrop-filter":
                    platform.platform === "desktop" && platform.os === "windows"
                      ? "none"
                      : "blur(24px) saturate(150%)",
                  "-webkit-backdrop-filter":
                    platform.platform === "desktop" && platform.os === "windows"
                      ? "none"
                      : "blur(24px) saturate(150%)",
                }}
              >
                <Icon name="bell" class="size-[22px] text-icon-base" />
              </button>
              <Show when={count() > 0}>
                <span
                  data-component="notification-bell-badge"
                  data-variant={hasError() ? "error" : "default"}
                  class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-medium text-background-base"
                  classList={{
                    "bg-text-diff-delete-base": hasError(),
                    "bg-text-interactive-base": !hasError(),
                  }}
                >
                  {count() > 99 ? "99+" : count()}
                </span>
              </Show>
            </div>
          }
        >
          <div
            data-component="notification-bell-popover"
            class="flex max-h-[360px] w-[320px] max-w-[calc(100vw-32px)] flex-col overflow-hidden"
          >
            <div class="flex shrink-0 items-center justify-between border-b border-border-weak-base px-3 py-2">
              <span class="text-13-medium text-text-strong">{language.t("notification.bell.title")}</span>
              <Show when={count() > 0}>
                <button
                  type="button"
                  data-action="notification-mark-all-read"
                  class="text-12-regular text-text-weak transition-colors hover:text-text-base"
                  onClick={() => notification.markAllViewed()}
                >
                  {language.t("notification.bell.markAllRead")}
                </button>
              </Show>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto p-1">
              <Show
                when={unread().length > 0}
                fallback={
                  <div class="px-3 py-8 text-center text-13-regular text-text-weak">
                    {language.t("notification.bell.empty")}
                  </div>
                }
              >
                <For each={unread()}>
                  {(item) => (
                    <button
                      type="button"
                      data-component="notification-bell-item"
                      data-variant={item.type}
                      data-session={item.session}
                      class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-base-hover"
                      onClick={() => go(item)}
                    >
                      <Icon
                        name={typeIcon(item.type)}
                        class="size-4 shrink-0"
                        classList={{
                          "text-text-critical-base": item.type === "error",
                          "text-text-interactive-base": item.type !== "error",
                        }}
                      />
                      <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">{rowTitle(item)}</span>
                      <span class="shrink-0 text-11-regular text-text-weak">{formatTime(item.time)}</span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Popover>
      </div>
    </div>
  )
}
