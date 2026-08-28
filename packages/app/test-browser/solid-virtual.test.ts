import { expect, test } from "bun:test"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createRoot, createSignal } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { DeferredMessagePart, type DeferredMessagePartProps } from "../src/pages/session/timeline/deferred-tool-part"

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
