import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import {
  captureViewportAnchor,
  heightFromResizeObserverEntry,
  partMeasurementKey,
  restoreViewportAnchor,
  rowContentVersion,
  sameVirtualItemGeometry,
  snapshotVirtualItems,
  shouldAdjustVirtualScroll,
  shouldCommitVirtualRowHeight,
  shouldEaseLiveBottom,
  timelineContentVersion,
  timelineMeasurementsMatchWidth,
  timelineRowContentVisibility,
  virtualRowOverflow,
} from "./measure"

test("treats replacement virtual items with unchanged geometry as equal", () => {
  const previous = { key: "row-1", index: 4, start: 240, size: 60 }

  expect(sameVirtualItemGeometry(previous, { ...previous })).toBe(true)
  expect(sameVirtualItemGeometry(previous, { ...previous, start: 241 })).toBe(false)
  expect(sameVirtualItemGeometry(previous, { ...previous, size: 61 })).toBe(false)
  expect(sameVirtualItemGeometry(previous, { ...previous, index: 5 })).toBe(false)
})

test("keeps virtual row keys and lookups on the same snapshot", () => {
  const first = { key: "row-a", index: 0, start: 0, size: 60 }
  const second = { key: 2, index: 1, start: 60, size: 80 }
  const snapshot = snapshotVirtualItems([undefined, first, second])

  expect(snapshot.keys).toEqual(["row-a", "2"])
  expect(snapshot.byKey.get("row-a")).toBe(first)
  expect(snapshot.byKey.get("2")).toBe(second)
  expect(snapshot.byKey.get("missing")).toBeUndefined()
})

test("does not clip a row while its DOM height is ahead of the virtualizer", () => {
  expect(virtualRowOverflow(60, 60)).toBe("clip")
  expect(virtualRowOverflow(60.5, 60)).toBe("clip")
  expect(virtualRowOverflow(60.6, 60)).toBe("visible")
})

test("reads height from a resize entry border box without layout work", () => {
  expect(heightFromResizeObserverEntry({ borderBoxSize: [{ blockSize: 62.4 }] })).toBe(62.4)
  expect(heightFromResizeObserverEntry({ borderBoxSize: { blockSize: 48 } as never })).toBe(48)
})

test("falls back to the content rect when the border box is missing", () => {
  expect(heightFromResizeObserverEntry({ contentRect: { height: 44 } })).toBe(44)
})

test("rejects unusable resize entries so callers fall back to an explicit read", () => {
  expect(heightFromResizeObserverEntry(undefined)).toBeUndefined()
  expect(heightFromResizeObserverEntry({})).toBeUndefined()
  expect(heightFromResizeObserverEntry({ borderBoxSize: [{ blockSize: 0 }], contentRect: { height: 0 } })).toBeUndefined()
})

function rectOf(top: number, bottom: number) {
  return () =>
    ({
      top,
      bottom,
      height: bottom - top,
      width: 100,
      left: 0,
      right: 100,
      x: 0,
      y: top,
      toJSON() {
        return {}
      },
    }) as DOMRect
}

test("captures the row spanning the viewport top as the anchor", () => {
  const root = document.createElement("div")
  root.getBoundingClientRect = rectOf(0, 800)
  const above = document.createElement("div")
  above.getBoundingClientRect = rectOf(-200, -100)
  const spanning = document.createElement("div")
  spanning.dataset.timelineKey = "row-spanning"
  spanning.getBoundingClientRect = rectOf(-40, 300)
  const below = document.createElement("div")
  below.getBoundingClientRect = rectOf(300, 500)

  const anchor = captureViewportAnchor(root, [above, spanning, below])
  expect(anchor).toEqual({ key: "row-spanning", offset: -40 })
})

test("falls back to the first row below the viewport top between rows", () => {
  const root = document.createElement("div")
  root.getBoundingClientRect = rectOf(0, 800)
  const gap = document.createElement("div")
  gap.dataset.timelineKey = "row-below"
  gap.getBoundingClientRect = rectOf(24, 200)

  const anchor = captureViewportAnchor(root, [gap])
  expect(anchor).toEqual({ key: "row-below", offset: 24 })
})

test("returns no anchor when no mounted row is at or below the top", () => {
  const root = document.createElement("div")
  root.getBoundingClientRect = rectOf(0, 800)
  const above = document.createElement("div")
  above.dataset.timelineKey = "row-above"
  above.getBoundingClientRect = rectOf(-300, -100)

  expect(captureViewportAnchor(root, [above])).toBeUndefined()
})

