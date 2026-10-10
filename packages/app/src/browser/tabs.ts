import { batch } from "solid-js"
import { createStore } from "solid-js/store"
import { GPT_PRO_PARTITION } from "@opencode-ai/util/gpt-pro"
import type { BrowserPresentation, BrowserViewState, WindowBrowserApi } from "./types"

export const BROWSER_PARTITION = "persist:browse"
export const AGENT_PARTITION_PREFIX = "agent-browser-"
export const OPEN_TAB_EVENT = "browser-panel:open-tab"
export const isAgentPartition = (partition: string) =>
  partition.startsWith(AGENT_PARTITION_PREFIX) || partition === GPT_PRO_PARTITION
export const browserPageID = (state: BrowserViewState) => state.pageID ?? state.partition
export const isAgentView = (state: BrowserViewState) =>
  state.kind === undefined
    ? isAgentPartition(browserPageID(state))
    : state.kind === "agent" || state.kind === "consultation" || state.kind === "login"
export const displayUrl = (url: string) => (url === "about:blank" ? "" : url)

export function normalizeAddress(input: string) {
  const value = input.trim()
  if (!value) return
  if (/^(https?|file):\/\//i.test(value)) return value
  if (value.startsWith("/") || value.startsWith("~/")) return value
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:)/.test(value)) return `https://${value}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

export type BrowserTab = { pageID: string; profileID: string; partition: string; agent: boolean; state?: BrowserViewState }
export function pickFallback(list: readonly Pick<BrowserTab, "partition" | "agent">[], closed: string): string {
  const index = list.findIndex((tab) => tab.partition === closed)
  const rest = list.filter((tab) => tab.partition !== closed)
  if (!rest.length) return ""
  for (let distance = 0; distance <= list.length; distance++) {
    const before = list[index - distance]
    if (before && before.partition !== closed && !before.agent) return before.partition
    const after = list[index + distance]
    if (after && after.partition !== closed && !after.agent) return after.partition
  }
  return rest.at(-1)!.partition
}

export function createBrowserTabs(input: { api?: WindowBrowserApi; reveal: () => void; onEmpty: () => void }) {
  const api = input.api
  const [state, setState] = createStore({
    views: {} as Record<string, BrowserViewState>,
    active: BROWSER_PARTITION,
    address: "",
    presentation: 0,
  })
  const closed = new Map<string, number>()
  const pending = new Map<string, { id: number; url: string }>()
  const stops: (() => void)[] = []
  let disposed = false
  let started = false
  let sequence = 0
  let presented = 0
  const tabs = (): BrowserTab[] =>
    Object.values(state.views)
      .filter(Boolean)
      .map((view) => ({
        pageID: browserPageID(view),
        profileID: view.profileID ?? view.partition,
        // Deprecated routing alias; tab selection remains page-scoped.
        partition: browserPageID(view),
        state: view,
        agent: isAgentView(view),
      }))
  const stale = (next: BrowserViewState) => next.epoch <= (closed.get(browserPageID(next)) ?? -1)
  const syncAddress = () =>
    setState("address", displayUrl(pending.get(state.active)?.url ?? state.views[state.active]?.url ?? ""))
  const reconcile = () => {
    if (state.views[state.active]) return
    setState("active", pickFallback(tabs(), state.active))
    syncAddress()
  }
  const record = (next: BrowserViewState) => {
    if (disposed || stale(next)) return
    const pageID = browserPageID(next)
    const normalized = { ...next, pageID, partition: pageID, profileID: next.profileID ?? next.partition }
    if ((state.views[pageID]?.epoch ?? -1) > next.epoch) return
    closed.delete(pageID)
    batch(() => {
      setState("views", pageID, normalized)
      reconcile()
      if (pageID !== state.active) return
      const nav = pending.get(pageID)
      if (nav && next.loading && next.url !== nav.url) return
      if (nav) pending.delete(pageID)
      syncAddress()
    })
    // Background state updates never claim the user's dock or native display.
    console.debug(`[browser-tabs] recorded pageID=${pageID} profileID=${normalized.profileID} epoch=${next.epoch} active=${state.active}`)
  }
  const activate = (partition: string) => {
    if (disposed || !state.views[partition]) return
    batch(() => {
      setState("active", partition)
      syncAddress()
    })
    console.debug(`[browser-tabs] activate pageID=${partition}`)
  }
  const remove = (partition: string, epoch: number) => {
    if (disposed) return
    if ((state.views[partition]?.epoch ?? -1) > epoch) {
    console.debug(`[browser-tabs] ignored stale close pageID=${partition} epoch=${epoch}`)
      return
    }
    closed.set(partition, Math.max(epoch, closed.get(partition) ?? -1))
    pending.delete(partition)
    const list = tabs()
    const fallback = pickFallback(list, partition)
    const becameEmpty = list.length === 1 && list[0].partition === partition
    batch(() => {
      setState("views", partition, undefined!)
      if (state.active === partition) setState("active", fallback)
      syncAddress()
      if (becameEmpty) {
        console.debug(`[browser-tabs] last tab removed partition=${partition}; collapsing browser panel`)
        input.onEmpty()
      }
    })
    console.debug(
      `[browser-tabs] remove pageID=${partition} epoch=${epoch} active=${state.active} count=${tabs().length}`,
    )
  }
  const present = (request: BrowserPresentation) => {
    if (disposed || request.id <= presented || stale(request.state)) return
    presented = request.id
    record(request.state)
    activate(browserPageID(request.state))
    setState("presentation", request.id)
    input.reveal()
    console.debug(`[browser-tabs] reveal pageID=${browserPageID(request.state)} request=${request.id}`)
  }
  const navigate = (partition: string, url: string) => {
    if (!api || disposed) return
    const id = ++sequence
    pending.set(partition, { id, url })
    syncAddress()
    console.debug(`[browser-tabs] navigation start partition=${partition} request=${id}`)
    void api
      .open(partition, url)
      .then((next) => {
        if (disposed || pending.get(partition)?.id !== id) return
        pending.delete(partition)
        if (next && !stale(next)) record(next)
        syncAddress()
        console.debug(`[browser-tabs] navigation settled partition=${partition} request=${id}`)
      })
      .catch((error) => {
        if (disposed || pending.get(partition)?.id !== id) return
        pending.delete(partition)
        console.warn(`[browser-tabs] navigation failed partition=${partition} request=${id} error=${String(error)}`)
      })
  }
  const addUserTab = (url?: string) => {
    if (!api || disposed) return
    const partition = `persist:tab-${crypto.randomUUID()}`
    const target = url ? normalizeAddress(url) : undefined
    record({ pageID: partition, profileID: partition, partition, url: "about:blank", title: "", loading: false, shared: false, epoch: 0 })
    activate(partition)
    navigate(partition, target ?? "about:blank")
    return partition
  }
  return {
    api,
    tabs,
    active: () => state.active,
    address: () => state.address,
    presentation: () => state.presentation,
    setAddress: (value: string) => setState("address", value),
    activate,
    addUserTab,
    activeAgent: () => tabs().some((tab) => tab.pageID === state.active && tab.agent),
    activeUserTab: () => tabs().find((tab) => tab.partition === state.active && !tab.agent),
    go(raw: string) {
      if (tabs().some((tab) => tab.pageID === state.active && tab.agent)) return
      const target = normalizeAddress(raw)
      if (!target) return
      if (!state.views[state.active]) addUserTab(raw)
      else navigate(state.active, target)
    },
    close(partition: string) {
      if (!api || disposed) return
      remove(partition, state.views[partition]?.epoch ?? 0)
      void api
        .close(partition)
        .catch((error) => console.warn(`[browser-tabs] close failed partition=${partition} error=${String(error)}`))
    },
    acknowledge(id: number) {
      if (disposed || !id || id !== state.presentation) return
      setState("presentation", 0)
      void api
        ?.acknowledgePresentation(id)
        .catch((error) => console.warn(`[browser-tabs] acknowledge failed request=${id} error=${String(error)}`))
    },
    start() {
      if (!api || disposed || started) return
      started = true
      stops.push(api.onUpdated(record), api.onClosed(remove), api.onPresented(present))
      void api
        .getPresentation()
        .then((request) => {
          if (request) present(request)
        })
        .catch((error) => console.warn(`[browser-tabs] presentation restore failed error=${String(error)}`))
      void api
        .getState()
        .then((snapshot) => {
          if (disposed) return
          batch(() => {
            for (const next of snapshot) if (!state.views[browserPageID(next)]) record(next)
            reconcile()
          })
          console.debug(`[browser-tabs] restored count=${tabs().length}`)
        })
        .catch((error) => console.warn(`[browser-tabs] restore failed error=${String(error)}`))
      console.debug("[browser-tabs] started")
    },
    dispose() {
      disposed = true
      for (const stop of stops.splice(0)) stop()
      pending.clear()
      console.debug("[browser-tabs] disposed")
    },
  }
}
