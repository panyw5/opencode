const STASH_SELECTOR = '[data-action="panel-stash"]'

function visibleStashTarget(source: HTMLElement) {
  const surface = source.closest('[data-sidebar-surface], [data-component="sidebar-rail"]')
  const candidates = [
    ...(surface?.querySelectorAll<HTMLElement>(STASH_SELECTOR) ?? []),
    ...document.querySelectorAll<HTMLElement>(STASH_SELECTOR),
  ]
  return candidates.find((candidate) => {
    const rect = candidate.getBoundingClientRect()
    const style = getComputedStyle(candidate)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  })
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export function stashMotionGeometry(source: DOMRect, target: DOMRect) {
  const sourceCenterX = source.left + source.width / 2
  const sourceCenterY = source.top + source.height / 2
  const targetCenterX = target.left + target.width / 2
  const targetCenterY = target.top + target.height / 2
  const scale = Math.max(0.035, Math.min(0.18, target.width / source.width, target.height / source.height))
  return {
    x: targetCenterX - sourceCenterX,
    y: targetCenterY - sourceCenterY,
    scale,
  }
}

/** Fly a visual copy of a panel or dialog into the rail stash button. */
export async function animateToSidebarStash(source?: HTMLElement) {
  if (!source) {
    console.debug("[sidebar-panel-motion] skip reason=missing-source")
    return
  }
  await nextPaint()
  const target = visibleStashTarget(source)
  if (!target) {
    console.debug("[sidebar-panel-motion] skip reason=missing-target")
    return
  }

  const visualSource = source.querySelector<HTMLElement>('[data-slot="dialog-content"]') ?? source
  const sourceRect = visualSource.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  if (!sourceRect.width || !sourceRect.height) {
    console.debug("[sidebar-panel-motion] skip reason=empty-source")
    return
  }

  const motion = stashMotionGeometry(sourceRect, targetRect)
  const clone = source.cloneNode(true) as HTMLElement
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"))
  clone.setAttribute("aria-hidden", "true")
  Object.assign(clone.style, {
    position: "fixed",
    inset: "auto",
    right: "auto",
    bottom: "auto",
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    margin: "0",
    zIndex: "10000",
    pointerEvents: "none",
    overflow: "hidden",
    transformOrigin: "center center",
    willChange: "transform",
  })
  document.body.append(clone)

  source.style.opacity = "0"
  source.style.pointerEvents = "none"
  console.debug(
    `[sidebar-panel-motion] start source=${Math.round(sourceRect.width)}x${Math.round(sourceRect.height)} target=(${Math.round(targetRect.left)},${Math.round(targetRect.top)}) delta=(${Math.round(motion.x)},${Math.round(motion.y)}) scale=${motion.scale.toFixed(3)}`,
  )

  const transform = (progress: number, scale: number) =>
    `translate3d(${motion.x * progress}px, ${motion.y * progress}px, 0) scale(${scale})`

  try {
    const flight = clone.animate(
      [
        { transform: transform(0, 1), offset: 0 },
        {
          transform: transform(0.86, Math.max(motion.scale * 2.4, 0.12)),
          offset: 0.82,
        },
        {
          transform: transform(1, motion.scale),
          offset: 1,
        },
      ],
      { duration: 360, fill: "forwards", easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    )
    await flight.finished
    console.debug("[sidebar-panel-motion] finish")
  } catch (error) {
    console.error(
      `[sidebar-panel-motion] failed error=${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clone.remove()
  }
}