test("restores the anchor offset and reports the applied delta", () => {
  const root = document.createElement("div")
  root.getBoundingClientRect = rectOf(0, 800)
  let top = -40
  const element = document.createElement("div")
  document.body.append(element)
  element.getBoundingClientRect = () => rectOf(top, top + 340)()

  const delta = restoreViewportAnchor({
    root,
    anchor: { key: "row-spanning", offset: -40 },
    elementByKey: (key) => (key === "row-spanning" ? element : undefined),
  })
  // Row drifted 30px down; scrollTop is adjusted by the same amount.
  top = -10
  const applied = restoreViewportAnchor({
    root,
    anchor: { key: "row-spanning", offset: -40 },
    elementByKey: () => element,
  })
  expect(delta).toBe(0)
  expect(applied).toBe(30)
  expect(root.scrollTop).toBe(30)
  element.remove()
})

test("restore is a no-op inside tolerance and for missing anchors", () => {
  const root = document.createElement("div")
  root.getBoundingClientRect = rectOf(0, 800)
  const element = document.createElement("div")
  document.body.append(element)
  element.getBoundingClientRect = rectOf(-40.4, 300)

  expect(
    restoreViewportAnchor({ root, anchor: { key: "k", offset: -40 }, elementByKey: () => element }),
  ).toBe(0)
  expect(
    restoreViewportAnchor({ root, anchor: { key: "gone", offset: 0 }, elementByKey: () => undefined }),
  ).toBe(0)
  expect(root.scrollTop).toBe(0)
  element.remove()
})

test("keeps a bottom-anchored stream pinned as its last row grows", () => {
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 600, scrollOffset: 500, bottomAnchored: true, initializing: false }),
  ).toBe(true)
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 600, scrollOffset: 500, bottomAnchored: true, initializing: true }),
  ).toBe(false)
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 400, scrollOffset: 500, bottomAnchored: false, initializing: false }),
  ).toBe(true)
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 600, scrollOffset: 500, bottomAnchored: false, initializing: false }),
  ).toBe(false)
})

test("adjusts a row fully above the viewport when it grows into it", () => {
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 400, scrollOffset: 500, bottomAnchored: false, initializing: false }),
  ).toBe(true)
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 500, scrollOffset: 500, bottomAnchored: false, initializing: false }),
  ).toBe(true)
})

test("does not push the viewport when a scrolled-away streaming row grows", () => {
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 900, scrollOffset: 400, bottomAnchored: false, initializing: false }),
  ).toBe(false)
  expect(
    shouldAdjustVirtualScroll({ itemEnd: 400, scrollOffset: 400, bottomAnchored: false, initializing: false }),
  ).toBe(true)
})

test("does not contain the active or last streaming row", () => {
  expect(timelineRowContentVisibility({ index: 4, activeIndex: 4, lastIndex: 7 })).toBe("visible")
  expect(timelineRowContentVisibility({ index: 7, activeIndex: 4, lastIndex: 7 })).toBe("visible")
  expect(timelineRowContentVisibility({ index: 3, activeIndex: 4, lastIndex: 7 })).toBe("auto")
  expect(timelineRowContentVisibility({ index: 7, activeIndex: undefined, lastIndex: 7 })).toBe("visible")
})

test("snaps small live bottom deltas and eases only mid-size jumps", () => {
  expect(shouldEaseLiveBottom(16, { min: 64, max: 900 })).toBe(false)
  expect(shouldEaseLiveBottom(64, { min: 64, max: 900 })).toBe(false)
  expect(shouldEaseLiveBottom(80, { min: 64, max: 900 })).toBe(true)
  expect(shouldEaseLiveBottom(901, { min: 64, max: 900 })).toBe(false)
})

test("does not shrink a live row from a transient short measure", () => {
  expect(shouldCommitVirtualRowHeight({ next: 32, previous: 69, live: true })).toBe(false)
  expect(shouldCommitVirtualRowHeight({ next: 80, previous: 69, live: true })).toBe(true)
  expect(shouldCommitVirtualRowHeight({ next: 32, previous: 69, live: false })).toBe(true)
})

test("invalidates cached measurements after a meaningful timeline width change", () => {
  expect(timelineMeasurementsMatchWidth(800, 808)).toBe(true)
  expect(timelineMeasurementsMatchWidth(800, 840)).toBe(false)
})

test("changes the measurement key when a shell tool receives output", () => {
  const running = {
    id: "prt_shell",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: "call_test",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "which yt-dlp || which youtube-dl" },
      time: { start: 1 },
    },
  } as ToolPart
  const completed = {
    ...running,
    state: {
      status: "completed" as const,
      input: running.state.input,
      output: "/opt/homebrew/bin/yt-dlp\n",
      title: "检查 yt-dlp 或 youtube-dl 是否已安装",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as ToolPart

  expect(partMeasurementKey(completed)).not.toBe(partMeasurementKey(running))
})

