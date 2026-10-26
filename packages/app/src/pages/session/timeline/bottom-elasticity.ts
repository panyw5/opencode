import { atPhysicalBottom } from "../use-session-scroll-utils"

type ScrollRoot = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">
type Phase = "pulling" | "settling"

const limit = 20
const idleMs = 80
const settleMs = 250

/** Visual feedback only: never writes scroll position or virtual-list geometry. */
export function createBottomElasticity<T extends ScrollRoot>(options: {
  root: () => T | undefined
  enabled: () => boolean
  write: (root: T, offset: number, phase?: Phase) => void
  request?: (callback: FrameRequestCallback) => number
  cancel?: (id: number) => void
  now?: () => number
}) {
  const request = options.request ?? requestAnimationFrame
  const cancel = options.cancel ?? cancelAnimationFrame
  const now = options.now ?? (() => performance.now())
  let frame: number | undefined
  let target: T | undefined
  let offset = 0
  let lastInput = 0
  let touching = false
  let settling: { start: number; offset: number } | undefined

  const eligible = (root: T) =>
    options.enabled() &&
    root.scrollHeight - root.clientHeight > 1 &&
    atPhysicalBottom({ ...geometry(root), threshold: 1 })

  const stop = () => {
    if (frame !== undefined) cancel(frame)
    if (target) options.write(target, 0)
    frame = undefined
    target = undefined
    offset = 0
    touching = false
    settling = undefined
  }
  const tick = (time: number) => {
    frame = undefined
    const root = target
    if (!root || options.root() !== root || !eligible(root)) {
      stop()
      return
    }
    if (!touching && !settling && time - lastInput >= idleMs) settling = { start: time, offset }
    if (settling) {
      const progress = Math.min(1, Math.max(0, (time - settling.start) / settleMs))
      if (progress === 1) {
        stop()
        return
      }
      offset = settling.offset * (1 - progress) ** 3
    }
    options.write(root, -offset, settling ? "settling" : "pulling")
    frame = request(tick)
  }

  return {
    pull: (delta: number, kind: "wheel" | "touch" = "wheel") => {
      const root = options.root()
      if (!root || !Number.isFinite(delta) || delta <= 0 || !eligible(root)) {
        stop()
        return
      }
      if (target && target !== root) stop()
      target = root
      touching = kind === "touch"
      settling = undefined
      lastInput = now()
      offset += (limit - offset) * (1 - Math.exp(-delta / 160))
      if (frame === undefined) frame = request(tick)
    },
    release: () => {
      touching = false
      if (target) settling = { start: now(), offset }
    },
    cancel: stop,
  }
}

function geometry(root: ScrollRoot) {
  return { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight }
}
