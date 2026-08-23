import { onCleanup, onMount, splitProps, type ComponentProps, Show, mergeProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"

/**
 * ScrollView component with custom scrollbar thumb and keyboard navigation.
 * 
 * Features:
 * - Custom scrollbar thumb (4px wide, only visible on hover/drag)
 * - Hides native scrollbar completely
 * - Keyboard navigation (PageUp/Down, Home/End, Arrow keys)
 * - ResizeObserver for automatic thumb size/position updates
 * - Drag-to-scroll support
 * 
 * Use cases:
 * - When you need a custom-styled scrollbar (e.g., session-review diff panel)
 * - When native scrollbar doesn't fit the design
 * 
 * NOT for:
 * - Simple lists (use List component with native scrollbar instead)
 * - When native scrollbar is acceptable (lighter weight)
 * 
 * Architecture:
 * - Uses data-component/data-slot naming (not BEM classes)
 * - Independent from List component (different scroll strategies)
 */

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  orientation?: "vertical" | "horizontal"
  /** Optional cached geometry for virtual scrollers; avoids forced layout on every scroll frame. */
  scrollContentHeight?: number
  scrollViewportHeight?: number
  /** Precomputed scroll geometry delivered before the optional native-style onScroll callback. */
  onScrollGeometry?: (
    geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
    event: Event & { currentTarget: HTMLDivElement },
  ) => void
}

export function scrollThumbGeometry(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  trackPadding?: number
  minThumbHeight?: number
}) {
  if (input.scrollHeight <= input.clientHeight || input.scrollHeight === 0) return
  const trackPadding = input.trackPadding ?? 8
  const trackHeight = input.clientHeight - trackPadding * 2
  const height = Math.max((input.clientHeight / input.scrollHeight) * trackHeight, input.minThumbHeight ?? 32)
  const maxScrollTop = input.scrollHeight - input.clientHeight
  const maxThumbTop = trackHeight - height
  const top = maxScrollTop > 0 ? (input.scrollTop / maxScrollTop) * maxThumbTop : 0
  return {
    height,
    top: trackPadding + Math.max(0, Math.min(top, maxThumbTop)),
  }
}