test("changes the timeline cache version when streaming text grows", () => {
  const message = { id: "msg_test" }
  const short = {
    id: "prt_text",
    sessionID: "ses_test",
    messageID: message.id,
    type: "text",
    text: "partial",
  } as Part
  const full = { ...short, text: "partial response that arrived while the session was not visible" } as Part

  expect(timelineContentVersion([message], { [message.id]: [short] })).not.toBe(
    timelineContentVersion([message], { [message.id]: [full] }),
  )
})

test("rowContentVersion returns a stable value for a TurnGap", () => {
  expect(rowContentVersion({ _tag: "TurnGap", userMessageID: "msg_1" }, () => undefined)).toBe("gap")
})

test("rowContentVersion includes the label for a TurnDivider", () => {
  expect(
    rowContentVersion({ _tag: "TurnDivider", userMessageID: "msg_1", label: "compaction" }, () => undefined),
  ).toBe("divider:msg_1:compaction")
})

test("rowContentVersion for an AssistantPart part group reflects part measurement key", () => {
  const part = {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: "hello",
  } as Part
  const lookup = (messageID: string, partID: string) =>
    messageID === "msg_1" && partID === "prt_1" ? part : undefined

  const v1 = rowContentVersion(
    { _tag: "AssistantPart", userMessageID: "msg_1", group: { type: "part", ref: { messageID: "msg_1", partID: "prt_1" } } },
    lookup,
  )
  // Same part → same version.
  expect(v1).toBe(
    rowContentVersion(
      { _tag: "AssistantPart", userMessageID: "msg_1", group: { type: "part", ref: { messageID: "msg_1", partID: "prt_1" } } },
      lookup,
    ),
  )

  // Grow the text → version changes.
  const longer = { ...part, text: "hello world" } as Part
  const v2 = rowContentVersion(
    { _tag: "AssistantPart", userMessageID: "msg_1", group: { type: "part", ref: { messageID: "msg_1", partID: "prt_1" } } },
    () => longer,
  )
  expect(v2).not.toBe(v1)
})

test("rowContentVersion for a context group combines all member parts", () => {
  const partA = {
    id: "prt_a",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: "read",
    state: { status: "completed" as const, input: {}, output: "ok", metadata: {}, time: { start: 1, end: 2 } },
  } as ToolPart
  const partB = {
    id: "prt_b",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: "grep",
    state: { status: "completed" as const, input: {}, output: "done", metadata: {}, time: { start: 1, end: 2 } },
  } as ToolPart
  const lookup = (messageID: string, partID: string) =>
    partID === "prt_a" ? partA : partID === "prt_b" ? partB : undefined

  const v1 = rowContentVersion(
    {
      _tag: "AssistantPart",
      userMessageID: "msg_1",
      group: {
        type: "context",
        refs: [
          { messageID: "msg_1", partID: "prt_a" },
          { messageID: "msg_1", partID: "prt_b" },
        ],
      },
    },
    lookup,
  )

  // Change one member → version changes.
  const partB2 = { ...partB, state: { ...partB.state, output: "changed" } } as ToolPart
  const v2 = rowContentVersion(
    {
      _tag: "AssistantPart",
      userMessageID: "msg_1",
      group: {
        type: "context",
        refs: [
          { messageID: "msg_1", partID: "prt_a" },
          { messageID: "msg_1", partID: "prt_b" },
        ],
      },
    },
    (messageID, partID) => (partID === "prt_a" ? partA : partID === "prt_b" ? partB2 : undefined),
  )
  expect(v2).not.toBe(v1)
})

test("rowContentVersion for DiffSummary depends on diff count", () => {
  const v1 = rowContentVersion({ _tag: "DiffSummary", userMessageID: "msg_1", diffs: [{ file: "a" }] }, () => undefined)
  const v2 = rowContentVersion(
    { _tag: "DiffSummary", userMessageID: "msg_1", diffs: [{ file: "a" }, { file: "b" }] },
    () => undefined,
  )
  expect(v1).not.toBe(v2)
})

test("rowContentVersion for Error depends on text length", () => {
  const v1 = rowContentVersion({ _tag: "Error", userMessageID: "msg_1", text: "short" }, () => undefined)
  const v2 = rowContentVersion({ _tag: "Error", userMessageID: "msg_1", text: "a longer error" }, () => undefined)
  expect(v1).not.toBe(v2)
})

test("rowContentVersion for Thinking depends on phase and heading length", () => {
  const v1 = rowContentVersion({ _tag: "Thinking", userMessageID: "msg_1", phase: "sending" }, () => undefined)
  const v2 = rowContentVersion({ _tag: "Thinking", userMessageID: "msg_1", phase: "thinking" }, () => undefined)
  expect(v1).not.toBe(v2)
})
