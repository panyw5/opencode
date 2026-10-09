import { describe, expect, test } from "bun:test"
import { createBrowserTabs, pickFallback } from "./tabs"
import type { BrowserPresentation, BrowserViewState, WindowBrowserApi } from "./types"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const view = (partition: string, epoch = 1): BrowserViewState => ({
  partition,
  epoch,
  url: "about:blank",
  title: "",
  loading: false,
  shared: false,
})
function fixture() {
  let updated = (_state: BrowserViewState) => {}
  let presented = (_request: BrowserPresentation) => {}
  let closed = (_partition: string, _epoch: number) => {}
  let reveals = 0
  let empties = 0
  let legacyCalls = 0
  const snapshot = deferred<BrowserViewState[]>()
  const navigations: ReturnType<typeof deferred<BrowserViewState | undefined>>[] = []
  const api: WindowBrowserApi = {
    getDisplayState: async () => ({ lease: 0, revision: 0, views: [] }),
    acquireDisplay: async () => 1,
    updateDisplay: async () => true,
    capturePreview: async () => undefined,
    releaseDisplay: async () => {},
    getPresentation: async () => undefined,
    acknowledgePresentation: async () => {},
    onPresented: (callback) => {
      presented = callback
      return () => {}
    },
    onUpdated: (callback) => {
      updated = callback
      return () => {}
    },
    onClosed: (callback) => {
      closed = callback
      return () => {}
    },
    getState: () => snapshot.promise,
    open: () => {
      const request = deferred<BrowserViewState | undefined>()
      navigations.push(request)
      return request.promise
    },
    setVisible: async () => {
      legacyCalls++
    },
    setBounds: async () => {
      legacyCalls++
    },
    close: async () => {},
    navigate: async () => {},
    setShared: async () => {},
  }
  const service = createBrowserTabs({
    api,
    reveal: () => {
      reveals++
    },
    onEmpty: () => {
      empties++
    },
  })
  service.start()
  return {
    service,
    snapshot,
    navigations,
    updated: (state: BrowserViewState) => updated(state),
    present: (request: BrowserPresentation) => presented(request),
    close: (partition: string, epoch: number) => closed(partition, epoch),
    reveals: () => reveals,
    empties: () => empties,
    legacyCalls: () => legacyCalls,
  }
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("shared browser tabs", () => {
  test("closing the last user tab collapses once and ignores late navigation", async () => {
    const f = fixture()
    const first = f.service.addUserTab()!
    const second = f.service.addUserTab()!
    f.service.close(first)
    expect(f.empties()).toBe(0)
    f.service.close(second)
    expect(f.service.tabs()).toHaveLength(0)
    expect(f.service.active()).toBe("")
    expect(f.empties()).toBe(1)
    f.close(second, 1)
    f.updated(view(second, 1))
    f.navigations[1].resolve(view(second, 1))
    await flush()
    expect(f.service.tabs()).toHaveLength(0)
    expect(f.empties()).toBe(1)
    f.service.dispose()
  })
  test("backend close collapses only after all user and agent tabs are gone", () => {
    const f = fixture()
    f.updated(view("persist:user"))
    f.updated(view("agent-browser-session"))
    f.close("persist:user", 1)
    expect(f.empties()).toBe(0)
    f.close("agent-browser-session", 0)
    expect(f.empties()).toBe(0)
    f.close("agent-browser-session", 1)
    expect(f.service.tabs()).toHaveLength(0)
    expect(f.empties()).toBe(1)
    f.close("agent-browser-session", 1)
    expect(f.empties()).toBe(1)
    f.present({ id: 1, state: view("agent-browser-session", 2) })
    expect(f.service.tabs()).toHaveLength(1)
    expect(f.reveals()).toBe(1)
    f.close("agent-browser-session", 2)
    expect(f.empties()).toBe(2)
    f.service.dispose()
  })
  test("empty startup and unknown close events do not collapse the panel", async () => {
    const f = fixture()
    f.snapshot.resolve([])
    await flush()
    f.close("missing", 1)
    expect(f.empties()).toBe(0)
    f.service.dispose()
    f.close("missing", 2)
    expect(f.empties()).toBe(0)
  })
  test("background updates and loading snapshots do not steal the dock", async () => {
    const f = fixture()
    f.updated(view("agent-browser-other-session"))
    f.snapshot.resolve([{ ...view("persist:consult-gpt-pro"), loading: true }])
    await flush()
    expect(f.service.tabs()).toHaveLength(2)
    expect(f.reveals()).toBe(0)
    f.present({ id: 1, state: view("persist:consult-gpt-pro") })
    expect(f.reveals()).toBe(1)
    expect(f.service.active()).toBe("persist:consult-gpt-pro")
    f.service.dispose()
  })
  test("late navigation never reactivates or displays an inactive tab", async () => {
    const f = fixture()
    const first = f.service.addUserTab()!
    const second = f.service.addUserTab()!
    f.navigations[0].resolve(view(first))
    await flush()
    expect(f.service.active()).toBe(second)
    expect(f.legacyCalls()).toBe(0)
    f.service.dispose()
  })
  test("closing chooses a neighboring tab before removal and blocks stale events", async () => {
    const f = fixture()
    const names = Array.from({ length: 4 }, () => f.service.addUserTab()!)
    f.service.activate(names[2])
    f.service.close(names[2])
    expect(f.service.active()).toBe(names[1])
    f.close(names[2], 1)
    f.updated(view(names[2], 1))
    f.navigations[2].resolve(view(names[2], 1))
    await flush()
    expect(f.service.tabs().some((tab) => tab.partition === names[2])).toBe(false)
    f.updated(view(names[2], 2))
    f.close(names[2], 1)
    expect(f.service.tabs().some((tab) => tab.partition === names[2])).toBe(true)
    expect(f.service.active()).toBe(names[1])
    f.service.dispose()
  })
  test("disposed services ignore snapshot, presentation and navigation completions", async () => {
    const f = fixture()
    const partition = f.service.addUserTab()!
    f.service.dispose()
    f.snapshot.resolve([view("agent-browser-late")])
    f.navigations[0].resolve(view(partition))
    f.present({ id: 1, state: view("agent-browser-late") })
    await flush()
    expect(f.reveals()).toBe(0)
    expect(f.legacyCalls()).toBe(0)
    expect(f.service.tabs()).toHaveLength(1)
    expect(f.service.tabs()[0].state?.epoch).toBe(0)
  })
  test("fallback prefers neighboring user tabs", () => {
    const list = ["user-a", "agent-browser-b", "user-c", "user-d"].map((partition) => ({
      partition,
      agent: partition.startsWith("agent-"),
    }))
    expect(pickFallback(list, "user-c")).toBe("user-d")
    expect(pickFallback(list, "user-d")).toBe("user-c")
  })
})
