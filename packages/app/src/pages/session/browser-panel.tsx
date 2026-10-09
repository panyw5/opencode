import { Index, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useSessionLayout } from "@/pages/session/session-layout"
import { GPT_PRO_PARTITION } from "@opencode-ai/util/gpt-pro"
import { OPEN_TAB_EVENT, type BrowserTab } from "@/browser/tabs"
import { createBrowserDisplay } from "@/browser/display"
import { browserOverlay } from "@/browser/overlays"
import { CLOSE_BROWSER_TAB_COMMAND } from "@/browser/close-tab"

export { browserApi } from "@/browser/types"
export type { WindowBrowserApi, BrowserBounds, BrowserPresentation, BrowserViewState } from "@/browser/types"
export { BROWSER_PARTITION, AGENT_PARTITION_PREFIX, pickFallback } from "@/browser/tabs"

export function openInBrowserTab(url: string) {
  window.dispatchEvent(new CustomEvent(OPEN_TAB_EVENT, { detail: url }))
}

export function BrowserPanel(props: { class?: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const layout = useLayout()
  const dialog = useDialog()
  const command = useCommand()
  const { view } = useSessionLayout()
  const service = layout.browserTabs
  const api = service.api
  const { active, address, setAddress, activeAgent, activeUserTab, go, addUserTab } = service
  const setActive = service.activate
  const tabs = createMemo(service.tabs)
  const opened = createMemo(() => view().browser.opened())
  const closeUserTab = service.close
  const closeAgentTab = (partition: string) => {
    service.close(partition)
    setConfirmClose(undefined)
  }
  let placeholder: HTMLDivElement | undefined
  const [preview, setPreview] = createStore({ partition: "", image: "" })

  const display = createBrowserDisplay({
    api,
    read: () => {
      const tab = tabs().find((tab) => tab.partition === active())
      if (!opened() || !placeholder?.isConnected || !tab?.state?.epoch) return { partition: null, bounds: null }
      const rect = placeholder.getBoundingClientRect()
      const x = Math.max(0, Math.ceil(rect.left))
      const y = Math.max(0, Math.ceil(rect.top))
      const width = Math.floor(Math.min(window.innerWidth, rect.right)) - x
      const height = Math.floor(Math.min(window.innerHeight, rect.bottom)) - y
      if (width < 2 || height < 2) return { partition: null, bounds: null }
      const bounds = { x, y, width, height }
      return { partition: active(), bounds, overlay: dialog.active ? "dialog" : browserOverlay(bounds) }
    },
    shown: () => service.acknowledge(service.presentation()),
    preview: async (partition, image) => {
      const decoded = new Image()
      decoded.src = image
      await decoded.decode()
      setPreview({ partition, image })
      // Paint the decoded DOM replacement before hiding the native surface.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    },
  })
  let frame: number | undefined
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      display.sync()
    })
  }
  createEffect(() => {
    opened()
    active()
    tabs()
    dialog.active
    service.presentation()
    display.sync()
  })
  onMount(() => {
    display.start()
    if (!placeholder) return
    const observer = new ResizeObserver(schedule)
    observer.observe(placeholder)
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "data-expanded", "data-closed", "data-state"],
    })
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    onCleanup(() => {
      observer.disconnect()
      overlays.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
    })
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    display.dispose()
  })

  const [confirm, setConfirm] = createStore({ partition: undefined as string | undefined })
  const confirmClose = () => confirm.partition
  const setConfirmClose = (partition: string | undefined) => setConfirm("partition", partition)
  command.register(() => [
    {
      id: CLOSE_BROWSER_TAB_COMMAND,
      title: language.t("panel.browser.closeTab"),
      category: language.t("command.browser.toggle"),
      disabled: !opened() || tabs().length === 0,
      onSelect: () => {
        const tab = tabs().find((tab) => tab.partition === active())
        if (!opened() || dialog.active || !tab) {
          console.debug("[browser-tab-close] skipped reason=unavailable")
          return
        }
        console.debug(`[browser-tab-close] requested partition=${tab.partition} agent=${tab.agent}`)
        if (tab.agent) setConfirmClose(tab.partition)
        else closeUserTab(tab.partition)
      },
    },
  ])
  let capsuleRef: HTMLDivElement | undefined
  // Dismiss the capsule on Escape or any pointer press outside of it.
  createEffect(() => {
    if (!confirmClose()) return
    const dismiss = (e: PointerEvent) => {
      if (capsuleRef?.contains(e.target as Node)) return
      setConfirmClose(undefined)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmClose(undefined)
    }
    window.addEventListener("pointerdown", dismiss, true)
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("pointerdown", dismiss, true)
      window.removeEventListener("keydown", onKey)
    })
  })

  const tabLabel = (tab: BrowserTab) => {
    if (tab.partition === GPT_PRO_PARTITION) return "gpt-pro"
    // Interstitial pages (e.g. Google /sorry) expose their URL as the title —
    // fall back to the hostname so the tab never shows a raw URL. Chromium's
    // about:blank page literally titles itself "about:blank" — treat that as
    // empty so the blank tab shows the static label.
    const title = tab.state?.title?.trim()
    if (title && title !== "about:blank" && !/^https?:\/\//i.test(title)) return title
    try {
      const parsed = new URL(tab.state?.url ?? "")
      // file:// URLs have no hostname — show the file name instead.
      if (parsed.protocol === "file:") {
        const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "")
        if (name) return name
      }
      if (parsed.hostname && parsed.hostname !== "about:blank") return parsed.hostname
    } catch {
      // not a URL — fall through to the static label
    }
    return tab.agent ? language.t("panel.browser.agentTab") : language.t("panel.browser.tab")
  }

  return (
    <Show when={api}>
      <div
        id="browser-panel"
        role="region"
        aria-label={language.t("command.browser.toggle")}
        aria-hidden={!opened()}
        inert={!opened()}
        tabIndex={-1}
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button, input, [role=button]")) return
          event.currentTarget.focus({ preventScroll: true })
        }}
        class={props.class}
        classList={{
          "relative size-full min-w-0 flex flex-col overflow-hidden bg-background-stronger": true,
          "pointer-events-none": !opened(),
        }}
      >
        <div class="flex flex-col flex-1 min-h-0">
          <div class="relative flex h-7 shrink-0 items-center gap-1 px-2 bg-background-base">
            {/* Agent-tab close confirmation capsule. Must live in the tab-strip
                row: the native WebContentsView always paints ABOVE the DOM, so
                any overlay inside the placeholder container (the region the
                view mirrors) is invisible behind the web page. The strip row is
                the only DOM-only band of the panel. */}
            <Show when={confirmClose()} keyed>
              {(partition) => (
                <div
                  ref={capsuleRef}
                  class="absolute left-1/2 top-1/2 z-10 flex max-w-[calc(100%-8px)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-border-weak-base bg-surface-inset-base py-0.5 pl-3 pr-1 text-12-regular shadow-md"
                >
                  <span class="truncate text-text-strong">{language.t("panel.browser.closeAgentConfirm")}</span>
                  <button
                    type="button"
                    onClick={() => closeAgentTab(partition)}
                    class="shrink-0 rounded-full border border-border-weak-base bg-surface-base px-2.5 py-0.5 text-text-strong transition-colors hover:bg-surface-inset-base"
                  >
                    {language.t("panel.browser.closeAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClose(undefined)}
                    class="shrink-0 rounded-full px-2 py-0.5 text-text-weak transition-colors hover:text-text-strong"
                  >
                    {language.t("common.cancel")}
                  </button>
                </div>
              )}
            </Show>
            {/* Index (not For): tabs() re-maps Object.entries into fresh
                objects on every state event, and For diffs by reference —
                it would tear down and rebuild every tab button (a click can
                straddle mousedown/mouseup across nodes mid-load). Index
                reuses DOM by position and re-runs the reactive expressions. */}
            <Index each={tabs()}>
              {(tab) => (
                <button
                  type="button"
                  aria-pressed={active() === tab().partition}
                  onClick={() => setActive(tab().partition)}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return
                    if (tab().agent) setConfirmClose(tab().partition)
                    else closeUserTab(tab().partition)
                  }}
                  title={
                    tab().agent
                      ? `${language.t("panel.browser.agentTab")} · ${tab().state?.url ?? ""}`
                      : tab().state?.url
                  }
                  class="group/tab flex h-6 min-w-0 max-w-56 cursor-pointer select-none items-center gap-1.5 rounded-md pl-2 text-12-regular outline-none transition-[background-color,color,transform] duration-150 active:scale-[0.97] focus-visible:ring-1 focus-visible:ring-border-strong-base"
                  classList={{
                    "pr-2": tab().agent,
                    "pr-1": !tab().agent,
                    "bg-surface-interactive-weak": active() === tab().partition && !tab().agent,
                    "text-text-strong": active() === tab().partition,
                    "text-text-weak hover:bg-surface-inset-base hover:text-text-strong": active() !== tab().partition,
                  }}
                  style={
                    tab().agent
                      ? {
                          color: "var(--surface-brand-base)",
                          "background-color":
                            active() === tab().partition
                              ? "color-mix(in srgb, var(--surface-brand-base) 14%, transparent)"
                              : undefined,
                        }
                      : undefined
                  }
                >
                  {/* Leading slot: a spinner while the page loads (tab-level
                      loading feedback), otherwise the brand dot for agent tabs.
                      A fresh empty tab only loads about:blank — nothing worth
                      waiting for, and a spinner flash there reads as jitter. */}
                  <Show
                    when={
                      tab().state?.loading === true && tab().state?.url !== "about:blank" && tab().state?.url !== ""
                    }
                    fallback={
                      <Show when={tab().agent}>
                        <span
                          class="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ "background-color": "var(--surface-brand-base)" }}
                        />
                      </Show>
                    }
                  >
                    <Spinner
                      class="size-3 shrink-0"
                      style={tab().agent ? { color: "var(--surface-brand-base)" } : undefined}
                    />
                  </Show>
                  <span class="truncate">{tabLabel(tab())}</span>
                  <span
                    role="button"
                    aria-label={language.t("panel.browser.closeTab")}
                    title={language.t("panel.browser.closeTab")}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (tab().agent) setConfirmClose(tab().partition)
                      else closeUserTab(tab().partition)
                    }}
                    class="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-text-weak transition-[opacity,background-color,color,transform] duration-100 hover:bg-background-base hover:text-text-strong active:scale-90"
                    classList={{
                      "opacity-0 group-hover/tab:opacity-100": active() !== tab().partition,
                    }}
                  >
                    <Icon name="close-small" size="small" />
                  </span>
                </button>
              )}
            </Index>
            <IconButton
              icon="plus-small"
              variant="ghost"
              class="h-5 w-5 shrink-0"
              onClick={() => addUserTab()}
              aria-label={language.t("panel.browser.newTab")}
            />
          </div>
          <div class="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-border-weaker-base bg-background-base">
            <IconButton
              icon="arrow-left"
              variant="ghost"
              disabled={!activeUserTab()}
              onClick={() => activeUserTab() && void api!.navigate(active(), "back")}
              aria-label={language.t("panel.browser.back")}
            />
            <IconButton
              icon="arrow-right"
              variant="ghost"
              disabled={!activeUserTab()}
              onClick={() => activeUserTab() && void api!.navigate(active(), "forward")}
              aria-label={language.t("panel.browser.forward")}
            />
            <IconButton
              icon="refresh-small"
              variant="ghost"
              disabled={!activeUserTab()}
              onClick={() => activeUserTab() && void api!.navigate(active(), "reload")}
              aria-label={language.t("panel.browser.reload")}
            />
            <input
              type="text"
              value={address()}
              readonly={activeAgent()}
              onInput={(e) => setAddress(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go(e.currentTarget.value)
              }}
              placeholder={language.t("panel.browser.addressPlaceholder")}
              spellcheck={false}
              autocomplete="off"
              class="flex-1 min-w-0 h-7 px-2 rounded-md bg-surface-base text-13-regular text-text-strong placeholder:text-text-weak outline-none focus:ring-1 focus:ring-border-strong-base"
              classList={{ "text-text-weak": activeAgent() }}
            />
            <Show when={active() === GPT_PRO_PARTITION && platform.gptPro}>
              <IconButton
                icon="globe"
                variant="ghost"
                aria-label={language.t("gptPro.login")}
                title={language.t("gptPro.login")}
                onClick={() => {
                  console.debug("[browser-panel] gpt-pro default-browser login requested")
                  void platform
                    .gptPro!.loginInBrowser()
                    .catch(() => console.warn("[browser-panel] login could not be opened"))
                }}
              />
            </Show>
            <IconButton
              icon="close-small"
              variant="ghost"
              onClick={() => view().browser.close()}
              aria-label={language.t("common.close")}
            />
          </div>
          <div class="flex-1 min-h-0 relative">
            <div ref={placeholder} class="absolute inset-0" data-browser-placeholder={active()}>
              <Show when={preview.partition === active() && preview.image}>
                <img
                  data-browser-preview={preview.partition}
                  src={preview.image}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  class="size-full pointer-events-none select-none"
                />
              </Show>
            </div>
            <Show when={tabs().length === 0}>
              <div class="absolute inset-0 flex items-center justify-center text-13-regular text-text-weak pointer-events-none">
                {language.t("panel.browser.empty")}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
