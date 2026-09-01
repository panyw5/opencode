import { createContext, useContext, type ParentProps } from "solid-js"
import type { SessionBarTab } from "@/context/layout"
import { sessionBarKey } from "@/context/layout"
import { sameWorkspacePath, workspaceKey } from "@/pages/layout/helpers"
import {
  collectSessionTabSubtree,
  groupSessionTabs,
  pickSessionTabNeighbor,
} from "@/components/session/session-tab-groups"

export type SessionTabsRoute = {
  directory: string
  id?: string
  session: boolean
}

export type SessionTabsTarget =
  | { type: "session"; directory: string; id: string }
  | { type: "draft"; directory: string }
  | { type: "home" }

export type SessionTabsClosePlan = {
  closing: SessionBarTab[]
  active: boolean
  target?: SessionTabsTarget
}

export type SessionTabsReconcileEntry = {
  tab: SessionBarTab
  state: "present" | "archived" | "deleted" | "unknown"
}

export type SessionTabsStoreAdapter = {
  all(): SessionBarTab[]
  drafts(): string[]
  open(tab: SessionBarTab): void
  closeAll(tabs: SessionBarTab[]): void
  openDraft(directory: string): void
  closeDraft(directory: string): void
  setInfo(
    directory: string,
    id: string,
    info: { directory?: string; title?: string; parentID?: string | null },
  ): string | undefined
}

export type SessionTabsPorts = {
  store: SessionTabsStoreAdapter
  route(): SessionTabsRoute
  parentID(tab: SessionBarTab): string | undefined
  prepare(target: SessionTabsTarget): Promise<void>
  navigate(target: SessionTabsTarget): void
  cool(tabs: SessionBarTab[]): void
  markViewed(id: string): void
  remember(directory: string, id: string, root?: string): void
  closeTimeoutMs?: number
  scheduleTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>
  cancelTimeout(timer: ReturnType<typeof setTimeout>): void
}

export type SessionTabsCoordinator = {
  observeRoute(
    route: SessionTabsRoute,
    meta?: { title?: string; parentID?: string | null; root?: string; hidden?: boolean },
  ): void
  ensureOpen(tab: SessionBarTab): boolean
  activate(target: SessionTabsTarget): Promise<boolean>
  updateMeta(
    directory: string,
    id: string,
    info: { directory?: string; title?: string; parentID?: string | null },
  ): void
  requestClose(tab: SessionBarTab): Promise<boolean>
  requestCloseDescendants(tab: SessionBarTab): Promise<boolean>
  requestCloseDraft(directory: string): Promise<boolean>
  promoteDraft(tab: SessionBarTab, draftDirectory?: string): void
  restore(tab: SessionBarTab): void
  restoreDirectory(directory: string): void
  beginReconcile(directory: string): number
  reconcileDirectory(input: { directory: string; epoch: number; entries: SessionTabsReconcileEntry[] }): Promise<boolean>
  remove(tab: SessionBarTab, reason: "archived" | "deleted" | "workspace-removed"): Promise<void>
  removeDirectory(directory: string, options?: { navigate?: boolean }): Promise<void>
  dispose(): void
}

const canonical = (value: string) => value.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, "")
const directoryEqual = (a: string, b: string) => canonical(a) === canonical(b)
const routeMatches = (route: SessionTabsRoute, tab: SessionBarTab) =>
  route.session && route.id === tab.id

type CloseHandoff =
  | {
      token: number
      type: "tabs"
      closing: SessionBarTab[]
      matches(route: SessionTabsRoute): boolean
    }
  | {
      token: number
      type: "draft"
      directory: string
      matches(route: SessionTabsRoute): boolean
    }

type CloseHandoffInput = CloseHandoff extends infer T ? (T extends unknown ? Omit<T, "token"> : never) : never

let closeHandoff: CloseHandoff | undefined
let closeSequence = 0

type LifecycleTombstone = {
  token: number
  reason: "archived" | "deleted" | "workspace-removed"
  directory: string
  workspaceEpoch?: number
}

