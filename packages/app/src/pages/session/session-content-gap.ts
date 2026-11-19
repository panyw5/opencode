import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export type SessionContentGap = { left: number; right: number }

// Tracks the horizontal gap between the session panel edges and the centered
// timeline column. The user-message rail and the floating status pill use
// this to size themselves against the space that is actually free instead of
// assuming a fixed margin.
export function createSessionContentGap(host: Accessor<HTMLElement | undefined>) {
  const [gap, setGap] = createSignal<SessionContentGap>({ left: 0, right: 0 })
  let row: HTMLElement | undefined

  const rowObserver = new ResizeObserver(() => measure())
  const hostObserver = new ResizeObserver(() => measure())
  const mutations = new MutationObserver(() => measure())

  function measure() {
    const el = host()
    if (!el) return
    if (row && !row.isConnected) row = undefined
    const target = row ?? el.querySelector<HTMLElement>("[data-timeline-row]") ?? undefined
    if (target !== row) {
      if (row) rowObserver.unobserve(row)
      row = target
      if (row) rowObserver.observe(row)
    }
    const box = el.getBoundingClientRect()
    if (!target) {
      setGap((prev) => (prev.left === 0 && prev.right === 0 ? prev : { left: 0, right: 0 }))
      return
    }
    const rect = target.getBoundingClientRect()
    const left = Math.max(0, rect.left - box.left)
    const right = Math.max(0, box.right - rect.right)
    setGap((prev) => {
      if (prev.left === left && prev.right === right) return prev
      console.debug(`[session-content-gap] left=${String(Math.round(left))} right=${String(Math.round(right))}`)
      return { left, right }
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
