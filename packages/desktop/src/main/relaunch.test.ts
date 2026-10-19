import { expect, test } from "bun:test"
import { relaunchApp } from "./relaunch"

test("development relaunch replaces the relative app argument and preserves later arguments", () => {
  const calls: unknown[][] = []
  relaunchApp(
    {
      isPackaged: false,
      getAppPath: () => "/workspace/opencode/packages/desktop",
      relaunch: (...args) => calls.push(args),
    },
    ["/electron", ".", "--remote-debugging-port=9222", "--no-sandbox"],
  )
  expect(calls).toEqual([
    [{ args: ["/workspace/opencode/packages/desktop", "--remote-debugging-port=9222", "--no-sandbox"] }],
  ])
})

test("packaged relaunch keeps Electron's existing argument behavior", () => {
  const calls: unknown[][] = []
  relaunchApp(
    {
      isPackaged: true,
      getAppPath: () => "/Applications/OpenCode.app/Contents/Resources/app.asar",
      relaunch: (...args) => calls.push(args),
    },
    ["/Applications/OpenCode.app/Contents/MacOS/OpenCode", "--arg"],
  )
  expect(calls).toEqual([[]])
})