const lifecycleTombstones = new Map<string, LifecycleTombstone>()
let lifecycleSequence = 0
const workspaceEpochs = new Map<string, number>()
const reconcileEpochs = new Map<string, number>()
let reconcileSequence = 0

const lifecycleReasonRank: Record<LifecycleTombstone["reason"], number> = {
  "workspace-removed": 0,
  archived: 1,
  deleted: 2,
}

type NavigationIntent = {
  token: number
  source: "activate" | "close" | "lifecycle" | "directory"
  target: SessionTabsTarget
  origin: string
  closeToken?: number
}

let navigationIntent: NavigationIntent | undefined
let navigationSequence = 0

const routeKey = (route: SessionTabsRoute) => {
  if (!route.session) return "home"
  if (!route.id) return `draft:${canonical(route.directory)}`
  return `session:${canonical(route.directory)}:${sessionBarKey({ directory: route.directory, id: route.id })}`
}

const targetKey = (target: SessionTabsTarget) => {
  if (target.type === "home") return "home"
  if (target.type === "draft") return `draft:${canonical(target.directory)}`
  return `session:${canonical(target.directory)}:${sessionBarKey(target)}`
}

const targetMatchesRoute = (target: SessionTabsTarget, route: SessionTabsRoute) => targetKey(target) === routeKey(route)

const targetMatchesTab = (target: SessionTabsTarget, tab: SessionBarTab) =>
  target.type === "session" && sessionBarKey(target) === sessionBarKey(tab)

const targetMatchesDraft = (target: SessionTabsTarget, directory: string) =>
  target.type === "draft" && directoryEqual(target.directory, directory)

export function planSessionTabClose(input: {
  tabs: SessionBarTab[]
  tab: SessionBarTab
  route: SessionTabsRoute
  parentID(tab: SessionBarTab): string | undefined
}): SessionTabsClosePlan | undefined {
  const key = sessionBarKey(input.tab)
  if (!input.tabs.some((item) => sessionBarKey(item) === key)) return

  const groups = groupSessionTabs(input.tabs, sessionBarKey, (tab) => {
    const parentID = input.parentID(tab)
    if (!parentID) return
    return sessionBarKey({ directory: tab.directory, id: parentID })
  })
  const subtree = collectSessionTabSubtree(
    input.tabs,
    sessionBarKey,
    (tab) => {
      const parentID = input.parentID(tab)
      if (!parentID) return
      return sessionBarKey({ directory: tab.directory, id: parentID })
    },
    key,
  )
  const closing = subtree.length > 0 ? subtree : [input.tab]
  const active = closing.some((item) => routeMatches(input.route, item))
  if (!active) return { closing, active }

  const closingKeys = new Set(closing.map(sessionBarKey))
  const roots = groups.map((group) => group.tab)
  const closedRoots = new Set(roots.filter((item) => closingKeys.has(sessionBarKey(item))).map(sessionBarKey))
  const neighbor = pickSessionTabNeighbor(groups, sessionBarKey, closedRoots, key)
  return {
    closing,
    active,
    target: neighbor
      ? { type: "session", directory: neighbor.directory, id: neighbor.id }
      : input.route.directory
        ? { type: "draft", directory: input.route.directory }
        : { type: "home" },
  }
}

