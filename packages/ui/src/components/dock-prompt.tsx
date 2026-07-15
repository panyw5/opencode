import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "./icon"
import { DockShell, DockTray } from "./dock-surface"

const DURATION_MS = 280
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)"
const panelGeneration = new WeakMap<HTMLElement, number>()

function clearPanelAnimations(el: HTMLElement) {
  for (const animation of el.getAnimations()) animation.cancel()
}

function settlePanel(el: HTMLElement, open: boolean) {
  clearPanelAnimations(el)
  if (open) {
    el.style.height = "auto"
    el.style.opacity = "1"
    el.style.overflow = "visible"
    el.style.pointerEvents = "auto"
    return
  }
  el.style.height = "0px"
  el.style.opacity = "0"
  el.style.overflow = "hidden"
  el.style.pointerEvents = "none"
}

function animatePanel(el: HTMLElement | undefined, open: boolean) {
  if (!el) return

  const generation = (panelGeneration.get(el) ?? 0) + 1
  panelGeneration.set(el, generation)
  clearPanelAnimations(el)

  el.style.overflow = "hidden"
  el.style.pointerEvents = open ? "auto" : "none"

  const finish = (animation: Animation, nextOpen: boolean) => {
    void animation.finished
      .then(() => {
        if (!el.isConnected || panelGeneration.get(el) !== generation) return
        try {
          animation.commitStyles()
        } catch {}
        settlePanel(el, nextOpen)
      })
      .catch(() => undefined)
  }

  if (!open) {
    const start = Math.max(el.getBoundingClientRect().height, el.scrollHeight)
    if (start <= 0) {
      settlePanel(el, false)
      return
    }
    el.style.height = `${start}px`
    el.style.opacity = "1"
    void el.offsetHeight
    const animation = el.animate(
      [
        { height: `${start}px`, opacity: 1 },
        { height: "0px", opacity: 0 },
      ],
      { duration: DURATION_MS, easing: EASING, fill: "forwards" },
    )
    finish(animation, false)
    return
  }

  el.style.height = "auto"
  el.style.opacity = "0"
  const end = Math.max(el.scrollHeight, 1)
  el.style.height = "0px"
  void el.offsetHeight
  const animation = el.animate(
    [
      { height: "0px", opacity: 0 },
      { height: `${end}px`, opacity: 1 },
    ],
    { duration: DURATION_MS, easing: EASING, fill: "forwards" },
  )
  finish(animation, true)
}

export function DockPrompt(props: {
  kind: "question" | "permission"
  header: JSX.Element
  children: JSX.Element
  footer: JSX.Element
  expandLabel?: string
  collapseLabel?: string
  ref?: (el: HTMLDivElement) => void
}) {
  const slot = (name: string) => `${props.kind}-${name}`
  const [collapsed, setCollapsed] = createSignal(false)
  const toggleLabel = () => (collapsed() ? props.expandLabel : props.collapseLabel)
  const fallbackLabel = () => (collapsed() ? "Expand" : "Collapse")

  let contentRef: HTMLDivElement | undefined
  let footerRef: HTMLDivElement | undefined

  const toggle = () => {
    const next = !collapsed()
    animatePanel(contentRef, !next)
    animatePanel(footerRef, !next)
    setCollapsed(next)
  }

  onCleanup(() => {
    contentRef?.getAnimations().forEach((animation) => animation.cancel())
    footerRef?.getAnimations().forEach((animation) => animation.cancel())
  })

  return (
    <div data-component="dock-prompt" data-kind={props.kind} data-collapsed={collapsed()} ref={props.ref}>
      <DockShell data-slot={slot("body")}>
        <div data-slot={slot("header")}>
          {props.header}
          <button
            type="button"
            data-slot="question-collapse"
            data-label={toggleLabel() ? "true" : "false"}
            onClick={toggle}
            aria-expanded={!collapsed()}
            aria-label={toggleLabel() ?? fallbackLabel()}
          >
            <Icon name="chevron-grabber-vertical" size="small" />
            <Show when={toggleLabel()}>{(label) => <span data-slot="question-collapse-label">{label()}</span>}</Show>
          </button>
        </div>
        <div ref={contentRef} data-slot="dock-prompt-content-panel" aria-hidden={collapsed()}>
          <div data-slot={slot("content")}>{props.children}</div>
        </div>
      </DockShell>
      <div ref={footerRef} data-slot="dock-prompt-footer-panel" aria-hidden={collapsed()}>
        <DockTray data-slot={slot("footer")}>{props.footer}</DockTray>
      </div>
    </div>
  )
}