export function scrollEventGeometry(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  cachedScrollHeight?: number
  cachedClientHeight?: number
}) {
  return {
    // scrollTop is cheap to read and must come from the event target. A
    // virtualizer offset can lag a compensating DOM scroll by one event and
    // make the timeline mistake that delta for user input.
    scrollTop: input.scrollTop,
    scrollHeight: input.cachedScrollHeight ?? input.scrollHeight,
    clientHeight: input.cachedClientHeight ?? input.clientHeight,
  }
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
  }
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const lagDebug = typeof window !== "undefined" && window.localStorage.getItem("opencode.session.lag.debug") === "1"
  const trace = (phase: string, fields: string) => {
    if (!lagDebug) return
    const target = window as Window & { __opencodeScrollViewDebug?: string[] }
    const entries = (target.__opencodeScrollViewDebug ??= [])
    entries.push(`${Math.round(performance.now())} phase=${phase} ${fields}`)
    if (entries.length > 2000) entries.splice(0, entries.length - 2000)
  }
  const merged = mergeProps({ orientation: "vertical" }, props)
  const [local, events, rest] = splitProps(
    merged,
    [
      "class",
      "children",
      "viewportRef",
      "orientation",
      "style",
      "scrollContentHeight",
      "scrollViewportHeight",
      "onScrollGeometry",
    ],
    [
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let rootRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement
  let thumbRef!: HTMLDivElement

  const [state, setState] = createStore({
    isHovered: false,
    isDragging: false,
    thumbHeight: 0,
    thumbTop: 0,
    showThumb: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.isDragging
  const thumbHeight = () => state.thumbHeight
  const thumbTop = () => state.thumbTop
  const showThumb = () => state.showThumb

  let rafId: number | null = null
  let latestScrollTop = 0

  const updateThumb = () => {
    if (!viewportRef) return
    const started = lagDebug ? performance.now() : 0
    const scrollHeight = local.scrollContentHeight ?? viewportRef.scrollHeight
    const clientHeight = local.scrollViewportHeight ?? viewportRef.clientHeight
    const geometry = scrollThumbGeometry({ scrollTop: latestScrollTop, scrollHeight, clientHeight })
    if (!geometry) {
      if (state.showThumb) {
        setState("showThumb", false)
      }
      return
    }

    // Only update if values actually changed (with small threshold to avoid floating point issues)
    const heightChanged = Math.abs(state.thumbHeight - geometry.height) > 0.5
    const topChanged = Math.abs(state.thumbTop - geometry.top) > 0.5
    const showChanged = !state.showThumb

    if (heightChanged || topChanged || showChanged) {
      setState({
        showThumb: true,
        thumbHeight: geometry.height,
        thumbTop: geometry.top,
      })
    }
    if (lagDebug) {
      trace(
        "thumb",
        `cachedContent=${String(local.scrollContentHeight !== undefined)} cachedViewport=${String(local.scrollViewportHeight !== undefined)} top=${Math.round(latestScrollTop)} height=${Math.round(scrollHeight)} client=${Math.round(clientHeight)} duration=${Math.round((performance.now() - started) * 10) / 10}`,
      )
    }
  }

  const scheduleUpdateThumb = (scrollTop?: number) => {
    if (scrollTop !== undefined) latestScrollTop = scrollTop
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
    }
    rafId = requestAnimationFrame(() => {
      rafId = null
      updateThumb()
    })
  }

  onMount(() => {
    latestScrollTop = viewportRef.scrollTop
    if (local.viewportRef) {
      local.viewportRef(viewportRef)
    }

    const observer = new ResizeObserver(() => {
      trace("resize", `scheduled=${String(rafId !== null)}`)
      scheduleUpdateThumb()
    })

    observer.observe(viewportRef)
    // Also observe the first child if possible to catch content changes
    if (viewportRef.firstElementChild) {
      observer.observe(viewportRef.firstElementChild)
    }

    onCleanup(() => {
      observer.disconnect()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    })

    scheduleUpdateThumb()
  })

  let startY = 0
  let startScrollTop = 0

  const onThumbPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState("isDragging", true)
    startY = e.clientY
    startScrollTop = viewportRef.scrollTop

    thumbRef.setPointerCapture(e.pointerId)

    const onPointerMove = (e: PointerEvent) => {
      const deltaY = e.clientY - startY
      const { scrollHeight, clientHeight } = viewportRef
      const maxScrollTop = scrollHeight - clientHeight
      const maxThumbTop = clientHeight - thumbHeight()

      if (maxThumbTop > 0) {
        const scrollDelta = deltaY * (maxScrollTop / maxThumbTop)
        viewportRef.scrollTop = startScrollTop + scrollDelta
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      setState("isDragging", false)
      thumbRef.releasePointerCapture(e.pointerId)
      thumbRef.removeEventListener("pointermove", onPointerMove)
      thumbRef.removeEventListener("pointerup", onPointerUp)
    }

    thumbRef.addEventListener("pointermove", onPointerMove)
    thumbRef.addEventListener("pointerup", onPointerUp)
  }

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    // If user is focused on an input inside the scroll view, don't hijack keys
    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      return
    }

    const next = scrollKey(e)
    if (!next) return

    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior: "smooth" })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior: "smooth" })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior: "smooth" })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior: "smooth" })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior: "smooth" })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior: "smooth" })
        break
    }
  }

  return (
    <div
      ref={rootRef}
      data-component="scroll-view"
      class={local.class}
      style={local.style}
      onPointerEnter={() => setState("isHovered", true)}
      onPointerLeave={() => setState("isHovered", false)}
      {...rest}
    >
      <div
        ref={viewportRef}
        data-slot="scroll-view-viewport"
        onScroll={(e) => {
          const started = lagDebug ? performance.now() : 0
          const geometry = scrollEventGeometry({
            scrollTop: e.currentTarget.scrollTop,
            scrollHeight: local.scrollContentHeight ?? e.currentTarget.scrollHeight,
            clientHeight: local.scrollViewportHeight ?? e.currentTarget.clientHeight,
            cachedScrollHeight: local.scrollContentHeight,
            cachedClientHeight: local.scrollViewportHeight,
          })
          scheduleUpdateThumb(geometry.scrollTop)
          local.onScrollGeometry?.(geometry, e)
          if (typeof events.onScroll === "function") events.onScroll(e as any)
          if (lagDebug) trace("scroll", `duration=${Math.round((performance.now() - started) * 10) / 10}`)
        }}
        onWheel={events.onWheel as any}
        onTouchStart={events.onTouchStart as any}
        onTouchMove={events.onTouchMove as any}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={events.onPointerDown as any}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
         aria-label={i18n.t("ui.scrollView.ariaLabel")}
         // Virtualized callers own scroll compensation. Native scroll anchoring
         // otherwise changes scrollTop behind the virtualizer when a row settles.
         style={{ "overflow-anchor": "none" }}
         onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      <Show when={showThumb()}>
        <div
          ref={thumbRef}
          onPointerDown={onThumbPointerDown}
          data-slot="scroll-view-thumb"
          data-visible={isHovered() || isDragging()}
          data-dragging={isDragging()}
          style={{
            height: `${thumbHeight()}px`,
            transform: `translateY(${thumbTop()}px)`,
            "z-index": 100,
          }}
        />
      </Show>
    </div>
  )
}
