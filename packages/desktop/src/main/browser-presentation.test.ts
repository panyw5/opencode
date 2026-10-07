import { describe, expect, mock, test } from "bun:test"

let windows = 0
let contents = 0
class FakeWindow {
  constructor() {
    windows++
  }
}
class FakeView {
  visible = false
  bounds: unknown
  webContents = {
    id: ++contents,
    isDestroyed: () => false,
    setUserAgent: () => {},
    setBackgroundThrottling: () => {},
    setWindowOpenHandler: () => {},
    on: () => {},
    getURL: () => "https://chatgpt.com/",
    getTitle: () => "ChatGPT",
    isLoading: () => false,
    close: () => {
      this.closed = true
    },
  }
  closed = false
  setVisible(value: boolean) {
    this.visible = value
  }
  setBounds(value: unknown) {
    this.bounds = value
  }
  getBounds() { return this.bounds }
  getVisible() { return this.visible }
}
mock.module("electron", () => ({ BrowserWindow: FakeWindow, WebContentsView: FakeView, session: {} }))
mock.module("./logging", () => ({ write: () => {} }))
mock.module("./browser-cdp", () => ({
  BrowserCdp: class {
    navigate = async () => {}
    screenshot = async (_fullPage: boolean) => "capture"
    close = () => {}
  },
}))
const { BrowserController } = await import("./browser")

describe("sidebar browser presentation", () => {
  test("native close routing only recognizes a visible browser in the focused window", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    const win = {
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    }
    controller.attachWindow(win as never)
    await controller.open("user", "https://example.com/")
    await controller.open("agent", "https://example.com/")
    const lease = controller.acquireDisplay()
    controller.updateDisplay({ lease, revision: 1, partition: "user", bounds: { x: 0, y: 0, width: 500, height: 500 } })
    expect(controller.focusedPartition(children[0].webContents.id, win as never)).toBe("user")
    expect(controller.focusedPartition(children[1].webContents.id, win as never)).toBeUndefined()
    expect(controller.focusedPartition(children[0].webContents.id, {} as never)).toBeUndefined()
    expect(controller.focusedPartition(undefined, win as never)).toBeUndefined()
    expect(controller.focusedPartition(-1, win as never)).toBeUndefined()
    controller.releaseDisplay(lease)
    expect(controller.focusedPartition(children[0].webContents.id, win as never)).toBeUndefined()
    controller.dispose()
  })

  test("display leases atomically switch views and reject obsolete owners and frames", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    await controller.open("user", "https://example.com/")
    await controller.open("agent", "https://example.com/")
    const bounds = { x: 800, y: 150, width: 500, height: 700 }
    const lease = controller.acquireDisplay()
    expect(controller.updateDisplay({ lease, revision: 1, partition: "user", bounds })).toBe(true)
    expect(children.map(view => view.visible)).toEqual([true, false])
    expect(controller.updateDisplay({ lease, revision: NaN, partition: "agent", bounds })).toBe(false)
    expect(controller.updateDisplay({ lease, revision: 2, partition: "agent", bounds: { ...bounds, x: NaN } })).toBe(false)
    expect(children.map(view => view.visible)).toEqual([true, false])
    expect(controller.updateDisplay({ lease, revision: 3, partition: "agent", bounds })).toBe(true)
    expect(children.map(view => view.visible)).toEqual([false, true])
    expect(controller.updateDisplay({ lease, revision: 2, partition: "user", bounds })).toBe(false)
    controller.setVisible("user", true)
    controller.setBounds("agent", { ...bounds, width: 900 })
    expect(children.map(view => view.visible)).toEqual([false, true])
    expect(children[1].bounds).toEqual(bounds)
    const nextLease = controller.acquireDisplay()
    expect(children.every(view => !view.visible)).toBe(true)
    controller.updateDisplay({ lease: nextLease, revision: 1, partition: "user", bounds })
    controller.releaseDisplay(lease)
    expect(controller.updateDisplay({ lease, revision: 4, partition: "agent", bounds })).toBe(false)
    expect(children.map(view => view.visible)).toEqual([true, false])
    controller.updateDisplay({ lease: nextLease, revision: 2, partition: null, bounds: null })
    expect(children.every(view => !view.visible)).toBe(true)
    expect(children.every(view => JSON.stringify(view.bounds) === JSON.stringify({ x: -32000, y: 0, width: 1, height: 1 }))).toBe(true)
    controller.releaseDisplay(nextLease)
    expect(controller.updateDisplay({ lease: nextLease, revision: 3, partition: "agent", bounds })).toBe(false)
    controller.dispose()
  })

  test("keeps one view in its owner window and obeys sidebar bounds/visibility", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    await controller.open("persist:consult-gpt-pro", "https://chatgpt.com/")
    const requests: number[] = []
    controller.onPresented((request) => requests.push(request.id))
    controller.present("persist:consult-gpt-pro")
    expect(windows).toBe(0)
    expect(children).toHaveLength(1)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1, height: 1 })
    const bounds = { x: 800, y: 150, width: 500, height: 700 }
    controller.setBounds("persist:consult-gpt-pro", bounds)
    controller.setVisible("persist:consult-gpt-pro", true)
    expect(children[0].bounds).toEqual(bounds)
    expect(children[0].visible).toBe(true)
    controller.setVisible("persist:consult-gpt-pro", false)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1, height: 1 })
    await controller.captureScreenshot("persist:consult-gpt-pro", false)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1, height: 1 })
    controller.setVisible("persist:consult-gpt-pro", true)
    expect(children[0].bounds).toEqual(bounds)
    controller.setBounds("persist:consult-gpt-pro", null)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1, height: 1 })
    expect(requests).toEqual([1])
    controller.dispose()
    expect(children[0].closed).toBe(true)
  })

  test("replays pending activation across a route change and ignores stale acknowledgments", async () => {
    const controller = new BrowserController()
    await controller.open("persist:consult-gpt-pro", "https://chatgpt.com/")
    controller.present("persist:consult-gpt-pro")
    const first = controller.getPresentation()!
    controller.present("persist:consult-gpt-pro")
    const second = controller.getPresentation()!
    controller.acknowledgePresentation(first.id)
    expect(controller.getPresentation()).toEqual(second)
    controller.acknowledgePresentation(second.id)
    expect(controller.getPresentation()).toBeUndefined()
    controller.present("persist:consult-gpt-pro")
    controller.close("persist:consult-gpt-pro")
    expect(controller.getPresentation()).toBeUndefined()
    expect(() => controller.present("persist:consult-gpt-pro")).toThrow()
    controller.dispose()
  })
})
