import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export type SessionContentGap = { left: number; right: number; measured: boolean }

// Tracks the horizontal gap between the session panel edges and the centered
// content column. Elements that *are* the column (every constrained timeline
// row frame, plus the composer column which is present on every session
// route) carry data-session-content-column; layout-only rows such as the
// full-bleed TurnGap spacer are unmarked, so they can never be mistaken for
// the column when the virtualizer makes them the first DOM element.
//
// The user-message rail, the floating status pill, and the bottom-right
// floating actions use this to size themselves against the space that is
// actually free instead of assuming a fixed margin.
export function createSessionContentGap(
  host: Accessor<HTMLElement | undefined>,
  selector = "[data-session-content-column]",
) {
  const [gap, setGap] = createSignal<SessionContentGap>({ left: 0, right: 0, measured: false })
  let row: HTMLElement | undefined

  const rowObserver = new ResizeObserver(() => measure())
  const hostObserver = new ResizeObserver(() => measure())
  const mutations = new MutationObserver(() => measure())

  function measure() {
    const el = host()
    if (!el) return
    if (row && (!row.isConnected || row.getBoundingClientRect().width === 0)) row = undefined
    // Virtualized scrolling constantly swaps which row is first in the DOM, so
    // re-pick the first *rendered* match whenever the tracked row goes away.
    let target = row
    if (!target) {
      for (const candidate of el.querySelectorAll<HTMLElement>(selector)) {
        if (candidate.getBoundingClientRect().width > 0) {
          target = candidate
          break
        }
      }
    }
    if (target !== row) {
      if (row) rowObserver.unobserve(row)
      row = target
      if (row) rowObserver.observe(row)
    }
    const box = el.getBoundingClientRect()
    if (!target) {
      setGap((prev) => (prev.measured ? { left: 0, right: 0, measured: false } : prev))
      return
    }
    const rect = target.getBoundingClientRect()
    const left = Math.max(0, rect.left - box.left)
    const right = Math.max(0, box.right - rect.right)
    setGap((prev) => {
      if (prev.measured && prev.left === left && prev.right === right) return prev
      console.debug(`[session-content-gap] left=${String(Math.round(left))} right=${String(Math.round(right))}`)
      return { left, right, measured: true }
    })
  }

  createEffect(() => {
    const el = host()
    if (!el) return
    hostObserver.observe(el)
    mutations.observe(el, { childList: true, subtree: true })
    measure()
    onCleanup(() => {
      hostObserver.unobserve(el)
      mutations.disconnect()
    })
  })

  onCleanup(() => {
    hostObserver.disconnect()
    rowObserver.disconnect()
    mutations.disconnect()
  })

  return gap
}
