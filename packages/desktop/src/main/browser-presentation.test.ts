import { describe, expect, mock, test } from "bun:test"

let windows = 0
let contents = 0
let captures = 0
let nextFakeURL = "https://chatgpt.com/"
let blankNavigation: { started: () => void; wait: Promise<void> } | undefined
class FakeWindow {
  constructor() {
    windows++
  }
}
class FakeView {
  options: unknown
  url = nextFakeURL
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  visible = false
  bounds: unknown
  constructor(options?: unknown) {
    this.options = options
  }
  webContents = {
    id: ++contents,
    isDestroyed: () => false,
    setUserAgent: () => {},
    setBackgroundThrottling: () => {},
    setWindowOpenHandler: () => {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
    },
    getURL: () => this.url,
    setURL: (url: string) => (this.url = url),
    getTitle: () => "ChatGPT",
    isLoading: () => false,
    capturePage: async () => {
      captures++
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 500, height: 700 }),
        toDataURL: () => "data:image/png;base64,preview",
      }
    },
    close: () => {
      this.closed = true
    },
  }
  closed = false
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
  setVisible(value: boolean) {
    this.visible = value
  }
  setBounds(value: unknown) {
    this.bounds = value
  }
  getBounds() {
    return this.bounds
  }
  getVisible() {
    return this.visible
  }
}
mock.module("electron", () => ({ BrowserWindow: FakeWindow, WebContentsView: FakeView, session: {} }))
mock.module("./logging", () => ({ write: () => {} }))
mock.module("./browser-cdp", () => ({
  BrowserCdp: class {
    readonly instanceID = Symbol()
    readonly operations: string[] = []
    constructor(private readonly wc: { setURL?: (url: string) => void }) {}
    navigate = async (url: string) => {
      this.operations.push(`navigate:${url}`)
      if (url === "about:blank" && blankNavigation) {
        blankNavigation.started()
        await blankNavigation.wait
      }
      this.wc.setURL?.(url)
    }
    setViewport = async (width: number, height: number) => {
      this.operations.push(`viewport:${width}x${height}`)
    }
    setFocusEmulation = async (enabled: boolean) => {
      this.operations.push(`focus-emulation:${enabled}`)
    }
    screenshot = async (_fullPage: boolean) => "capture"
    close = () => {}
  },
}))
const { BrowserController } = await import("./browser")

