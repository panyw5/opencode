import { describe, expect, mock, test } from "bun:test"

let windows = 0
class FakeWindow {
  constructor() {
    windows++
  }
}
class FakeView {
  visible = false
  bounds: unknown
  webContents = {
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
}
mock.module("electron", () => ({ BrowserWindow: FakeWindow, WebContentsView: FakeView, session: {} }))
mock.module("./logging", () => ({ write: () => {} }))
mock.module("./browser-cdp", () => ({
  BrowserCdp: class {
    navigate = async () => {}
    close = () => {}
  },
}))
const { BrowserController } = await import("./browser")

describe("sidebar browser presentation", () => {
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
    const bounds = { x: 800, y: 150, width: 500, height: 700 }
    controller.setBounds("persist:consult-gpt-pro", bounds)
    controller.setVisible("persist:consult-gpt-pro", true)
    expect(children[0].bounds).toEqual(bounds)
    expect(children[0].visible).toBe(true)
    controller.setVisible("persist:consult-gpt-pro", false)
    expect(children[0].visible).toBe(false)
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
