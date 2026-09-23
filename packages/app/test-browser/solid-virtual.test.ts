import { expect, test } from "bun:test"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { DeferredMessagePart, type DeferredMessagePartProps } from "../src/pages/session/timeline/deferred-tool-part"
import { Timeline, TimelineRow } from "../src/pages/session/timeline/rows"

test("expanded tool details share virtual measurements without mounting the whole group", () => {
  createRoot((dispose) => {
    const header = new TimelineRow.ToolGroup({
      userMessageID: "user",
      previousAssistantPart: false,
      groups: [
        {
          type: "context",
          key: "context",
          refs: Array.from({ length: 160 }, (_, i) => ({ messageID: "assistant", partID: `part-${i}` })),
        },
      ],
    })
    const [state, setState] = createStore({ open: false })
    const rows = createMemo(() => Timeline.expandToolRows([header], () => state.open))
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return rows().length
      },
      get getItemKey() {
        const items = rows()
        return (index: number) => TimelineRow.key(items[index])
      },
      getScrollElement: () => null,
      estimateSize: (index) => (index === 0 ? 44 : 62),
      initialRect: { width: 800, height: 600 },
      overscan: 3,
    })
    expect(virtualizer.getTotalSize()).toBe(44)
    setState("open", true)
    expect(rows()).toHaveLength(161)
    expect(virtualizer.getVirtualItems().length).toBeLessThan(20)
    virtualizer.resizeItem(1, 200)
    const measured = virtualizer.getTotalSize()
    const key = TimelineRow.key(rows()[1])
    setState("open", false)
    expect(virtualizer.getTotalSize()).toBe(44)
    expect(virtualizer.itemSizeCache.get(key)).toBe(200)
    setState("open", true)
    expect(virtualizer.getTotalSize()).toBe(measured)
    console.info(
      `[tool-group-virtual-test] total=${rows().length} mounted=${virtualizer.getVirtualItems().length} measurementRetained=true`,
    )
    dispose()
  })
})

test("reactive count updates preserve measured row sizes", () => {
  createRoot((dispose) => {
    const [count, setCount] = createSignal(2)
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return count()
      },
      getScrollElement: () => null,
      estimateSize: () => 60,
      initialRect: { width: 800, height: 600 },
    })

    expect(virtualizer.getTotalSize()).toBe(120)
    virtualizer.resizeItem(0, 100)
    expect(virtualizer.getTotalSize()).toBe(160)

    setCount(3)

    expect(virtualizer.itemSizeCache.get(0)).toBe(100)
    expect(virtualizer.getTotalSize()).toBe(220)
    dispose()
  })
})

test("logical scroll offset includes pending measurement adjustments", () => {
  createRoot((dispose) => {
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: 2,
      getScrollElement: () => null,
      estimateSize: () => 60,
      initialOffset: 100,
      initialRect: { width: 800, height: 60 },
    })

    virtualizer.getTotalSize()
    virtualizer.resizeItem(0, 100)

    expect(virtualizer.scrollOffset).toBe(100)
    expect(virtualizer.getLogicalScrollOffset()).toBe(140)
    dispose()
  })
})

test("deferred tool cleanup does not read stale parent control-flow props", () => {
  const part: ToolPart = {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
  const runtime = globalThis as unknown as { React?: { createElement: (...args: unknown[]) => unknown } }
  const previous = runtime.React
  // The component is called directly so only its setup and cleanup execute.
  runtime.React = { createElement: () => null }

  try {
    createRoot((dispose) => {
      let mounted = true
      const props = {
        sessionID: "session-1",
        get part() {
          if (!mounted) throw new Error("stale part read")
          return part
        },
        message: {},
        defaultOpen: false,
      } as DeferredMessagePartProps

      DeferredMessagePart(props)
      mounted = false

      expect(dispose).not.toThrow()
    })
  } finally {
    runtime.React = previous
  }
})
