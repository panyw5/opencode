export type ScrollOrigin = "user" | "navigation" | "layout" | "initial" | "bottom"

export type ScrollRuntime = {
  write(root: Pick<HTMLElement, "scrollTop">, origin: ScrollOrigin, callback: () => void): void
  rebase(top: number): void
}

export type ScrollObservation = {
  top: number
  displacement: number
  compensationDelta: number
  userDisplacement: number
  velocity: number
  fast: boolean
}

export type ScrollLedger = {
  recordWrite(before: number, after: number, origin: ScrollOrigin): void
  observe(top: number, input?: { user?: boolean }): ScrollObservation
  rebase(top: number): void
  reset(top?: number): void
  snapshot(): {
    top: number
    systemCompensation: number
    layoutCompensation: number
    velocity: number
    lastObservedAt: number | undefined
  }
  velocity(): number
  isFast(): boolean
}

export function createScrollLedger(
  options: {
    now?: () => number
    fastSpeed?: number
    fastWindowMs?: number
    idleGapMs?: number
    smoothing?: number
    initialTop?: number
  } = {},
): ScrollLedger {
  const now = options.now ?? (() => performance.now())
  const fastSpeed = options.fastSpeed ?? 1.5
  const fastWindowMs = options.fastWindowMs ?? 140
  const idleGapMs = options.idleGapMs ?? 300
  const smoothing = options.smoothing ?? 0.3

  let top = options.initialTop ?? 0
  let systemCompensation = 0
  let layoutCompensation = 0
  let anchorCompensation = 0
  let lastObservedAt: number | undefined
  let speed = 0

  const clearVelocity = (at?: number) => {
    speed = 0
    lastObservedAt = at
  }

  const rebase = (nextTop: number) => {
    top = nextTop
    anchorCompensation = systemCompensation
    clearVelocity(now())
  }

  const recordWrite = (before: number, after: number, origin: ScrollOrigin) => {
    // The caller supplies the actual positions around the write. Never use a
    // requested target: layout can clamp or coalesce a programmatic scroll.
    const delta = after - before
    if (!Number.isFinite(delta) || delta === 0) return
    if (origin !== "user") systemCompensation += delta
    if (origin === "layout") layoutCompensation += delta
    if (origin === "navigation" || origin === "initial" || origin === "bottom") rebase(after)
  }

  const observe = (nextTop: number, input: { user?: boolean } = {}): ScrollObservation => {
    const at = now()
    const displacement = nextTop - top
    const compensationDelta = systemCompensation - anchorCompensation
    // Subtract the full known write delta. Net displacement can have the
    // opposite sign when a user reverses direction before the native event.
    const userDisplacement = displacement - compensationDelta
    const user = input.user === true
    const dt = lastObservedAt === undefined ? 0 : at - lastObservedAt

    // Ignore sub-frame samples; they are commonly duplicate/coalesced native
    // events and would otherwise create a velocity spike.
    if (!user || dt <= 2 || dt > idleGapMs) {
      clearVelocity(at)
    } else if (userDisplacement !== 0) {
      const measured = Math.abs(userDisplacement) / dt
      speed = speed * (1 - smoothing) + measured * smoothing
      lastObservedAt = at
    }

    top = nextTop
    anchorCompensation = systemCompensation
    if (user && dt > 0 && dt <= idleGapMs && userDisplacement === 0) lastObservedAt = at
    const age = lastObservedAt === undefined ? Infinity : at - lastObservedAt
    return {
      top: nextTop,
      displacement,
      compensationDelta,
      userDisplacement,
      velocity: speed,
      fast: speed > fastSpeed && age < fastWindowMs,
    }
  }

  return {
    recordWrite,
    observe,
    rebase,
    reset(nextTop = 0) {
      systemCompensation = 0
      layoutCompensation = 0
      rebase(nextTop)
    },
    snapshot: () => ({ top, systemCompensation, layoutCompensation, velocity: speed, lastObservedAt }),
    velocity: () => speed,
    isFast: () => {
      const age = lastObservedAt === undefined ? Infinity : now() - lastObservedAt
      return speed > fastSpeed && age < fastWindowMs
    },
  }
}
