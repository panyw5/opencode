import { describe, expect, test } from "bun:test"
import type { Exit, Proc } from "../../src/pty/pty"
import { adapt } from "../../src/pty/pty.bun"

describe("Bun PTY adapter", () => {
  test("buffers early data and exit in order until consumers attach", async () => {
    let emitData: ((data: string) => void) | undefined
    let emitExit: ((event: Exit) => void) | undefined
    const native = {
      pid: 123,
      onData(listener: (data: string) => void) {
        emitData = listener
        return { dispose() {} }
      },
      onExit(listener: (event: Exit) => void) {
        emitExit = listener
        return { dispose() {} }
      },
      write() {},
      resize() {},
      kill() {},
    }
    const pty = adapt(native as unknown as Parameters<typeof adapt>[0])
    await Promise.resolve()
    emitData?.("fast")
    emitExit?.({ exitCode: 0 })

    const received: string[] = []
    pty.onData((data) => received.push(`data:${data}`))
    pty.onExit((event) => received.push(`exit:${event.exitCode}`))
    await Promise.resolve()

    expect(received).toEqual(["data:fast", "exit:0"])
  })

  test("retains events across the initial drain when no consumers exist yet", async () => {
    let emitData: ((data: string) => void) | undefined
    let emitExit: ((event: Exit) => void) | undefined
    const native = {
      pid: 123,
      onData(listener: (data: string) => void) {
        emitData = listener
        return { dispose() {} }
      },
      onExit(listener: (event: Exit) => void) {
        emitExit = listener
        return { dispose() {} }
      },
      write() {},
      resize() {},
      kill() {},
    }
    const pty = adapt(native as unknown as Parameters<typeof adapt>[0])
    emitData?.("before-drain")
    emitExit?.({ exitCode: 0 })
    await Promise.resolve()
    await Promise.resolve()

    const received: string[] = []
    pty.onData((data) => received.push(`data:${data}`))
    pty.onExit((event) => received.push(`exit:${event.exitCode}`))
    await Promise.resolve()

    expect(received).toEqual(["data:before-drain", "exit:0"])
  })

  test("delivers exit to an exit-only consumer despite unobserved early data", async () => {
    let emitData: ((data: string) => void) | undefined
    let emitExit: ((event: Exit) => void) | undefined
    const native = {
      pid: 123,
      onData(listener: (data: string) => void) {
        emitData = listener
        return { dispose() {} }
      },
      onExit(listener: (event: Exit) => void) {
        emitExit = listener
        return { dispose() {} }
      },
      write() {},
      resize() {},
      kill() {},
    }
    const pty = adapt(native as unknown as Parameters<typeof adapt>[0])
    await Promise.resolve()
    emitData?.("unobserved")
    emitExit?.({ exitCode: 0 })
    const received: number[] = []
    pty.onExit((event) => received.push(event.exitCode))
    await Promise.resolve()

    expect(received).toEqual([0])
  })

  test("disposes adapter listeners without forwarding later events", async () => {
    let emitData: ((data: string) => void) | undefined
    const native = {
      pid: 123,
      onData(listener: (data: string) => void) {
        emitData = listener
        return { dispose() {} }
      },
      onExit() {
        return { dispose() {} }
      },
      write() {},
      resize() {},
      kill() {},
    }
    const pty: Proc = adapt(native as unknown as Parameters<typeof adapt>[0])
    const received: string[] = []
    const subscription = pty.onData((data) => received.push(data))
    await Promise.resolve()
    subscription.dispose()
    emitData?.("after-dispose")

    expect(received).toEqual([])
  })
})
