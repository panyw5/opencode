import { expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import {
  createCoalescedConnectedMeasure,
  partMeasurementKey,
  scheduleConnectedMeasure,
  shouldAdjustVirtualScroll,
  timelineContentVersion,
  timelineMeasurementsMatchWidth,
  virtualRowOverflow,
} from "./measure"

test("does not measure an element detached before the frame", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let calls = 0

  scheduleConnectedMeasure(element, () => {
    calls += 1
  })
  element.remove()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  expect(calls).toBe(0)
})

test("measures a connected element on the next frame", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let calls = 0

  scheduleConnectedMeasure(element, () => {
    calls += 1
  })
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  expect(calls).toBe(1)
  element.remove()
})

test("coalesces requests and skips an unchanged row height", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let height = 100
  let commits = 0
  const measurement = createCoalescedConnectedMeasure({
    element: () => element,
    measure: () => height,
    commit: () => {
      commits += 1
    },
  })

  measurement.request()
  measurement.request()
  measurement.request()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(commits).toBe(1)

  measurement.request()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(commits).toBe(1)

  height = 100.6
  measurement.request()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(commits).toBe(2)
  element.remove()
})

test("coalesced measurement ignores a detached element", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let commits = 0
  const measurement = createCoalescedConnectedMeasure({
    element: () => element,
    measure: () => 100,
    commit: () => {
      commits += 1
    },
  })

  measurement.request()
  element.remove()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(commits).toBe(0)
})

test("coalesced measurement cancels pending frame work", async () => {
  const element = document.createElement("div")
  document.body.append(element)
  let commits = 0
  const measurement = createCoalescedConnectedMeasure({
    element: () => element,
    measure: () => 100,
    commit: () => {
      commits += 1
    },
  })

  measurement.request()
  measurement.cancel()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(commits).toBe(0)
  element.remove()
})

test("does not clip a row while its DOM height is ahead of the virtualizer", () => {
  expect(virtualRowOverflow(60, 60)).toBe("clip")
  expect(virtualRowOverflow(60.5, 60)).toBe("clip")
  expect(virtualRowOverflow(60.6, 60)).toBe("visible")
})

test("keeps a bottom-anchored stream pinned as its last row grows", () => {
  expect(shouldAdjustVirtualScroll({ itemEnd: 600, scrollOffset: 500, bottomAnchored: true, initializing: false })).toBe(
    true,
  )
  expect(shouldAdjustVirtualScroll({ itemEnd: 600, scrollOffset: 500, bottomAnchored: true, initializing: true })).toBe(
    false,
  )
  expect(shouldAdjustVirtualScroll({ itemEnd: 400, scrollOffset: 500, bottomAnchored: false, initializing: false })).toBe(
    true,
  )
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
