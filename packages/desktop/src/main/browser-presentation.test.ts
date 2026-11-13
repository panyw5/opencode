import { describe, expect, mock, test } from "bun:test"

let windows = 0
let contents = 0
let captures = 0
let nextFakeURL = "https://chatgpt.com/"
const parked = (width = 1280, height = 800) => ({ x: 1 - width, y: 0, width, height })
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
mock.module("electron", () => ({
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  session: {},
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
  },
}))
mock.module("./logging", () => ({ write: () => {} }))
mock.module("./browser-cdp", () => ({
  BrowserCdp: class {
    readonly instanceID = Symbol()
    readonly operations: string[] = []
    constructor(private readonly wc: { setURL?: (url: string) => void }) {}
    navigate = async (url: string) => {
      this.operations.push(`navigate:${url}`)
      this.wc.setURL?.(url)
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
  test.each(["consult-gpt-pro-secure", "consult-gpt-pro-secure-generation-synthetic"])(
    "login loop guard protects GPT profile %s",
    async (profileID) => {
      const controller = new BrowserController()
      const children: FakeView[] = []
      controller.attachWindow({
        isDestroyed: () => false,
        contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
      } as never)
      await controller.openPage("loop", profileID, "https://chatgpt.com/", { kind: "login" })
      let prevented = 0
      const event = { preventDefault: () => prevented++ }
      for (let i = 0; i < 8; i++)
        children[0].emit(
          "will-redirect",
          event,
          i % 2 ? "https://chatgpt.com/" : "https://chatgpt.com/auth/login?next=%2F",
          false,
          false,
        )
      expect(prevented).toBe(0)
      for (let i = 0; i < 5; i++)
        children[0].emit(
          "will-navigate",
          event,
          i % 2 ? "https://chatgpt.com/" : "https://chatgpt.com/auth/login?next=%2F",
        )
      expect(prevented).toBe(1)
      expect(controller.getState()[0].authRedirectLoop).toBe(true)
      await controller.openPage("loop", profileID, "https://chatgpt.com/")
      expect(controller.getState()[0].authRedirectLoop).toBeUndefined()
      // The real site uses pushState for login and document navigation for home.
      for (let i = 0; i < 2; i++) {
        children[0].emit("will-navigate", event, "https://chatgpt.com/")
        children[0].emit("did-navigate-in-page", event, "https://chatgpt.com/auth/login?next=%2F", true)
      }
      children[0].emit("will-navigate", event, "https://chatgpt.com/")
      expect(prevented).toBe(2)
      expect(controller.getState()[0].authRedirectLoop).toBe(true)
      await controller.open("ordinary", "https://chatgpt.com/")
      expect(children[1].listeners.has("will-navigate")).toBe(false)
      controller.dispose()
    },
  )
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
    await controller.updateDisplay({ lease, revision: 1, pageID: "preview", partition: "preview", bounds })
    expect(await controller.capturePreview("preview")).toBe("data:image/png;base64,preview")
    expect(captures).toBe(before + 1)
    expect(children[0].visible).toBe(true)
    expect(children[0].bounds).toEqual(bounds)
    await controller.updateDisplay({ lease, revision: 2, pageID: null, partition: null, bounds: null })
    expect(await controller.capturePreview("preview")).toBeUndefined()
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual(parked(500, 700))
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
    await controller.updateDisplay({
      lease,
      revision: 1,
      pageID: "user",
      partition: "user",
      bounds: { x: 0, y: 0, width: 500, height: 500 },
    })
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
    expect(await controller.updateDisplay({ lease, revision: 1, pageID: "user", partition: "user", bounds })).toBe(
      true,
    )
    expect(children.map((view) => view.visible)).toEqual([true, false])
    expect(await controller.updateDisplay({ lease, revision: NaN, pageID: "agent", partition: "agent", bounds })).toBe(
      false,
    )
    expect(
      await controller.updateDisplay({
        lease,
        revision: 2,
        pageID: "agent",
        partition: "agent",
        bounds: { ...bounds, x: NaN },
      }),
    ).toBe(false)
    expect(children.map((view) => view.visible)).toEqual([true, false])
    expect(await controller.updateDisplay({ lease, revision: 3, pageID: "agent", partition: "agent", bounds })).toBe(
      true,
    )
    expect(children.map((view) => view.visible)).toEqual([false, true])
    expect(await controller.updateDisplay({ lease, revision: 2, pageID: "user", partition: "user", bounds })).toBe(
      false,
    )
    const nextLease = controller.acquireDisplay()
    expect(children.every((view) => !view.visible)).toBe(true)
    await controller.updateDisplay({ lease: nextLease, revision: 1, pageID: "user", partition: "user", bounds })
    controller.releaseDisplay(lease)
    expect(await controller.updateDisplay({ lease, revision: 4, pageID: "agent", partition: "agent", bounds })).toBe(
      false,
    )
    expect(children.map((view) => view.visible)).toEqual([true, false])
    await controller.updateDisplay({ lease: nextLease, revision: 2, pageID: null, partition: null, bounds: null })
    expect(children.every((view) => !view.visible)).toBe(true)
    // Hidden views park on a 1px sliver at the window's left edge, keeping
    // their last requested layout size (see parkedBounds).
    expect(
      children.every((view) => JSON.stringify(view.bounds) === JSON.stringify(parked(500, 700))),
    ).toBe(true)
    controller.releaseDisplay(nextLease)
    expect(
      await controller.updateDisplay({ lease: nextLease, revision: 3, pageID: "agent", partition: "agent", bounds }),
    ).toBe(false)
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
    expect(children[0].bounds).toEqual(parked())
    const bounds = { x: 800, y: 150, width: 500, height: 700 }
    const lease = controller.acquireDisplay()
    const show = (revision: number) =>
      controller.updateDisplay({
        lease,
        revision,
        pageID: "persist:consult-gpt-pro",
        partition: "persist:consult-gpt-pro",
        bounds,
      })
    const hide = (revision: number) =>
      controller.updateDisplay({ lease, revision, pageID: null, partition: null, bounds: null })
    expect(await show(1)).toBe(true)
    expect(children[0].bounds).toEqual(bounds)
    expect(children[0].visible).toBe(true)
    expect(await hide(2)).toBe(true)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual(parked(500, 700))
    // A hidden-page screenshot parks on the sliver and restores afterwards.
    await controller.captureScreenshot("persist:consult-gpt-pro", false)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual(parked(500, 700))
    expect(await show(3)).toBe(true)
    expect(children[0].bounds).toEqual(bounds)
    expect(await hide(4)).toBe(true)
    expect(children[0].visible).toBe(false)
    expect(children[0].bounds).toEqual(parked(500, 700))
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
    expect(
      children.map((view) => (view.options as { webPreferences: { partition: string } }).webPreferences.partition),
    ).toEqual([profileID, profileID])
    expect(first).toMatchObject({ pageID: "consult:one", partition: "consult:one", profileID, epoch: 1 })
    expect(second).toMatchObject({ pageID: "consult:two", partition: "consult:two", profileID, epoch: 1 })
    expect(controller.cdp("consult:one")).toBeDefined()
    expect(controller.cdp("consult:one")).not.toBe(controller.cdp("consult:two"))
    expect(children.every((view) => !view.visible)).toBe(true)
    expect(children.map((view) => view.bounds)).toEqual([parked(), parked()])
    expect((controller.cdp("consult:one") as never as { operations: string[] }).operations.slice(0, 2)).toEqual([
      "navigate:https://chatgpt.com/c/new",
      "focus-emulation:true",
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
    expect(children[0].bounds).toEqual(parked())
    expect(children[1].bounds).toEqual({ x: 0, y: 0, width: 500, height: 500 })
    // Native bounds drive layout while visible — display frames issue no CDP
    // viewport commands at all.
    expect(
      (controller.cdp("consult:two") as never as { operations: string[] }).operations.filter((op) =>
        op.startsWith("viewport"),
      ),
    ).toEqual([])
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
    expect(children[1].bounds).toEqual(parked(500, 500))

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

  test("shows automation pages immediately; display frames cost zero CDP calls", async () => {
    const controller = new BrowserController()
    const children: FakeView[] = []
    controller.attachWindow({
      isDestroyed: () => false,
      contentView: { addChildView: (view: FakeView) => children.push(view), removeChildView: () => {} },
    } as never)
    const profileID = "persist:consult-gpt-pro"
    await controller.openPage("consult:viewport-live", profileID, "https://chatgpt.com/", { kind: "consultation" })
    const cdp = controller.cdp("consult:viewport-live") as unknown as { operations: string[] }
    // The page is already on the target URL so no navigation happens; only
    // focus emulation is enabled — no viewport override: the parked sliver
    // already supplies a deterministic layout.
    expect(cdp.operations).toEqual(["focus-emulation:true"])
    const lease = controller.acquireDisplay()
    // A burst of display frames (panel drag/animation) must never issue CDP
    // viewport commands: bounds-driven layout is the only mechanism.
    for (let revision = 1; revision <= 5; revision++) {
      expect(
        await controller.updateDisplay({
          lease,
          revision,
          pageID: "consult:viewport-live",
          partition: profileID,
          bounds: { x: 0, y: 0, width: 400 + revision * 50, height: 700 },
        }),
      ).toBe(true)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(children[0].visible).toBe(true)
    expect(children[0].bounds).toEqual({ x: 0, y: 0, width: 650, height: 700 })
    expect(cdp.operations).toEqual(["focus-emulation:true"])
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
    expect(controller.listConsultationPages().find((page) => page.pageID === "consult:protected-one")?.protected).toBe(
      true,
    )
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

  test("owner lease acquisition cannot be stolen by another window", async () => {
    const controller = new BrowserController()
    const owner = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    }
    controller.attachWindow(owner as never)
    await controller.open("user", "https://example.com/")
    const foreign = { isDestroyed: () => false }
    expect(() => controller.acquireDisplay(foreign as never)).toThrow("owned by another window")
    const lease = controller.acquireDisplay(owner as never)
    expect(lease).toBeGreaterThan(0)
    controller.dispose()
  })
})
