import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserWindow, Notification, NotificationConstructorOptions } from "electron"
import { createSystemNotifications } from "./system-notifications"

function fixture() {
  const calls: string[] = []
  const logs: string[] = []
  const created: FakeNotification[] = []
  const state = {
    focused: false,
    destroyed: false,
    rendererDestroyed: false,
    minimized: false,
    supported: true,
    fail: false,
  }
  class FakeNotification extends EventEmitter {
    constructor(readonly options: NotificationConstructorOptions) {
      super()
    }
    show() {
      if (state.fail) throw new Error("Native failure")
      calls.push("show")
      this.emit("show")
    }
    close() {
      calls.push("close")
    }
  }
  const window = {
    id: 1,
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    isMinimized: () => state.minimized,
    restore: () => calls.push("restore"),
    show: () => calls.push("window.show"),
    focus: () => calls.push("focus"),
    webContents: {
      isDestroyed: () => state.rendererDestroyed,
      send: (channel: string, href?: string) => calls.push(`${channel}:${href ?? ""}`),
    },
  } as unknown as BrowserWindow
  const controller = createSystemNotifications({
    supported: () => state.supported,
    create: (options) => {
      const notification = new FakeNotification(options)
      created.push(notification)
      return notification as unknown as Notification
    },
    log: (line) => logs.push(line),
  })
  return { controller, window, state, created, calls, logs }
}

describe("native system notifications", () => {
  test("sends title/body natively without remote resources", () => {
    const f = fixture()
    f.controller.show(f.window, "Permission needed", "Project / Session", "/repo/session/ses_1")
    expect(f.created[0].options).toEqual({ title: "Permission needed", body: "Project / Session" })
    expect(f.calls).toEqual(["show"])
    expect(f.logs.some((line) => line.includes("native-show-callback presentation=unverified"))).toBe(true)
  })

  test("restores, shows, focuses, and navigates the originating window on click", () => {
    const f = fixture()
    f.state.minimized = true
    f.controller.show(f.window, "Question", undefined, "/repo/session/ses_1")
    f.created[0].emit("click")
    f.created[0].emit("click")
    expect(f.calls).toEqual([
      "show",
      "restore",
      "window.show",
      "focus",
      "notification-click:/repo/session/ses_1",
      "close",
    ])
  })

  test("still handles clicks after the Windows banner times out", () => {
    const f = fixture()
    f.controller.show(f.window, "Question", "Answer needed", "/repo/session/ses_1")
    f.created[0].emit("close")
    expect(f.created[0].listenerCount("click")).toBe(1)
    f.created[0].emit("click")
    expect(f.calls).toContain("notification-click:/repo/session/ses_1")
  })

  test("allows project-level error notifications without a session", () => {
    const f = fixture()
    f.controller.show(f.window, "Error", "Attention needed", "/repo")
    f.created[0].emit("click")
    expect(f.calls).toContain("notification-click:/repo")
  })

  test("attention requests notify even when the window is focused", () => {
    const f = fixture()
    f.state.focused = true
    f.controller.show(f.window, "Permission needed", "Waiting for you", "/repo/session/ses_1", true)
    expect(f.calls).toEqual(["show"])
    expect(f.logs.some((line) => line.includes("requested attention=true"))).toBe(true)
  })

  test("rejects an invalid attention flag", () => {
    const f = fixture()
    expect(() => f.controller.show(f.window, "Question", undefined, undefined, "yes")).toThrow()
    expect(f.created).toHaveLength(0)
  })

  for (const flag of ["focused", "destroyed", "rendererDestroyed"] as const) {
    test(`skips ${flag} windows`, () => {
      const f = fixture()
      f.state[flag] = true
      f.controller.show(f.window, "Question")
      expect(f.created).toHaveLength(0)
      expect(f.logs.some((line) => line.includes("skipped"))).toBe(true)
    })
  }

  test("skips unsupported systems", () => {
    const f = fixture()
    f.state.supported = false
    f.controller.show(f.window, "Question")
    expect(f.created).toHaveLength(0)
    expect(f.logs.at(-1)).toContain("unsupported")
  })

  test("does not activate a window destroyed after notification delivery", () => {
    const f = fixture()
    f.controller.show(f.window, "Question")
    f.state.destroyed = true
    f.created[0].emit("click")
    expect(f.calls).toEqual(["show", "close"])
  })

  test("logs native failures and cleans up listeners", () => {
    const f = fixture()
    f.controller.show(f.window, "Question")
    f.created[0].emit("failed", {}, "Notifications disabled")
    expect(f.logs.at(-1)).toContain("failed error=Notifications disabled")
    expect(f.created[0].eventNames()).toEqual([])
    expect(f.calls).toEqual(["show", "close"])
  })

  test("handles synchronous native errors without renderer rejection", () => {
    const f = fixture()
    f.state.fail = true
    expect(() => f.controller.show(f.window, "Question")).not.toThrow()
    expect(f.logs.at(-1)).toContain("Native failure")
    expect(f.created[0].eventNames()).toEqual([])
  })

  test("bounds retained notifications and cleans up at shutdown", () => {
    const f = fixture()
    for (let i = 0; i < 101; i++) f.controller.show(f.window, "Question")
    expect(f.created[0].eventNames()).toEqual([])
    expect(f.created[1].listenerCount("click")).toBe(1)
    f.controller.dispose()
    expect(f.created.every((item) => item.eventNames().length === 0)).toBe(true)
    expect(f.calls.filter((call) => call === "close")).toHaveLength(101)
  })

  test("rejects invalid payloads and non-session navigation targets", () => {
    const f = fixture()
    for (const href of ["https://example.com", "//example.com", "/\\example.com", "/repo/session/../settings", 42]) {
      expect(() => f.controller.show(f.window, "Question", "body", href)).toThrow("Invalid notification payload")
    }
    for (const title of ["", " ", 42, "x".repeat(257)]) {
      expect(() => f.controller.show(f.window, title)).toThrow()
    }
    expect(() => f.controller.show(f.window, "Question", {})).toThrow()
    expect(f.created).toHaveLength(0)
  })
})
