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
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    console.debug("[sidebar-panel-motion] skip reason=reduced-motion")
    return
  }

  await nextPaint()
  const target = visibleStashTarget(source)
  if (!target) {
    console.debug("[sidebar-panel-motion] skip reason=missing-target")
    return
  }

  const sourceRect = source.getBoundingClientRect()
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
    left: `${sourceRect.left}px`,
    top: `${sourceRect.top}px`,
    width: `${sourceRect.width}px`,
    height: `${sourceRect.height}px`,
    margin: "0",
    zIndex: "10000",
    pointerEvents: "none",
    overflow: "hidden",
    transformOrigin: "center center",
    willChange: "transform, opacity, filter",
  })
  document.body.append(clone)

  const previousOpacity = source.style.opacity
  const previousPointerEvents = source.style.pointerEvents
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
        { transform: transform(0, 1), opacity: 1, filter: "blur(0px)", offset: 0 },
        {
          transform: transform(1.025, motion.scale * 0.76),
          opacity: 0.82,
          filter: "blur(0px)",
          offset: 0.72,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        },
        {
          transform: transform(0.985, motion.scale * 1.2),
          opacity: 0.58,
          filter: "blur(0.6px)",
          offset: 0.86,
          easing: "cubic-bezier(0.34, 1.35, 0.64, 1)",
        },
        {
          transform: transform(1, motion.scale),
          opacity: 0,
          filter: "blur(2px)",
          offset: 1,
        },
      ],
      { duration: 560, fill: "forwards", easing: "linear" },
    )
    const pulse = target.animate(
      [
        { transform: "scale(1)", offset: 0 },
        { transform: "scale(1.16)", offset: 0.45 },
        { transform: "scale(0.96)", offset: 0.72 },
        { transform: "scale(1)", offset: 1 },
      ],
      { delay: 390, duration: 330, easing: "cubic-bezier(0.22, 1.25, 0.36, 1)" },
    )
    await Promise.allSettled([flight.finished, pulse.finished])
    console.debug("[sidebar-panel-motion] finish")
  } catch (error) {
    console.error(
      `[sidebar-panel-motion] failed error=${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clone.remove()
    source.style.opacity = previousOpacity
    source.style.pointerEvents = previousPointerEvents
  }
}
