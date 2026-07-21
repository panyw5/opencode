import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"

import { terminateProcessTree } from "./process-tree"

describe("terminateProcessTree", () => {
  test("uses taskkill to terminate a Windows process tree", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = []
    const killer = new EventEmitter()
    const child = { pid: 1234, kill: () => true }

    const stopped = terminateProcessTree(child, {
      platform: "win32",
      spawnTaskkill: ((command, args, options) => {
        calls.push({ command, args, options })
        return killer
      }) as never,
    })
    killer.emit("exit")
    await stopped

    expect(calls).toEqual([
      {
        command: "taskkill",
        args: ["/pid", "1234", "/T", "/F"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ])
  })

  test("falls back to killing the direct child when taskkill cannot start", async () => {
    const killer = new EventEmitter()
    let killed = 0
    const child = { pid: 1234, kill: () => (++killed, true) }

    const stopped = terminateProcessTree(child, {
      platform: "win32",
      spawnTaskkill: (() => killer) as never,
    })
    killer.emit("error", new Error("taskkill unavailable"))
    await stopped

    expect(killed).toBe(1)
  })

  test("uses a regular termination signal outside Windows", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    await terminateProcessTree(
      { pid: 1234, kill: (signal) => (signals.push(signal), true) },
      { platform: "darwin" },
    )

    expect(signals).toEqual(["SIGTERM"])
  })
})
