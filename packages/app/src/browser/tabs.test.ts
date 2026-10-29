import { describe, expect, test } from "bun:test"
import { createBrowserTabs, pickFallback } from "./tabs"
import type { BrowserPresentation, BrowserViewState, WindowBrowserApi } from "./types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
  const reloads: { partition: string; action: string; request: ReturnType<typeof deferred<void>> }[] = []
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
    navigate: (partition, action) => {
      const request = deferred<void>()
      reloads.push({ partition, action, request })
      return request.promise
    },
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
    reloads,
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
  test("submitting the current address reloads, including canonical URL variations", async () => {
    for (const target of [
      "https://example.test/",
      "https://example.test",
      "example.test",
      "https://example.test:443/",
    ]) {
      const f = fixture()
      f.updated({ ...view("persist:user"), url: "https://example.test/" })
      f.service.go(target)
      expect(f.navigations).toHaveLength(0)
      expect(f.reloads).toHaveLength(1)
      expect(f.reloads[0]).toMatchObject({ partition: "persist:user", action: "reload" })
      expect(f.service.loading()).toBe(true)
      f.updated({ ...view("persist:user"), url: "https://example.test/", loading: true })
      f.reloads[0].request.resolve()
      await flush()
      await flush()
      expect(f.service.loading()).toBe(true)
      f.updated({ ...view("persist:user"), url: "https://example.test/" })
      expect(f.service.loading()).toBe(false)
      f.service.dispose()
    }
  })
  test("failed reload releases loading and a different address still navigates", async () => {
    const f = fixture()
    f.updated({ ...view("persist:user"), url: "https://example.test/" })
    f.service.go("https://example.test/")
    f.reloads[0].request.reject(new Error("reload fixture failure"))
    await flush()
    await flush()
    expect(f.service.loading()).toBe(false)
    f.service.go("https://example.test/other")
    expect(f.navigations).toHaveLength(1)
    expect(f.reloads).toHaveLength(1)
    f.service.go("https://[")
    expect(f.navigations).toHaveLength(2)
    f.service.dispose()
  })
  test("loading starts before native events and covers native page loading after IPC settles", async () => {
    const f = fixture()
    f.updated(view("persist:user"))
    f.service.go("https://slow.test/")
    expect(f.service.loading()).toBe(true)
    f.updated(view("persist:user"))
    expect(f.service.loading()).toBe(true)
    const loading = { ...view("persist:user"), url: "https://slow.test/", loading: true }
    f.updated(loading)
    f.navigations[0].resolve(loading)
    await flush()
    await flush()
    expect(f.service.loading()).toBe(true)
    f.updated({ ...loading, loading: false })
    expect(f.service.loading()).toBe(false)
    f.service.dispose()
  })
  test("older navigation completion cannot clear a newer loading request", async () => {
    const f = fixture()
    f.updated(view("persist:user"))
    f.service.go("https://first.test/")
    f.service.go("https://second.test/")
    f.navigations[0].resolve(view("persist:user"))
    await flush()
    await flush()
    expect(f.service.loading()).toBe(true)
    f.navigations[1].resolve({ ...view("persist:user"), url: "https://second.test/" })
    await flush()
    await flush()
    expect(f.service.loading()).toBe(false)
    f.service.dispose()
  })
  test("navigation failure clears loading even after native events consumed pending address", async () => {
    const f = fixture()
    f.updated(view("persist:user"))
    f.service.go("https://failure.test/")
    f.updated(view("persist:user"))
    f.navigations[0].reject(new Error("fixture navigation failed"))
    await flush()
    await flush()
    expect(f.service.loading()).toBe(false)
    f.service.dispose()
  })
  test("loading stays page-scoped, ignores blank tabs and clears when a tab closes", () => {
    const f = fixture()
    const blank = f.service.addUserTab()!
    expect(f.service.loading()).toBe(false)
    f.service.go("https://slow.test/")
    expect(f.service.loading()).toBe(true)
    f.updated(view("persist:other"))
    f.service.activate("persist:other")
    expect(f.service.loading()).toBe(false)
    expect(f.service.loading(blank)).toBe(true)
    f.service.close(blank)
    expect(f.service.loading(blank)).toBe(false)
    f.updated({ ...view("persist:other"), url: "https://reload.test/", loading: true })
    expect(f.service.loading()).toBe(true)
    f.updated(view("persist:other"))
    expect(f.service.loading()).toBe(false)
    f.service.dispose()
  })
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
  test("keeps pages sharing a profile distinct and fences stale page events", () => {
    const f = fixture()
    const profileID = "persist:consult-gpt-pro"
    const first = {
      ...view("consult:one", 1),
      pageID: "consult:one",
      profileID,
      kind: "consultation" as const,
      owner: { directory: "/repo", sessionID: "ses_one" },
    }
    const second = {
      ...view("consult:two", 1),
      pageID: "consult:two",
      profileID,
      kind: "consultation" as const,
      owner: { directory: "/repo", sessionID: "ses_two" },
    }
    f.updated(first)
    f.updated(second)
    expect(f.service.tabs()).toHaveLength(2)
    expect(f.service.tabs().map((tab) => [tab.pageID, tab.profileID, tab.agent])).toEqual([
      ["consult:one", profileID, true],
      ["consult:two", profileID, true],
    ])
    expect(f.reveals()).toBe(0)
    f.service.activate("consult:two")
    expect(f.service.activeAgent()).toBe(true)

    f.close("consult:one", 1)
    f.updated(first)
    expect(f.service.tabs().map((tab) => tab.pageID)).toEqual(["consult:two"])
    f.close("consult:two", 1)
    f.updated({ ...second, epoch: 2, url: "https://two.test/" })
    f.close("consult:two", 1)
    expect(f.service.tabs()).toHaveLength(1)
    expect(f.service.tabs()[0].state?.url).toBe("https://two.test/")
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
