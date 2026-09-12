type ScrollRoot = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">

export function liveBottomStep(distance: number, elapsed: number, reducedMotion = false) {
  if (reducedMotion || distance <= 1 || distance > 900) return distance
  const dt = Math.max(0, Math.min(elapsed, 64))
  return Math.min(distance, Math.max(0.5, distance * (1 - Math.exp(-dt / 120))))
}

/** One animation owns follow-scroll; retarget from current geometry every frame. */
export function createLiveBottomFollow<T extends ScrollRoot>(options: {
  root: () => T | undefined
  enabled: () => boolean
  write: (root: T, top: number) => void
  reducedMotion?: () => boolean
  request?: (callback: FrameRequestCallback) => number
  cancel?: (id: number) => void
  log?: (message: string) => void
}) {
  const request = options.request ?? requestAnimationFrame
  const cancel = options.cancel ?? cancelAnimationFrame
  let frame: number | undefined
  let target: T | undefined
  let previous: number | undefined
  let loggedAt = 0

  const stop = (reason = "cancel") => {
    if (frame !== undefined) cancel(frame)
    if (target) options.log?.(`stop reason=${reason}`)
    frame = undefined
    target = undefined
    previous = undefined
  }
  const tick = (time: number) => {
    frame = undefined
    const root = target
    if (!root || options.root() !== root || !options.enabled()) {
      stop("takeover")
      return
    }
    const bottom = Math.max(0, root.scrollHeight - root.clientHeight)
    const gap = bottom - root.scrollTop
    const step = liveBottomStep(gap, previous === undefined ? 1000 / 60 : time - previous, options.reducedMotion?.())
    previous = time
    options.write(root, Math.min(bottom, root.scrollTop + step))
    if (time - loggedAt >= 250) {
      loggedAt = time
      options.log?.(`frame gap=${Math.round(gap)} step=${Math.round(step)}`)
    }
    if (bottom - root.scrollTop <= 1) {
      stop("settled")
      return
    }
    frame = request(tick)
  }
  return {
    follow: () => {
      const root = options.root()
      if (!root || !options.enabled()) return
      if (target && target !== root) stop("root-change")
      if (frame !== undefined || root.scrollHeight - root.clientHeight - root.scrollTop <= 1) return
      target = root
      options.log?.(`start gap=${Math.round(root.scrollHeight - root.clientHeight - root.scrollTop)}`)
      frame = request(tick)
    },
    cancel: stop,
    active: () => target !== undefined,
  }
}
