import { describe, expect, test } from "bun:test"
import { createBrowserDisplay, type BrowserDisplaySnapshot } from "./display"
import type { BrowserDisplayFrame, WindowBrowserApi } from "./types"

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
describe("native browser display", () => {
  test("overlays replace the native surface only after the preview has painted", async () => {
    const frames: BrowserDisplayFrame[] = []
    const order: string[] = []
    let paint!: () => void
    let shown = 0
    let snapshot: BrowserDisplaySnapshot = { partition: "first", bounds: { x: 10, y: 20, width: 400, height: 600 } }
    const api = {
      acquireDisplay: async () => 7,
      capturePreview: async (partition: string) => {
        order.push(`capture:${partition}`)
        return "preview"
      },
      updateDisplay: async (frame: BrowserDisplayFrame) => {
        frames.push(frame)
        order.push(`display:${frame.partition}`)
        return true
      },
      releaseDisplay: async () => {},
    } satisfies Pick<WindowBrowserApi, "acquireDisplay" | "updateDisplay" | "releaseDisplay" | "capturePreview">
    const display = createBrowserDisplay({
      api,
      read: () => snapshot,
      shown: () => shown++,
      preview: (partition, image) => {
        order.push(`preview:${partition}:${image}`)
        return new Promise<void>((resolve) => {
          paint = resolve
        })
      },
    })
    display.start()
    await flush()
    snapshot = { ...snapshot, overlay: "dropdown-menu-content" }
    display.sync()
    snapshot = { ...snapshot, bounds: { ...snapshot.bounds!, width: 500 }, overlay: "dialog" }
    display.sync()
    await flush()
    expect(frames).toHaveLength(1)
    paint()
    await flush()
    expect(order).toEqual(["display:first", "capture:first", "preview:first:preview", "display:null"])
    expect(frames[1]).toEqual({ lease: 7, revision: 2, protectedPageID: "first", partition: null, bounds: null })
    display.sync()
    expect(shown).toBe(1)
    snapshot = { ...snapshot, overlay: undefined }
    display.sync()
    await flush()
    expect(frames[2].partition).toBe("first")
    expect(shown).toBe(2)
    display.dispose()
  })

  test("late preview completion cannot hide a restored browser or an unmounted panel", async () => {
    for (const dispose of [false, true]) {
      const frames: BrowserDisplayFrame[] = []
      let finish!: (image: string) => void
      let previews = 0
      let snapshot: BrowserDisplaySnapshot = { partition: "first", bounds: { x: 10, y: 20, width: 400, height: 600 } }
      const api = {
        acquireDisplay: async () => 7,
        capturePreview: () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
        updateDisplay: async (frame: BrowserDisplayFrame) => {
          frames.push(frame)
          return true
        },
        releaseDisplay: async () => {},
      } satisfies Pick<WindowBrowserApi, "acquireDisplay" | "updateDisplay" | "releaseDisplay" | "capturePreview">
      const display = createBrowserDisplay({
        api,
        read: () => snapshot,
        preview: async () => {
          previews++
        },
      })
      display.start()
      await flush()
      snapshot = { ...snapshot, overlay: "dialog" }
      display.sync()
      if (dispose) display.dispose()
      else {
        snapshot = { ...snapshot, overlay: undefined, partition: "second" }
        display.sync()
      }
      finish("preview")
      await flush()
      expect(previews).toBe(0)
      expect(frames.map((frame) => frame.partition)).toEqual(dispose ? ["first"] : ["first", "second"])
      display.dispose()
    }
  })

  test("capture failures still clear the native hit region for the overlay", async () => {
    const frames: BrowserDisplayFrame[] = []
    const display = createBrowserDisplay({
      api: {
        acquireDisplay: async () => 7,
        capturePreview: async () => {
          throw new Error("capture failed")
        },
        updateDisplay: async (frame: BrowserDisplayFrame) => {
          frames.push(frame)
          return true
        },
        releaseDisplay: async () => {},
      },
      read: () => ({ partition: "first", bounds: { x: 0, y: 0, width: 400, height: 600 }, overlay: "dialog" }),
    })
    display.start()
    await flush()
    await flush()
    expect(frames).toEqual([
      { lease: 7, revision: 1, protectedPageID: "first", partition: null, bounds: null },
    ])
    display.dispose()
  })

  test("a stalled screenshot cannot indefinitely block an overlay", async () => {
    const frames: BrowserDisplayFrame[] = []
    const display = createBrowserDisplay({
      api: {
        acquireDisplay: async () => 7,
        capturePreview: () => new Promise<string>(() => {}),
        updateDisplay: async (frame: BrowserDisplayFrame) => {
          frames.push(frame)
          return true
        },
        releaseDisplay: async () => {},
      },
      read: () => ({ partition: "first", bounds: { x: 0, y: 0, width: 400, height: 600 }, overlay: "dialog" }),
    })
    display.start()
    await new Promise((resolve) => setTimeout(resolve, 1550))
    expect(frames).toEqual([{ lease: 7, revision: 1, protectedPageID: "first", partition: null, bounds: null }])
    display.dispose()
  })
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
  test("targets native display by pageID when pages share a profile", async () => {
    const frames: BrowserDisplayFrame[] = []
    let snapshot: BrowserDisplaySnapshot = {
      pageID: "consult:one",
      partition: "consult:one",
      bounds: { x: 0, y: 0, width: 400, height: 600 },
    }
    const display = createBrowserDisplay({
      api: {
        acquireDisplay: async () => 9,
        updateDisplay: async (frame) => {
          frames.push(frame)
          return true
        },
        releaseDisplay: async () => {},
      },
      read: () => snapshot,
    })
    display.start()
    await flush()
    snapshot = { ...snapshot, pageID: "consult:two", partition: "consult:two" }
    display.sync()
    expect(frames.map((frame) => frame.pageID)).toEqual(["consult:one", "consult:two"])
    expect(frames.map((frame) => frame.partition)).toEqual(["consult:one", "consult:two"])
    display.dispose()
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