describe("sidebar browser presentation", () => {
  test("preview captures the live viewport without changing visibility or geometry", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    await controller.open("preview", "https://example.com/")
    const bounds = { x: 800, y: 150, width: 500, height: 700 }
    const lease = controller.acquireDisplay()
    const before = captures
    expect(await controller.capturePreview("preview")).toBeUndefined()
    expect(await controller.capturePreview("missing")).toBeUndefined()
    expect(captures).toBe(before)
    await controller.updateDisplay({ lease, revision: 1, partition: "preview", bounds })
    expect(await controller.capturePreview("preview")).toBe("data:image/png;base64,preview")
    expect(captures).toBe(before + 1)
    expect(children[0].visible).toBe(true)
    expect(children[0].bounds).toEqual(bounds)
    await controller.updateDisplay({ lease, revision: 2, partition: null, bounds: null })
    expect(await controller.capturePreview("preview")).toBeUndefined()
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1, height: 1 })
    controller.dispose()
  })
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
    await controller.updateDisplay({ lease, revision: 1, partition: "user", bounds: { x: 0, y: 0, width: 500, height: 500 } })
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
    expect(await controller.updateDisplay({ lease, revision: 1, partition: "user", bounds })).toBe(true)
    expect(children.map((view) => view.visible)).toEqual([true, false])
    expect(await controller.updateDisplay({ lease, revision: NaN, partition: "agent", bounds })).toBe(false)
    expect(await controller.updateDisplay({ lease, revision: 2, partition: "agent", bounds: { ...bounds, x: NaN } })).toBe(
      false,
    )
    expect(children.map((view) => view.visible)).toEqual([true, false])
    expect(await controller.updateDisplay({ lease, revision: 3, partition: "agent", bounds })).toBe(true)
    expect(children.map((view) => view.visible)).toEqual([false, true])
    expect(await controller.updateDisplay({ lease, revision: 2, partition: "user", bounds })).toBe(false)
    controller.setVisible("user", true)
    controller.setBounds("agent", { ...bounds, width: 900 })
    expect(children.map((view) => view.visible)).toEqual([false, true])
    expect(children[1].bounds).toEqual(bounds)
    const nextLease = controller.acquireDisplay()
    expect(children.every((view) => !view.visible)).toBe(true)
    await controller.updateDisplay({ lease: nextLease, revision: 1, partition: "user", bounds })
    controller.releaseDisplay(lease)
    expect(await controller.updateDisplay({ lease, revision: 4, partition: "agent", bounds })).toBe(false)
    expect(children.map((view) => view.visible)).toEqual([true, false])
    await controller.updateDisplay({ lease: nextLease, revision: 2, partition: null, bounds: null })
    expect(children.every((view) => !view.visible)).toBe(true)
    expect(
      children.every(
        (view) => JSON.stringify(view.bounds) === JSON.stringify({ x: -32000, y: 0, width: 1, height: 1 }),
      ),
    ).toBe(true)
    controller.releaseDisplay(nextLease)
    expect(await controller.updateDisplay({ lease: nextLease, revision: 3, partition: "agent", bounds })).toBe(false)
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

  test("keeps pages distinct while sharing one Electron profile", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    const closed: Array<{ pageID: string; epoch: number; profileID?: string }> = []
    controller.onViewClosed((pageID, epoch, profileID) => closed.push({ pageID, epoch, profileID }))

    const profileID = "persist:consult-gpt-pro"
    const first = await controller.openPage("consult:one", profileID, "https://chatgpt.com/c/new", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_one" },
    })
    const second = await controller.openPage("consult:two", profileID, "https://chatgpt.com/", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_two" },
    })

    expect(children).toHaveLength(2)
    expect(children.map((view) => (view.options as { webPreferences: { partition: string } }).webPreferences.partition)).toEqual([
      profileID,
      profileID,
    ])
    expect(first).toMatchObject({ pageID: "consult:one", partition: "consult:one", profileID, epoch: 1 })
    expect(second).toMatchObject({ pageID: "consult:two", partition: "consult:two", profileID, epoch: 1 })
    expect(controller.cdp("consult:one")).toBeDefined()
    expect(controller.cdp("consult:one")).not.toBe(controller.cdp("consult:two"))
    expect(children.every((view) => !view.visible)).toBe(true)
    expect(children.map((view) => view.bounds)).toEqual([
      { x: -32000, y: 0, width: 1280, height: 800 },
      { x: -32000, y: 0, width: 1280, height: 800 },
    ])
    expect((controller.cdp("consult:one") as never as { operations: string[] }).operations.slice(0, 2)).toEqual([
      "viewport:1280x800",
      "navigate:https://chatgpt.com/c/new",
    ])
    const legacyNavigate = await controller.open("consult:one", "https://chatgpt.com/c/recovery")
    expect(legacyNavigate).toMatchObject({ pageID: "consult:one", profileID, kind: "consultation" })
    expect(children).toHaveLength(2)

    const lease = controller.acquireDisplay()
    expect(
      await controller.updateDisplay({
        lease,
        revision: 1,
        pageID: "consult:two",
        partition: "persist:consult-gpt-pro",
        bounds: { x: 0, y: 0, width: 500, height: 500 },
      }),
    ).toBe(true)
    expect(children.map((view) => view.visible)).toEqual([false, true])
    expect(children[0].bounds).toEqual({ x: -32000, y: 0, width: 1280, height: 800 })
    expect(children[1].bounds).toEqual({ x: 0, y: 0, width: 500, height: 500 })
    expect((controller.cdp("consult:two") as never as { operations: string[] }).operations).toContain("viewport:500x500")
    expect(
      await controller.updateDisplay({
        lease,
        revision: 2,
        pageID: "consult:one",
        partition: profileID,
        bounds: { x: 20, y: 30, width: 640, height: 480 },
      }),
    ).toBe(true)
    expect(children.map((view) => view.visible)).toEqual([true, false])
    expect(children[1].bounds).toEqual({ x: -32000, y: 0, width: 500, height: 500 })

    controller.close("consult:one")
    expect(closed).toEqual([{ pageID: "consult:one", epoch: 1, profileID }])
    expect(controller.getState().map((view) => view.pageID)).toEqual(["consult:two"])
    const reopened = await controller.openPage("consult:one", profileID, "https://chatgpt.com/", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_one" },
    })
    expect(reopened?.epoch).toBe(2)
    expect(controller.getState().find((view) => view.pageID === "consult:two")?.epoch).toBe(1)
    controller.dispose()
  })

  test("ignores callbacks from an obsolete WebContents generation", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    const closed: string[] = []
    const states: number[] = []
    const consoleEntries: string[] = []
    controller.onViewClosed((pageID) => closed.push(pageID))
    controller.onViewState((state) => states.push(state.epoch))
    controller.events.onConsole = (entry) => consoleEntries.push(entry.text)

    await controller.openPage("consult:recreated", "persist:consult-gpt-pro", "https://chatgpt.com/", {
      owner: { directory: "/repo", sessionID: "ses_one" },
      kind: "consultation",
    })
    const oldView = children[0]
    const oldCdp = controller.cdp("consult:recreated") as unknown as { onConsoleEntry?: (entry: unknown) => void }
    controller.close("consult:recreated")
    await controller.openPage("consult:recreated", "persist:consult-gpt-pro", "https://chatgpt.com/", {
      owner: { directory: "/repo", sessionID: "ses_one" },
      kind: "consultation",
    })
    const currentView = children[1]
    const currentState = controller.getState()[0]
    states.length = 0

    oldView.emit("did-navigate")
    oldView.emit("render-process-gone", {}, { reason: "crashed" })
    oldCdp.onConsoleEntry?.({ level: "error", text: "stale console", at: 10 })
    expect(controller.getState()).toEqual([currentState])
    expect(closed).toEqual(["consult:recreated"])
    expect(states).toEqual([])
    expect(consoleEntries).toEqual([])
    expect(currentView.closed).toBe(false)

    await expect(
      controller.openPage("consult:recreated", "persist:consult-gpt-pro", "https://chatgpt.com/", {
        owner: { directory: "/repo", sessionID: "ses_other" },
        kind: "consultation",
      }),
    ).rejects.toThrow("different owner")
    await expect(
      controller.openPage("consult:recreated", "persist:consult-gpt-pro", "https://chatgpt.com/", {
        owner: { directory: "/repo", sessionID: "ses_one" },
        kind: "agent",
      }),
    ).rejects.toThrow("already has kind consultation")
    expect(controller.getState()).toEqual([currentState])
    controller.dispose()
  })

  test("does not reveal a recreated page after an older generation's viewport resize", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    const profileID = "persist:consult-gpt-pro"
    await controller.openPage("consult:viewport-race", profileID, "https://chatgpt.com/", { kind: "consultation" })
    const oldCdp = controller.cdp("consult:viewport-race") as unknown as {
      setViewport: (width: number, height: number) => Promise<void>
    }
    let started!: () => void
    const resizeStarted = new Promise<void>((resolve) => (started = resolve))
    let finish!: () => void
    const blockedResize = new Promise<void>((resolve) => (finish = resolve))
    oldCdp.setViewport = async () => {
      started()
      await blockedResize
    }
    const lease = controller.acquireDisplay()
    const pendingDisplay = controller.updateDisplay({
      lease,
      revision: 1,
      pageID: "consult:viewport-race",
      partition: profileID,
      bounds: { x: 0, y: 0, width: 900, height: 700 },
    })
    await resizeStarted
    controller.close("consult:viewport-race")
    await controller.openPage("consult:viewport-race", profileID, "https://chatgpt.com/", { kind: "consultation" })
    finish()
    expect(await pendingDisplay).toBe(false)
    expect(children[0].closed).toBe(true)
    expect(children[1].visible).toBe(false)
    expect(children[1].bounds).toEqual({ x: -32000, y: 0, width: 1280, height: 800 })
    controller.dispose()
  })

  test("uses bounds delivered during blank bootstrap instead of stale initial viewport size", async () => {
    const controller = new BrowserController()
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    } as never)
    nextFakeURL = "about:blank"
    let start!: () => void
    const started = new Promise<void>((resolve) => (start = resolve))
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => (finish = resolve))
    blankNavigation = { started: start, wait: blocked }
    const pageID = "consult:bootstrap-resize"
    const opening = controller.openPage(pageID, "persist:consult-gpt-pro", "https://chatgpt.com/", {
      kind: "consultation",
    })
    await started
    const lease = controller.acquireDisplay()
    expect(
      await controller.updateDisplay({
        lease,
        revision: 1,
        pageID,
        partition: "persist:consult-gpt-pro",
        bounds: { x: 10, y: 20, width: 626, height: 970 },
      }),
    ).toBe(true)
    finish()
    await opening
    const operations = (controller.cdp(pageID) as unknown as { operations: string[] }).operations
    expect(operations).toContain("viewport:626x970")
    expect(operations).not.toContain("viewport:1280x800")
    blankNavigation = undefined
    nextFakeURL = "https://chatgpt.com/"
    controller.dispose()
  })

  test("tracks selected protection independently from native visibility and fences epoch closes", async () => {
    const controller = new BrowserController()
    await controller.openPage("consult:protected-one", "persist:consult-gpt-pro", "https://chatgpt.com/", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_protected" },
    })
    await controller.openPage("consult:protected-two", "persist:consult-gpt-pro", "https://chatgpt.com/", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_other" },
    })
    const changes: string[] = []
    controller.onProtectionChanged(() => changes.push(controller.getDisplayState().protectedPageID ?? "none"))
    controller.present("consult:protected-one")
    expect(controller.isPageProtected("consult:protected-one")).toBe(true)
    const lease = controller.acquireDisplay()
    await controller.updateDisplay({
      lease,
      revision: 1,
      pageID: null,
      protectedPageID: "consult:protected-one",
      partition: null,
      bounds: null,
    })
    expect(controller.listConsultationPages().find((page) => page.pageID === "consult:protected-one")?.protected).toBe(true)
    await controller.updateDisplay({
      lease,
      revision: 2,
      pageID: "consult:protected-two",
      protectedPageID: "consult:protected-two",
      partition: "consult:protected-two",
      bounds: { x: 0, y: 0, width: 600, height: 700 },
    })
    expect(controller.isPageProtected("consult:protected-one")).toBe(false)
    expect(controller.isPageProtected("consult:protected-two")).toBe(true)
    expect(controller.closeIfEpoch("consult:protected-two", 99, "stale-cleanup")).toBe(false)
    expect(controller.has("consult:protected-two")).toBe(true)
    expect(changes).toEqual(["consult:protected-one", "consult:protected-two"])
    controller.dispose()
  })
  test("the generic idle reaper leaves consultation and login pages to their own lifecycle", async () => {
    const controller = new BrowserController()
    await controller.openPage("consult:managed-reap", "persist:consult-gpt-pro", "https://chatgpt.com/", {
      kind: "consultation",
      owner: { directory: "/repo", sessionID: "ses_managed_reap" },
    })
    await controller.openPage("agent-browser-idle", "agent-browser-idle", "https://example.com/", { kind: "agent" })
    await controller.openPage("manual-login", "persist:consult-gpt-pro", "https://chatgpt.com/", { kind: "login" })
    const views = (controller as unknown as { views: Map<string, { lastActivity: number }> }).views
    for (const entry of views.values()) entry.lastActivity = 0
    ;(controller as unknown as { reapIdle: () => void }).reapIdle()
    expect(controller.has("consult:managed-reap")).toBe(true)
    expect(controller.has("manual-login")).toBe(true)
    expect(controller.has("agent-browser-idle")).toBe(false)
    expect(controller.listConsultationPages().map((page) => page.pageID)).toEqual(["consult:managed-reap"])
    controller.dispose()
  })

  test("restores the previous native presentation when a viewport resize fails", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    const profileID = "persist:consult-gpt-pro"
    await controller.openPage("consult:resize-fail", profileID, "https://chatgpt.com/", { kind: "consultation" })
    const lease = controller.acquireDisplay()
    const originalBounds = { x: 10, y: 20, width: 500, height: 700 }
    expect(
      await controller.updateDisplay({
        lease,
        revision: 1,
        pageID: "consult:resize-fail",
        partition: profileID,
        bounds: originalBounds,
      }),
    ).toBe(true)
    const cdp = controller.cdp("consult:resize-fail") as unknown as {
      setViewport: (width: number, height: number) => Promise<void>
    }
    cdp.setViewport = async () => {
      throw new Error("simulated viewport failure")
    }
    expect(
      await controller.updateDisplay({
        lease,
        revision: 2,
        pageID: "consult:resize-fail",
        partition: profileID,
        bounds: { x: 30, y: 40, width: 900, height: 800 },
      }),
    ).toBe(false)
    expect(children[0].visible).toBe(true)
    expect(children[0].bounds).toEqual(originalBounds)
    controller.dispose()
  })
})
