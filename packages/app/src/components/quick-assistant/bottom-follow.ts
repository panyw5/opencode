type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

export function createBottomFollow() {
  let following = true
  let previousTop = 0
  const maximum = (node: Metrics) => Math.max(0, node.scrollHeight - node.clientHeight)
  return {
    following: () => following,
    reset() {
      following = true
      previousTop = 0
    },
    pause() {
      if (!following) return false
      following = false
      return true
    },
    written(node: Metrics) {
      previousTop = node.scrollTop
    },
    scrolled(node: Metrics) {
      const top = Math.max(0, node.scrollTop)
      const max = maximum(node)
      // Layout shrinkage can clamp scrollTop; only intentional upward movement detaches.
      if (top < Math.min(previousTop, max) - 1) following = false
      else if (max - top <= 8) following = true
      previousTop = top
      return following
    },
  }
}

type WheelEventTarget = Pick<HTMLElement, "addEventListener" | "removeEventListener">
type ResizeObserverTarget = Pick<ResizeObserver, "observe" | "unobserve">

export function observeBottomFollowTargets(
  observer: Pick<ResizeObserver, "observe">,
  viewport: Element,
  content?: Element,
) {
  observer.observe(viewport)
  if (content) observer.observe(content)
}

export function replaceBottomFollowContent<T extends Element>(
  observer: ResizeObserverTarget | undefined,
  previous: T | undefined,
  next: T,
) {
  if (previous === next) return next
  if (previous) observer?.unobserve(previous)
  observer?.observe(next)
  return next
}

export function bindBottomFollowWheel(
  target: WheelEventTarget,
  follow: ReturnType<typeof createBottomFollow>,
  onPause: () => void,
) {
  let active = true
  const listener = (event: WheelEvent) => {
    if (event.deltaY < 0 && follow.pause()) onPause()
  }
  target.addEventListener("wheel", listener, { passive: true })
  return () => {
    if (!active) return
    active = false
    target.removeEventListener("wheel", listener)
  }
}
