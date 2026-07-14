import { Show, createSignal, onCleanup, type JSX } from "solid-js"
import { Icon } from "./icon"
import { DockShell, DockTray } from "./dock-surface"

const DURATION_MS = 280
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)"

function animatePanel(el: HTMLElement | undefined, open: boolean) {
  if (!el) return

  for (const animation of el.getAnimations()) animation.cancel()

  el.style.overflow = "hidden"
  el.style.pointerEvents = open ? "auto" : "none"

  if (!open) {
    const start = Math.max(el.getBoundingClientRect().height, el.scrollHeight)
    if (start <= 0) {
      el.style.height = "0px"
      el.style.opacity = "0"
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
    void animation.finished
      .then(() => {
        if (!el.isConnected) return
        el.style.height = "0px"
        el.style.opacity = "0"
      })
      .catch(() => undefined)
    return
  }

  el.style.height = "0px"
  el.style.opacity = "0"
  void el.offsetHeight
  const end = Math.max(el.scrollHeight, 1)
  const animation = el.animate(
    [
      { height: "0px", opacity: 0 },
      { height: `${end}px`, opacity: 1 },
    ],
    { duration: DURATION_MS, easing: EASING, fill: "forwards" },
  )
  void animation.finished
    .then(() => {
      if (!el.isConnected) return
      el.style.height = "auto"
      el.style.opacity = "1"
      el.style.overflow = "visible"
    })
    .catch(() => undefined)
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
