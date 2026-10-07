import { describe, expect, test } from "bun:test"
import { createBrowserDisplay, type BrowserDisplaySnapshot } from "./display"
import type { BrowserDisplayFrame, WindowBrowserApi } from "./types"

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
describe("native browser display", () => {
  test("one display path handles tab switching, modal blocking and release", async () => {
    const frames: BrowserDisplayFrame[] = []
    const released: number[] = []
    let snapshot: BrowserDisplaySnapshot = { partition: "first", bounds: { x: 10, y: 20, width: 400, height: 600 } }
    const api = {
      acquireDisplay: async () => 7,
      updateDisplay: async (frame: BrowserDisplayFrame) => {
        frames.push(frame)
        return true
      },
      releaseDisplay: async (lease: number) => {
        released.push(lease)
      },
    } as WindowBrowserApi
    const display = createBrowserDisplay({ api, read: () => snapshot })
    display.start()
    await flush()
    snapshot = { ...snapshot, partition: "second" }
    display.sync()
    snapshot = { partition: null, bounds: null }
    display.sync()
    expect(frames.map((frame) => frame.partition)).toEqual(["first", "second", null])
    expect(frames.map((frame) => frame.revision)).toEqual([1, 2, 3])
    display.dispose()
    snapshot = { partition: "first", bounds: { x: 10, y: 20, width: 400, height: 600 } }
    display.sync()
    expect(frames).toHaveLength(3)
    expect(released).toEqual([7])
  })
  test("acquire completion after unmount releases its lease without displaying anything", async () => {
    let resolve!: (lease: number) => void
    const released: number[] = []
    const frames: BrowserDisplayFrame[] = []
    const api = {
      acquireDisplay: () =>
        new Promise<number>((done) => {
          resolve = done
        }),
      updateDisplay: async (frame: BrowserDisplayFrame) => {
        frames.push(frame)
        return true
      },
      releaseDisplay: async (lease: number) => {
        released.push(lease)
      },
    } as WindowBrowserApi
    const display = createBrowserDisplay({ api, read: () => ({ partition: null, bounds: null }) })
    display.start()
    display.dispose()
    resolve(9)
    await flush()
    expect(frames).toEqual([])
    expect(released).toEqual([9])
  })
})
