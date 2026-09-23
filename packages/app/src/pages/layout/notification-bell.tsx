import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { useNotification } from "@/context/notification"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { Notification } from "@/context/notification-state"
import { BELL_TOAST_TTL_MS, type BellToast } from "@/context/notification-bell-state"

const typeIcon = (type: BellToast["type"]) =>
  type === "error"
    ? "circle-exclamation"
    : type === "question"
      ? "question-mark"
      : type === "permission"
        ? "shield-check"
        : "check-small"

const BELL_SIZE = 40
const TOAST_ENTER_MS = 600
const TOAST_EXIT_MS = 500
const TOAST_GAP = 8
const VIEWPORT_GAP = 16

function formatTime(time: number) {
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

export function NotificationBell() {
  const notification = useNotification()
  const language = useLanguage()
  const navigate = useNavigate()
  const platform = usePlatform()
  const [open, setOpen] = createSignal(false)
  let bellElement: HTMLDivElement | undefined
  let toastLayer: HTMLDivElement | undefined
  const frames = new Set<number>()

  const updateToastPosition = () => {
    if (!bellElement || !toastLayer) return
    const bell = bellElement.getBoundingClientRect()
    const width = toastLayer.offsetWidth
    const centered = bell.left + (bell.width - width) / 2
    const left = Math.max(VIEWPORT_GAP, Math.min(centered, window.innerWidth - width - VIEWPORT_GAP))
    const bottom = window.innerHeight - bell.top + TOAST_GAP
    toastLayer.style.left = `${left}px`
    toastLayer.style.bottom = `${bottom}px`
    toastLayer.style.visibility = "visible"

    const layer = toastLayer.getBoundingClientRect()
    for (const toast of toastLayer.querySelectorAll<HTMLElement>('[data-component="notification-bell-toast"]')) {
      const dx = bell.left + bell.width / 2 - layer.left - toast.offsetLeft - toast.offsetWidth / 2
      const dy = bell.top + bell.height / 2 - layer.top - toast.offsetTop - toast.offsetHeight / 2
      toast.style.setProperty("--bell-dx", `${dx}px`)
      toast.style.setProperty("--bell-dy", `${dy}px`)
      console.debug("[notification-bell] toast origin", { session: toast.dataset.session, dx, dy })
    }
    console.debug("[notification-bell] positioned toasts", { left, bottom, bell: [bell.left, bell.top] })
  }

  const animateToast = (element: HTMLButtonElement, toast: BellToast) => {
    const frame = requestAnimationFrame(() => {
      frames.delete(frame)
      if (!element.isConnected) return
      updateToastPosition()
      const exitDelay = Math.max(0, toast.time + BELL_TOAST_TTL_MS - TOAST_EXIT_MS - Date.now())
      element.style.animation = `bellToastIn ${TOAST_ENTER_MS}ms ease-in-out both, bellToastCollapse ${TOAST_EXIT_MS}ms ease-in-out ${exitDelay}ms forwards`
      console.debug("[notification-bell] animating toast", { id: toast.id, exitDelay })
    })
    frames.add(frame)
  }

  onMount(() => {
    updateToastPosition()
    const observer = new ResizeObserver(updateToastPosition)
    if (bellElement) observer.observe(bellElement)
    const actions = bellElement?.closest('[data-component="floating-actions"]')
    if (actions) observer.observe(actions)
    if (toastLayer) observer.observe(toastLayer)
    window.addEventListener("resize", updateToastPosition)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", updateToastPosition)
      for (const frame of frames) cancelAnimationFrame(frame)
    })
  })

  const unread = createMemo(() => notification.unseenList())
  const count = createMemo(() => notification.unseenTotal())
  const hasError = createMemo(() => notification.unseenHasError())

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
        ref={toastLayer}
        class="pointer-events-none fixed z-[999] flex w-[340px] max-w-[calc(100vw-32px)] flex-col-reverse items-stretch gap-2"
        style={{ visibility: "hidden" }}
      >
        <For each={notification.bell.toasts()}>
          {(toast) => (
            <button
              type="button"
              data-component="notification-bell-toast"
              data-variant={toast.type}
              ref={(element) => animateToast(element, toast)}
              class="pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 text-left shadow-lg backdrop-blur-xl transition-colors"
              classList={{
                "border-border-critical-base/60 bg-surface-critical-weak/80": toast.type === "error",
                "border-border-weak-base bg-surface-raised-base/80": toast.type !== "error",
              }}
              style={{ opacity: 0, "transform-origin": "center center" }}
              data-session={toast.session}
              onAnimationStart={(event) => console.debug("[notification-bell] animation started", { id: toast.id, name: event.animationName })}
              onAnimationEnd={(event) => console.debug("[notification-bell] animation ended", { id: toast.id, name: event.animationName })}
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

      <div class="relative z-30 pointer-events-auto">
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement="top-end"
          class="notification-bell-popover-shell"
          trigger={
            <div ref={bellElement} class="relative" data-component="notification-bell">
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
                    platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(24px) saturate(150%)",
                  "-webkit-backdrop-filter":
                    platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(24px) saturate(150%)",
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