export function createSessionTabsCoordinator(ports: SessionTabsPorts): SessionTabsCoordinator {
  type PendingClose = {
    token: number
    timer: ReturnType<typeof setTimeout>
  }

  let pending: PendingClose | undefined

  const clearNavigation = (value: NavigationIntent, reason: string) => {
    if (navigationIntent?.token !== value.token) return
    navigationIntent = undefined
    console.debug(
      `[session-tabs] navigation intent cleared token=${value.token} source=${value.source} target=${targetKey(value.target)} reason=${reason}`,
    )
  }

  const clearCloseNavigation = (token: number, reason: string) => {
    const intent = navigationIntent
    if (!intent || intent.closeToken !== token) return
    clearNavigation(intent, reason)
  }

  const beginNavigation = (
    target: SessionTabsTarget,
    source: NavigationIntent["source"],
    options?: { closeToken?: number },
  ) => {
    const previous = navigationIntent
    const value: NavigationIntent = {
      token: ++navigationSequence,
      source,
      target,
      origin: routeKey(ports.route()),
      closeToken: options?.closeToken,
    }
    navigationIntent = value
    if (previous) {
      console.debug(
        `[session-tabs] navigation intent superseded token=${previous.token} source=${previous.source} target=${targetKey(previous.target)} by=${value.token}`,
      )
    }
    console.debug(
      `[session-tabs] navigation intent started token=${value.token} source=${source} target=${targetKey(target)} origin=${value.origin}`,
    )
    return value
  }

  const ownsNavigation = (value: NavigationIntent) => navigationIntent?.token === value.token

  const invalidateTabNavigation = (tabs: SessionBarTab[], reason: string) => {
    const intent = navigationIntent
    if (!intent || !tabs.some((tab) => targetMatchesTab(intent.target, tab))) return
    clearNavigation(intent, reason)
  }

  const invalidateDraftNavigation = (directory: string, reason: string) => {
    const intent = navigationIntent
    if (!intent || !targetMatchesDraft(intent.target, directory)) return
    clearNavigation(intent, reason)
  }

  const observeNavigation = (route: SessionTabsRoute) => {
    const intent = navigationIntent
    if (!intent) return
    if (targetMatchesRoute(intent.target, route)) {
      clearNavigation(intent, "route-committed")
      return
    }
    if (routeKey(route) === intent.origin) return
    clearNavigation(intent, `route-diverged:${routeKey(route)}`)
  }

  const clearPending = (value = pending) => {
    if (!value) return
    ports.cancelTimeout(value.timer)
    clearCloseNavigation(value.token, "close-cleared")
    if (closeHandoff?.token === value.token) closeHandoff = undefined
    if (pending?.token === value.token) pending = undefined
  }

  const supersedePending = (reason: string) => {
    const token = closeHandoff?.token
    if (!token) return
    if (pending?.token === token) clearPending(pending)
    else {
      clearCloseNavigation(token, `close-superseded:${reason}`)
      closeHandoff = undefined
    }
    console.debug(`[session-tabs] close transaction superseded token=${token} reason=${reason}`)
  }

  const startPending = (input: CloseHandoffInput) => {
    clearPending()
    const token = ++closeSequence
    closeHandoff = { ...input, token } as CloseHandoff
    const value: PendingClose = {
      token,
      timer: ports.scheduleTimeout(() => {
        if (closeHandoff?.token !== token) return
        console.debug(`[session-tabs] close transaction timeout token=${token}`)
        clearCloseNavigation(token, "close-timeout")
        closeHandoff = undefined
        pending = undefined
      }, ports.closeTimeoutMs ?? 10_000),
    }
    pending = value
    return value
  }

  const commitPending = (route: SessionTabsRoute) => {
    const handoff = closeHandoff
    if (!handoff || handoff.matches(route)) return
    const value = pending
    if (value?.token === handoff.token) clearPending(value)
    else {
      clearCloseNavigation(handoff.token, "close-committed")
      closeHandoff = undefined
    }
    if (handoff.type === "tabs") {
      ports.store.closeAll(handoff.closing)
      ports.cool(handoff.closing)
    } else {
      ports.store.closeDraft(handoff.directory)
    }
    console.debug(`[session-tabs] close transaction committed token=${handoff.token}`)
  }

  const navigate = async (target: SessionTabsTarget, transaction: PendingClose) => {
    const intent = beginNavigation(target, "close", { closeToken: transaction.token })
    try {
      await ports.prepare(target)
      if (
        !ownsNavigation(intent) ||
        pending?.token !== transaction.token ||
        closeHandoff?.token !== transaction.token
      ) {
        console.debug(`[session-tabs] close transaction superseded token=${transaction.token}`)
        return false
      }
      ports.navigate(target)
      console.debug(
        `[session-tabs] navigation intent navigated token=${intent.token} source=${intent.source} target=${targetKey(target)}`,
      )
      return true
    } catch (error) {
      clearPending(transaction)
      console.debug(`[session-tabs] close transaction aborted token=${transaction.token} error=${String(error)}`)
      return false
    }
  }

  const ensureOpen = (tab: SessionBarTab, visiting = new Set<string>()): boolean => {
    const key = sessionBarKey(tab)
    if (visiting.has(key)) {
      console.warn(`[session-tabs] ensure open blocked parent cycle key=${key}`)
      return false
    }
    visiting.add(key)
    const tombstone = lifecycleTombstones.get(key)
    if (tombstone) {
      const workspaceEpoch = workspaceEpochs.get(workspaceKey(canonical(tab.directory))) ?? 0
      if (tombstone.reason === "workspace-removed" && (tombstone.workspaceEpoch ?? 0) < workspaceEpoch) {
        lifecycleTombstones.delete(key)
        console.debug(
          `[session-tabs] ensure open cleared stale workspace tombstone key=${key} ownerToken=${tombstone.token} tombstoneEpoch=${tombstone.workspaceEpoch ?? 0} workspaceEpoch=${workspaceEpoch}`,
        )
      } else {
        console.debug(
          `[session-tabs] ensure open blocked key=${key} ownerToken=${tombstone.token} reason=${tombstone.reason}`,
        )
        return false
      }
    }
    if (typeof tab.parentID === "string" && tab.parentID !== tab.id) {
      if (!ensureOpen({ directory: tab.directory, id: tab.parentID }, visiting)) return false
    }
    ports.store.open(tab)
    return true
  }

  const coordinator: SessionTabsCoordinator = {
    observeRoute(route, meta) {
      commitPending(route)
      observeNavigation(route)
      if (!route.session || !route.directory) return
      if (!route.id) {
        if (!meta?.hidden) ports.store.openDraft(route.directory)
        return
      }
      if (!meta?.hidden) {
        ensureOpen({ directory: route.directory, id: route.id, title: meta?.title, parentID: meta?.parentID })
      }
      ports.markViewed(route.id)
      ports.remember(route.directory, route.id, meta?.root)
    },
    ensureOpen,
    async activate(target) {
      const intent = beginNavigation(target, "activate")
      try {
        await ports.prepare(target)
        if (!ownsNavigation(intent)) {
          console.debug(
            `[session-tabs] activation superseded token=${intent.token} target=${targetKey(target)}`,
          )
          return false
        }
        ports.navigate(target)
        console.debug(
          `[session-tabs] navigation intent navigated token=${intent.token} source=${intent.source} target=${targetKey(target)}`,
        )
        return true
      } catch (error) {
        clearNavigation(intent, "activation-failed")
        console.debug(`[session-tabs] activation failed target=${target.type} error=${String(error)}`)
        return false
      }
    },
    updateMeta(directory, id, info) {
      const key = sessionBarKey({ directory, id })
      if (!ports.store.all().some((tab) => sessionBarKey(tab) === key)) {
        console.debug(`[session-tabs] metadata update skipped missing key=${key}`)
        return
      }
      const targetDirectory = ports.store.setInfo(directory, id, info)
      if (!targetDirectory) return
      if (typeof info.parentID !== "string" || info.parentID === id) return
      ensureOpen({ directory: targetDirectory, id: info.parentID })
    },
    async requestClose(tab) {
      const plan = planSessionTabClose({
        tabs: ports.store.all(),
        tab,
        route: ports.route(),
        parentID: ports.parentID,
      })
      if (!plan) return false
      if (!plan.active) {
        invalidateTabNavigation(plan.closing, "target-closed")
        ports.store.closeAll(plan.closing)
        ports.cool(plan.closing)
        return true
      }
      const target = plan.target
      if (!target) return false
      const closingKeys = new Set(plan.closing.map(sessionBarKey))
      const transaction = startPending({
        type: "tabs",
        closing: plan.closing,
        matches: (route) =>
          route.session &&
          !!route.id &&
          plan.closing.some((item) => routeMatches(route, item)) &&
          closingKeys.has(sessionBarKey({ directory: route.directory, id: route.id })),
      })
      console.debug(
        `[session-tabs] close transaction started token=${transaction.token} closing=${plan.closing.map((item) => item.id).join(",")} target=${target.type}`,
      )
      return navigate(target, transaction)
    },
    async requestCloseDescendants(tab) {
      const all = ports.store.all()
      const closing = collectSessionTabSubtree(
        all,
        sessionBarKey,
        (item) => {
          const parentID = ports.parentID(item)
          if (!parentID) return
          return sessionBarKey({ directory: item.directory, id: parentID })
        },
        sessionBarKey(tab),
      ).slice(1)
      if (closing.length === 0) return false
      const route = ports.route()
      const active = closing.some((item) => routeMatches(route, item))
      if (!active) {
        invalidateTabNavigation(closing, "target-descendant-closed")
        ports.store.closeAll(closing)
        ports.cool(closing)
        return true
      }
      const target: SessionTabsTarget = { type: "session", directory: tab.directory, id: tab.id }
      const transaction = startPending({
        type: "tabs",
        closing,
        matches: (value) => closing.some((item) => routeMatches(value, item)),
      })
      return navigate(target, transaction)
    },
    async requestCloseDraft(directory) {
      const route = ports.route()
      const active = route.session && !route.id && directoryEqual(route.directory, directory)
      console.debug(
        `[session-tabs] draft close requested directory=${directory} active=${active} routeDirectory=${route.directory || "none"} routeID=${route.id ?? "none"}`,
      )
      if (!active) {
        invalidateDraftNavigation(directory, "target-draft-closed")
        ports.store.closeDraft(directory)
        return true
      }
      const last = ports.store.all().at(-1)
      const otherDraft = ports.store.drafts().find((item) => !directoryEqual(item, directory))
      const target: SessionTabsTarget = last
        ? { type: "session", directory: last.directory, id: last.id }
        : otherDraft
          ? { type: "draft", directory: otherDraft }
          : { type: "home" }
      const transaction = startPending({
        type: "draft",
        directory,
        matches: (value) => value.session && !value.id && directoryEqual(value.directory, directory),
      })
      console.debug(`[session-tabs] draft close transaction started token=${transaction.token} target=${target.type}`)
      return navigate(target, transaction)
    },
    promoteDraft(tab, draftDirectory) {
      supersedePending("draft-promoted")
      const directory = draftDirectory ?? tab.directory
      invalidateDraftNavigation(directory, "target-draft-promoted")
      ports.store.closeDraft(directory)
      ensureOpen(tab)
    },
    restore(tab) {
      const key = sessionBarKey(tab)
      const owner = lifecycleTombstones.get(key)
      lifecycleTombstones.delete(key)
      console.debug(
        `[session-tabs] lifecycle restored key=${key} previousToken=${owner?.token ?? "none"} previousReason=${owner?.reason ?? "none"}`,
      )
    },
    restoreDirectory(directory) {
      const key = workspaceKey(canonical(directory))
      const epoch = (workspaceEpochs.get(key) ?? 0) + 1
      workspaceEpochs.set(key, epoch)
      let cleared = 0
      for (const [tabKey, owner] of lifecycleTombstones) {
        if (owner.reason !== "workspace-removed") continue
        if (!sameWorkspacePath(owner.directory, directory)) continue
        lifecycleTombstones.delete(tabKey)
        cleared += 1
      }
      console.debug(
        `[session-tabs] lifecycle directory restored directory=${directory} key=${key} epoch=${epoch} cleared=${cleared}`,
      )
    },
    beginReconcile(directory) {
      const key = workspaceKey(canonical(directory))
      const epoch = ++reconcileSequence
      reconcileEpochs.set(key, epoch)
      console.debug(`[session-tabs] reconcile reserved directory=${directory} key=${key} epoch=${epoch}`)
      return epoch
    },
    async reconcileDirectory(input) {
      const key = workspaceKey(canonical(input.directory))
      const current = reconcileEpochs.get(key) ?? 0
      if (input.epoch !== current) {
        console.debug(
          `[session-tabs] reconcile ignored stale directory=${input.directory} key=${key} epoch=${input.epoch} current=${current}`,
        )
        return false
      }
      console.debug(
        `[session-tabs] reconcile started directory=${input.directory} key=${key} epoch=${input.epoch} entries=${input.entries.length}`,
      )
      for (const entry of input.entries) {
        if ((reconcileEpochs.get(key) ?? 0) !== input.epoch) {
          console.debug(
            `[session-tabs] reconcile superseded directory=${input.directory} key=${key} epoch=${input.epoch}`,
          )
          return false
        }
        if (!directoryEqual(entry.tab.directory, input.directory)) continue
        if (entry.state === "unknown") {
          console.debug(`[session-tabs] reconcile retained unknown key=${sessionBarKey(entry.tab)} epoch=${input.epoch}`)
          continue
        }
        if (entry.state === "present") {
          coordinator.updateMeta(entry.tab.directory, entry.tab.id, {
            title: entry.tab.title,
            parentID: entry.tab.parentID ?? null,
          })
          continue
        }
        await coordinator.remove(entry.tab, entry.state)
      }
      console.debug(
        `[session-tabs] reconcile committed directory=${input.directory} key=${key} epoch=${input.epoch}`,
      )
      return true
    },
    async remove(tab, reason) {
      const key = sessionBarKey(tab)
      const existing = lifecycleTombstones.get(key)
      if (existing) {
        if (lifecycleReasonRank[reason] > lifecycleReasonRank[existing.reason]) {
          lifecycleTombstones.set(key, {
            ...existing,
            reason,
            directory: tab.directory,
            workspaceEpoch: undefined,
          })
          console.debug(
            `[session-tabs] lifecycle remove upgraded key=${key} token=${existing.token} from=${existing.reason} to=${reason}`,
          )
          return
        }
        console.debug(
          `[session-tabs] lifecycle remove duplicate key=${key} incomingReason=${reason} ownerToken=${existing.token} ownerReason=${existing.reason}`,
        )
        return
      }
      const owner: LifecycleTombstone = { token: ++lifecycleSequence, reason, directory: tab.directory }
      lifecycleTombstones.set(key, owner)
      console.debug(`[session-tabs] lifecycle remove owner key=${key} token=${owner.token} reason=${reason}`)
      supersedePending(`lifecycle-${reason}`)
      invalidateTabNavigation([tab], `target-${reason}`)
      const route = ports.route()
      const plan = planSessionTabClose({
        tabs: ports.store.all(),
        tab,
        route,
        parentID: ports.parentID,
      })
      if (plan) invalidateTabNavigation(plan.closing, `target-${reason}`)
      if (!plan) {
        if (!routeMatches(route, tab)) return
        const fallback = ports.store.all().at(-1)
        const target: SessionTabsTarget = fallback
          ? { type: "session", directory: fallback.directory, id: fallback.id }
          : { type: "draft", directory: route.directory }
        const intent = beginNavigation(target, "lifecycle")
        try {
          await ports.prepare(target)
          if (!ownsNavigation(intent) || lifecycleTombstones.get(key)?.token !== owner.token) {
            console.debug(
              `[session-tabs] lifecycle navigation superseded token=${intent.token} ownerToken=${owner.token} reason=${reason} id=${tab.id}`,
            )
            return
          }
          ports.navigate(target)
          console.debug(
            `[session-tabs] navigation intent navigated token=${intent.token} source=${intent.source} target=${targetKey(target)}`,
          )
        } catch (error) {
          clearNavigation(intent, "lifecycle-failed")
          console.debug(`[session-tabs] lifecycle missing-tab navigation failed id=${tab.id} error=${String(error)}`)
        }
        return
      }
      ports.store.closeAll(plan.closing)
      ports.cool(plan.closing)
      console.debug(`[session-tabs] lifecycle remove reason=${reason} id=${tab.id} active=${plan.active}`)
      if (!plan.active || !plan.target) return
      const intent = beginNavigation(plan.target, "lifecycle")
      try {
        await ports.prepare(plan.target)
        if (!ownsNavigation(intent) || lifecycleTombstones.get(key)?.token !== owner.token) {
          console.debug(
            `[session-tabs] lifecycle navigation superseded token=${intent.token} ownerToken=${owner.token} reason=${reason} id=${tab.id}`,
          )
          return
        }
        ports.navigate(plan.target)
        console.debug(
          `[session-tabs] navigation intent navigated token=${intent.token} source=${intent.source} target=${targetKey(plan.target)}`,
        )
      } catch (error) {
        clearNavigation(intent, "lifecycle-failed")
        console.debug(`[session-tabs] lifecycle navigation failed reason=${reason} id=${tab.id} error=${String(error)}`)
      }
    },
    async removeDirectory(directory, options) {
      supersedePending("directory-removed")
      const closing = ports.store.all().filter((tab) => directoryEqual(tab.directory, directory))
      invalidateTabNavigation(closing, "target-directory-removed")
      invalidateDraftNavigation(directory, "target-directory-removed")
      for (const tab of closing) {
        const key = sessionBarKey(tab)
        if (lifecycleTombstones.has(key)) continue
        const owner: LifecycleTombstone = {
          token: ++lifecycleSequence,
          reason: "workspace-removed",
          directory: tab.directory,
          workspaceEpoch: workspaceEpochs.get(workspaceKey(canonical(tab.directory))) ?? 0,
        }
        lifecycleTombstones.set(key, owner)
        console.debug(`[session-tabs] lifecycle remove owner key=${key} token=${owner.token} reason=${owner.reason}`)
      }
      ports.store.closeDraft(directory)
      if (closing.length === 0) return
      const route = ports.route()
      const active = closing.some((tab) => routeMatches(route, tab)) ||
        (route.session && directoryEqual(route.directory, directory))
      ports.store.closeAll(closing)
      ports.cool(closing)
      console.debug(
        `[session-tabs] lifecycle remove directory=${directory} tabs=${closing.map((tab) => tab.id).join(",")} active=${active}`,
      )
      if (!active || options?.navigate === false) return
      const fallback = ports.store.all().at(-1)
      const target: SessionTabsTarget = fallback
        ? { type: "session", directory: fallback.directory, id: fallback.id }
        : { type: "home" }
      const intent = beginNavigation(target, "directory")
      try {
        await ports.prepare(target)
        if (!ownsNavigation(intent)) {
          console.debug(
            `[session-tabs] directory navigation superseded token=${intent.token} directory=${directory}`,
          )
          return
        }
        ports.navigate(target)
        console.debug(
          `[session-tabs] navigation intent navigated token=${intent.token} source=${intent.source} target=${targetKey(target)}`,
        )
      } catch (error) {
        clearNavigation(intent, "directory-failed")
        console.debug(`[session-tabs] directory navigation failed directory=${directory} error=${String(error)}`)
      }
    },
    dispose() {
      // A server switch can remount the Solid adapter while navigation is in
      // flight. Keep the module-level handoff and navigation owner so the next
      // adapter can commit the route without reviving an older intent.
    },
  }
  return coordinator
}

const SessionTabsContext = createContext<SessionTabsCoordinator>()

export function SessionTabsProvider(props: ParentProps<{ value: SessionTabsCoordinator }>) {
  return <SessionTabsContext.Provider value={props.value}>{props.children}</SessionTabsContext.Provider>
}

export function useSessionTabs() {
  const value = useContext(SessionTabsContext)
  if (!value) throw new Error("useSessionTabs must be used within SessionTabsProvider")
  return value
}
