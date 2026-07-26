import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { partMeasurementKey, scheduleConnectedMeasure, timelineMeasurementsMatchWidth } from "./measure"

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
