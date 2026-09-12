import { expect, test } from "bun:test"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createRoot } from "solid-js"
import { createLiveBottomFollow } from "../src/pages/session/timeline/live-bottom"
import { shouldAdjustVirtualScroll } from "../src/pages/session/timeline/measure"
import { createScrollLedger } from "../src/pages/session/timeline/scroll-ledger"

test("virtual measurement commits leave streaming movement to the animation owner", () => {
  createRoot((dispose) => {
    const root = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 20,
      getScrollElement: () => null,
      estimateSize: () => 50,
      initialRect: { width: 800, height: 300 },
      initialOffset: 700,
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      shouldAdjustVirtualScroll({
        itemEnd: item.end,
        scrollOffset: instance.getLogicalScrollOffset(),
        bottomAnchored: true,
        initializing: false,
        animatedBottom: true,
      })
    const ledger = createScrollLedger({ initialTop: root.scrollTop })
    let callback: FrameRequestCallback | undefined
    const follow = createLiveBottomFollow({
      root: () => root,
      enabled: () => true,
      request: (next) => {
        callback = next
        return 1
      },
      cancel: () => (callback = undefined),
      write: (root, top) => {
        ledger.recordWrite(root.scrollTop, top, "bottom")
        root.scrollTop = top
      },
    })
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(19, 70)
    virtualizer.resizeItem(0, 70)
    root.scrollHeight = virtualizer.getTotalSize()
    expect(root.scrollHeight).toBe(1040)
    expect(virtualizer.getLogicalScrollOffset()).toBe(700)
    follow.follow()
    follow.follow()
    callback!(16)
    expect(root.scrollTop).toBeGreaterThan(700)
    expect(root.scrollTop).toBeLessThan(740)
    expect(ledger.observe(root.scrollTop).userDisplacement).toBe(0)
    for (let time = 32; callback && time < 1000; time += 16) {
      const next = callback
      callback = undefined
      next(time)
    }
    expect(740 - root.scrollTop).toBeLessThanOrEqual(1)
    expect(follow.active()).toBe(false)
    console.debug(`[live-bottom-test] virtual-height=${root.scrollHeight} final-top=${root.scrollTop}`)
    dispose()
  })
})
