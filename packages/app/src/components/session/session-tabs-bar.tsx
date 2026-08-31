import { For, Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { useLocation, useParams } from "@solidjs/router"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  createSortable,
} from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"

import {
  cycleSessionBarIndex,
  sessionBarKey,
  useLayout,
  visibleSessionBarDrafts,
  type SessionBarTab,
} from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSettings } from "@/context/settings"
import { useSessionTabs } from "@/context/session-tabs"
import { dict as enDict } from "@/i18n/en"
import { decode64 } from "@/utils/base64"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { projectOwner, workspaceKey } from "@/pages/layout/helpers"
import { visiblyWorking } from "@/pages/session/session-working"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
import { permissionRequestNotFound } from "@/pages/session/composer/session-question-dock-helpers"
import {
  collectSessionTabSubtree,
  groupSessionTabs,
  reorderSessionTabGroups,
  type SessionTabGroup,
} from "./session-tab-groups"
import { pickWarmDirectories, shouldFetchTabMeta } from "./session-tab-warm"

const SESSION_TAB_PERMISSION_EXIT_MS = 160

const apiErrorStatus = (error: unknown) => {
  const value = error as { status?: unknown; cause?: { status?: unknown }; response?: { status?: unknown } }
  return value?.status ?? value?.cause?.status ?? value?.response?.status
}

/**
 * Global session tabs bar. One tab per open session, across projects.
 * The ordered tab list is persisted in the Layout context (`sessionBar`);
 * the active tab is derived from the current route.
 */
export function SessionTabsBar() {
  const layout = useLayout()
  const settings = useSettings()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const command = useCommand()
  const sessionTabs = useSessionTabs()
  const params = useParams()
  const location = useLocation()
  type DictKey = keyof typeof enDict
  const kw = (...keys: DictKey[]) => (language.locale() === "en" ? undefined : keys.map((k) => enDict[k]).join(" "))

  const [state, setState] = createStore({
    activeDraggable: undefined as string | undefined,
  })
  let tabsViewport: HTMLDivElement | undefined
  let revealFrame: number | undefined
  const metadataLoads = new Set<string>()

  const tabs = createMemo(() => layout.sessionBar.all())
  const drafts = createMemo(() => layout.sessionBar.drafts())
  const parentIDs = createMemo(() => {
    const result = new Map<string, string>()
    const directories = new Map<string, string>()
    for (const tab of tabs()) {
      directories.set(workspaceKey(tab.directory), tab.directory)
      if (typeof tab.parentID === "string") result.set(sessionBarKey(tab), tab.parentID)
    }

    for (const directory of directories.values()) {
      const [child] = globalSync.child(directory, { bootstrap: false })
      for (const session of child.session ?? []) {
        if (!session.parentID) continue
        result.set(sessionBarKey({ directory, id: session.id }), session.parentID)
      }
    }
    return result
  })
  const groups = createMemo(() =>
    groupSessionTabs(tabs(), sessionBarKey, (tab) => {
      const parentID = parentIDs().get(sessionBarKey(tab))
      if (!parentID) return undefined
      return sessionBarKey({ directory: tab.directory, id: parentID })
    }),
  )
  const groupsByKey = createMemo(() => new Map(groups().map((group) => [sessionBarKey(group.tab), group] as const)))
  const orderedTabs = createMemo(() =>
    groups().flatMap((group) => [group.tab, ...group.children.map((item) => item.tab)]),
  )
  const routeDir = createMemo(() => {
    const slug = params.dir
    if (!slug) return ""
    return decode64(slug) ?? ""
  })
  const onSessionRoute = createMemo(() => /\/session(?:\/|$)/.test(location.pathname))
  const activeTab = createMemo(() => {
    const id = params.id
    const directory = routeDir()
    if (!id || !directory) return undefined
    const key = sessionBarKey({ directory, id })
    return tabs().find((tab) => sessionBarKey(tab) === key)
  })
  const activeSession = createMemo(() => {
    const tab = activeTab()
    if (!tab) return undefined
    const [child] = globalSync.child(tab.directory, { bootstrap: false })
    return child.session.find((session) => session.id === tab.id)
  })
  const currentSessionTitle = createMemo(() => {
    const title = activeSession()?.title ?? activeTab()?.title
    return cleanTitle(title ?? language.t("session.tab.session"))
  })
  const projectName = (directory: string) => {
    const owner = projectOwner(directory, layout.projects.list())
    return owner?.project.name || getFilename(owner?.project.worktree ?? directory) || directory
  }
  // An id-less `/:dir/session` route is a not-yet-created session. Keep one
  // persisted draft tab per workspace until the first message promotes it.
  const draftDirectory = createMemo(() => {
    if (!onSessionRoute()) return ""
    if (params.id) return ""
    return routeDir()
  })
  const visibleDrafts = createMemo(() => visibleSessionBarDrafts(drafts(), draftDirectory()))
  const shown = createMemo(() => {
    if (!settings.general.sessionTabsBar()) return false
    return tabs().length > 0 || visibleDrafts().length > 0
  })

  const isActive = (tab: SessionBarTab) =>
    !!params.id && sessionBarKey(tab) === sessionBarKey({ directory: routeDir(), id: params.id })

  // Only the directory behind the active route warms its full session list on
  // cold start. Background-tab directories stay cold: their titles come from
  // the persisted tab state, and the first switch builds the backend instance.
  createEffect(() => {
    for (const directory of pickWarmDirectories(tabs(), routeDir())) {
      const [child] = globalSync.child(directory, { bootstrap: false })
      if (child.sessions === "ready" || child.sessions === "loading") continue
      void globalSync.project.loadSessions(directory, { silent: true })
    }
  })

  const reconciledDirectories = new Map<string, string>()
  const reconciliationInFlight = new Map<string, { marker: string; epoch: number }>()
  const reconcilePersistedTabs = async (directory: string, marker: string, snapshot: SessionBarTab[]) => {
    const key = workspaceKey(directory)
    if (reconciledDirectories.get(key) === marker) return
    if (reconciliationInFlight.get(key)?.marker === marker) return

    const epoch = sessionTabs.beginReconcile(directory)
    reconciliationInFlight.set(key, { marker, epoch })
    console.debug(
      `[session-tabs] persisted reconcile requested directory=${directory} marker=${marker} epoch=${epoch} tabs=${snapshot.length}`,
    )
    try {
      const client = globalSDK
        .forDomain(domainFromDirectory(directory))
        .createClient({ directory, throwOnError: false })
      console.debug(`[session-tabs] persisted reconcile client ready directory=${directory} epoch=${epoch}`)
      const entries = await Promise.all(
        snapshot.map(async (tab) => {
          try {
            const result = await client.session.get({ sessionID: tab.id })
            const value = result.data
            if (!value) {
              const status = result.response?.status
              console.debug(
                `[session-tabs] persisted reconcile probe directory=${tab.directory} id=${tab.id} epoch=${epoch} status=${String(status ?? "unknown")}`,
              )
              return { tab, state: status === 404 ? ("deleted" as const) : ("unknown" as const) }
            }
            return {
              tab: {
                directory: tab.directory,
                id: value.id,
                title: value.title,
                parentID: value.parentID,
              },
              state: value.time.archived ? ("archived" as const) : ("present" as const),
            }
          } catch (error) {
            const status = apiErrorStatus(error)
            console.debug(
              `[session-tabs] persisted reconcile probe directory=${tab.directory} id=${tab.id} epoch=${epoch} status=${String(status ?? "unknown")}`,
            )
            return { tab, state: status === 404 ? ("deleted" as const) : ("unknown" as const) }
          }
        }),
      )
      console.debug(
        `[session-tabs] persisted reconcile probes complete directory=${directory} epoch=${epoch} states=${entries.map((entry) => entry.state).join(",")}`,
      )
      const committed = await sessionTabs.reconcileDirectory({ directory, epoch, entries })
      if (committed && entries.every((entry) => entry.state !== "unknown")) {
        reconciledDirectories.set(key, marker)
      }
    } catch (error) {
      console.debug(
        `[session-tabs] persisted reconcile failed directory=${directory} epoch=${epoch} error=${String(error)}`,
      )
      await sessionTabs.reconcileDirectory({
        directory,
        epoch,
        entries: snapshot.map((tab) => ({ tab, state: "unknown" })),
      })
    } finally {
      if (reconciliationInFlight.get(key)?.epoch === epoch) reconciliationInFlight.delete(key)
    }
  }

  createEffect(() => {
    if (!layout.ready()) return
    const byDirectory = new Map<string, { directory: string; tabs: SessionBarTab[] }>()
    for (const tab of tabs()) {
      const key = workspaceKey(tab.directory)
      const found = byDirectory.get(key)
      if (found) found.tabs.push(tab)
      else byDirectory.set(key, { directory: tab.directory, tabs: [tab] })
    }
    for (const value of byDirectory.values()) {
      try {
        const runtime = globalSDK.forDomain(domainFromDirectory(value.directory))
        const marker = `${runtime.url}:${runtime.version}`
        void reconcilePersistedTabs(value.directory, marker, value.tabs.map((tab) => ({ ...tab })))
      } catch (error) {
        console.debug(
          `[session-tabs] persisted reconcile unavailable directory=${value.directory} error=${String(error)}`,
        )
      }
    }
  })

  const fetchTabMeta = (tab: SessionBarTab) => {
    const key = sessionBarKey(tab)
    if (metadataLoads.has(key)) return
    metadataLoads.add(key)
    void globalSync.session.info
      .ensure(tab.directory, tab.id)
      .then((value) => {
        if (!value) return
        sessionTabs.updateMeta(tab.directory, tab.id, {
          title: value.title,
          parentID: value.parentID ?? null,
        })
      })
      .catch(() => undefined)
      .finally(() => metadataLoads.delete(key))
  }

  createEffect(() => {
    for (const tab of tabs()) {
      if (tab.parentID !== undefined) continue
      const [child] = globalSync.child(tab.directory, { bootstrap: false })
      const sessionsReady = child.sessions === "ready"
      const session = sessionsReady ? child.session.find((item) => item.id === tab.id) : undefined
      if (shouldFetchTabMeta({ title: tab.title, sessionsReady, sessionInList: !!session })) {
        fetchTabMeta(tab)
        continue
      }
      if (session) {
        sessionTabs.updateMeta(tab.directory, tab.id, {
          title: session.title,
          parentID: session.parentID ?? null,
        })
      }
    }
  })

  const open = (tab: SessionBarTab) =>
    sessionTabs.activate({ type: "session", directory: tab.directory, id: tab.id })

  const openDraft = (directory: string) => sessionTabs.activate({ type: "draft", directory })

  const subtreeFor = (tab: SessionBarTab) => {
    const all = orderedTabs()
    const tabKey = sessionBarKey(tab)
    const parentByKey = parentIDs()
    return collectSessionTabSubtree(
      all,
      sessionBarKey,
      (item) => {
        const parentID = parentByKey.get(sessionBarKey(item))
        if (!parentID) return undefined
        return sessionBarKey({ directory: item.directory, id: parentID })
      },
      tabKey,
    )
  }

  const close = (tab: SessionBarTab) => {
    void sessionTabs.requestClose(tab)
  }

  const hasOpenDescendants = (tab: SessionBarTab) => subtreeFor(tab).length > 1

  const closeDescendants = (tab: SessionBarTab) => {
    void sessionTabs.requestCloseDescendants(tab)
  }

  const closeDraft = (directory = draftDirectory()) => {
    if (!directory) return
    console.debug(`[session-tabs] draft close delegated directory=${directory}`)
    void sessionTabs.requestCloseDraft(directory)
  }

  // Cycle through open tabs, then any persisted draft tabs at the end.
  // Only top-level session tabs are cycled: subagent child tabs live inside
  // their parent's group, so an active child maps onto its parent root tab.
  const switchBy = (delta: number) => {
    const roots = groups().map((group) => group.tab)
    const draftRoots = visibleDrafts()
    if (roots.length === 0 && draftRoots.length === 0) return
    const draftIndex = draftRoots.findIndex(
      (directory) => !params.id && workspaceKey(directory) === workspaceKey(routeDir()),
    )
    const sessionIndex = groups().findIndex(
      (group) => isActive(group.tab) || group.children.some((item) => isActive(item.tab)),
    )
    const index = draftIndex >= 0 ? roots.length + draftIndex : sessionIndex
    const next = cycleSessionBarIndex(roots.length + draftRoots.length, index, delta)
    if (next < 0) return
    if (next < roots.length) {
      const target = roots[next]
      if (!target) return
      console.debug(
        `[session-bar] switchBy delta=${delta} roots=${roots.map((tab) => tab.id).join(",")} drafts=${draftRoots.length} activeIndex=${index} target=${target.id}`,
      )
      void open(target)
      return
    }
    const directory = draftRoots[next - roots.length]
    if (!directory) return
    console.debug(
      `[session-bar] switchBy delta=${delta} roots=${roots.map((tab) => tab.id).join(",")} drafts=${draftRoots.length} activeIndex=${index} target=draft:${directory}`,
    )
    void openDraft(directory)
  }

  const closeActive = () => {
    if (draftDirectory()) {
      closeDraft()
      return
    }
    const active = tabs().find((tab) => isActive(tab))
    if (active) close(active)
  }

  command.register(() => [
    {
      id: "sessionTabs.close",
      title: language.t("command.sessionTabs.close"),
      keywords: kw("command.sessionTabs.close"),
      category: language.t("command.category.session"),
      disabled: !draftDirectory() && !tabs().some((tab) => isActive(tab)),
      onSelect: closeActive,
    },
    {
      id: "sessionTabs.previous",
      title: language.t("command.sessionTabs.previous"),
      keywords: kw("command.sessionTabs.previous"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+[",
      disabled: tabs().length === 0 && visibleDrafts().length === 0,
      onSelect: () => switchBy(-1),
    },
    {
      id: "sessionTabs.next",
      title: language.t("command.sessionTabs.next"),
      keywords: kw("command.sessionTabs.next"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+]",
      disabled: tabs().length === 0 && visibleDrafts().length === 0,
      onSelect: () => switchBy(1),
    },
  ])

  const keys = createMemo(() => groups().map((group) => sessionBarKey(group.tab)))
  const scrollTarget = createMemo(() => {
    const draft = draftDirectory()
    if (draft) return `draft:${workspaceKey(draft)}:${tabs().length}:${visibleDrafts().length}`
    const active = tabs().find((tab) => isActive(tab))
    if (!active) return
    return `${sessionBarKey(active)}:${tabs().length}`
  })

  const compactSessionItem = (tab: SessionBarTab) => {
    const active = isActive(tab)
    const title = () => cleanTitle(tab.title ?? language.t("session.tab.session"))
    return (
      <DropdownMenu.Item
        class="min-w-0"
        classList={{ "bg-surface-interactive-weak-hover": active }}
        onSelect={() => void open(tab)}
        aria-current={active ? "page" : undefined}
      >
        <span class="flex size-5 shrink-0 items-center justify-center text-icon-weak" aria-hidden="true">
          <Icon
            name={tab.parentID ? "branch" : "bubble-5"}
            size="small"
            classList={{ "[transform:scaleY(-1)]": !!tab.parentID }}
          />
        </span>
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
            {title()}
          </DropdownMenu.ItemLabel>
          <DropdownMenu.ItemDescription class="max-w-[42%] shrink-0 truncate text-right text-11-regular text-text-weak">
            {projectName(tab.directory)}
          </DropdownMenu.ItemDescription>
        </div>
        <Show when={active}>
          <Icon name="check-small" size="small" class="shrink-0 text-icon-weak" />
        </Show>
      </DropdownMenu.Item>
    )
  }

  createEffect(() => {
    const target = scrollTarget()
    if (!shown() || !target) return

    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
    revealFrame = requestAnimationFrame(() => {
      revealFrame = undefined
      tabsViewport
        ?.querySelector<HTMLElement>('[data-component="session-tab"][data-active="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" })
    })
  })

  onCleanup(() => {
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setState("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return
    const reordered = reorderSessionTabGroups(groups(), draggable.id.toString(), droppable.id.toString(), sessionBarKey)
    layout.sessionBar.setOrder(
      reordered.flatMap((group) => [group.tab, ...group.children.map((item) => item.tab)]).map(sessionBarKey),
    )
  }

  const handleDragEnd = () => {
    setState("activeDraggable", undefined)
  }

  return (
    <div
      data-component="session-tabs-bar"
      role="toolbar"
      aria-label={language.t("session.tabs.bar.label")}
      class="flex h-full min-w-0 flex-1 items-center gap-1 px-1"
      style={{ "--tabs-bar-height": "36px" }}
    >
      <Show when={onSessionRoute()}>
        <div class="relative flex min-w-0 flex-1 items-center xl:hidden">
          <div class="pointer-events-none absolute inset-x-0 flex min-w-0 items-center justify-center px-12">
            <span class="max-w-[48%] truncate text-13-medium text-text-strong">{currentSessionTitle()}</span>
          </div>
          <DropdownMenu gutter={4} placement="bottom-start">
            <div class="ml-auto flex min-w-0 max-w-[48%] items-center gap-1 rounded-md px-2">
              <span class="min-w-0 truncate text-11-regular text-text-weak">{projectName(routeDir())}</span>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="chevron-down"
                variant="ghost"
                class="titlebar-icon size-7 shrink-0 rounded-md p-0 text-icon-weak hover:text-icon-base data-[expanded]:bg-surface-base-active"
                aria-label={language.t("session.tabs.bar.label")}
              />
            </div>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                class="session-child-agent-scrollbar w-[520px] max-w-[calc(100vw-32px)]"
                style={{
                  "max-height": "min(520px, calc(100dvh - 64px))",
                  "overflow-y": "auto",
                  "overscroll-behavior": "contain",
                }}
              >
                <DropdownMenu.Group>
                  <For each={orderedTabs()}>{(tab) => compactSessionItem(tab)}</For>
                  <For each={visibleDrafts()}>
                    {(directory) => (
                      <DropdownMenu.Item class="min-w-0" onSelect={() => void openDraft(directory)}>
                        <span
                          class="flex size-5 shrink-0 items-center justify-center text-icon-weak"
                          aria-hidden="true"
                        >
                          <Icon name="bubble-5" size="small" />
                        </span>
                        <div class="flex min-w-0 flex-1 items-center gap-3">
                          <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
                            {language.t("session.tab.session")}
                          </DropdownMenu.ItemLabel>
                          <DropdownMenu.ItemDescription class="max-w-[42%] shrink-0 truncate text-right text-11-regular text-text-weak">
                            {projectName(directory)}
                          </DropdownMenu.ItemDescription>
                        </div>
                      </DropdownMenu.Item>
                    )}
                  </For>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </Show>
      <Show when={shown()}>
        <div class="hidden min-w-0 flex-1 items-center xl:flex">
          <DragDropProvider
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <div ref={tabsViewport} class="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
              <SortableProvider ids={keys()}>
                <For each={keys()}>
                  {(key) => (
                    <SessionTabGroup
                      tabKey={key}
                      group={() => groupsByKey().get(key)}
                      active={(tab) => isActive(tab)}
                      hasOpenDescendants={hasOpenDescendants}
                      onOpen={(tab) => void open(tab)}
                      onClose={close}
                      onCloseDescendants={closeDescendants}
                    />
                  )}
                </For>
              </SortableProvider>
              <For each={visibleDrafts()}>
                {(directory) => (
                  <DraftTab
                    directory={directory}
                    active={!params.id && workspaceKey(directory) === workspaceKey(routeDir())}
                    onOpen={() => void openDraft(directory)}
                    onClose={() => closeDraft(directory)}
                  />
                )}
              </For>
            </div>
            <DragOverlay>
              <Show when={state.activeDraggable} keyed>
                {(key) => {
                  const title = () => tabs().find((item) => sessionBarKey(item) === key)?.title
                  return (
                    <div data-component="tabs-drag-preview">
                      <span class="truncate px-2 text-13-medium">{title() ?? ""}</span>
                    </div>
                  )
                }}
              </Show>
            </DragOverlay>
          </DragDropProvider>
        </div>
      </Show>
    </div>
  )
}

/** Drop internal routing markers (`[im:name]`, `[scheduled]`) from session titles for display. */
const cleanTitle = (value: string) => {
  const stripped = value.replace(/^\[im:[^\]]*\]\s*/, "").replace(/^\[scheduled\]\s*/, "")
  return stripped || value
}

const sessionTabPermissionLayoutEvent = "opencode:session-tab-permission-layout"

function SessionTabGroup(props: {
  tabKey: string
  group: () => SessionTabGroup<SessionBarTab> | undefined
  active: (tab: SessionBarTab) => boolean
  hasOpenDescendants: (tab: SessionBarTab) => boolean
  onOpen: (tab: SessionBarTab) => void
  onClose: (tab: SessionBarTab) => void
  onCloseDescendants: (tab: SessionBarTab) => void
}) {
  const autoRevealDuration = 500
  const sortable = createSortable(props.tabKey)
  const [state, setState] = createStore({ open: false })
  let closeTimer: number | undefined
  let autoCloseTimer: number | undefined
  let revealFrame: number | undefined
  let childrenViewport: HTMLDivElement | undefined
  let skipAutoRevealID: string | undefined
  let parentContextMenuOpen = false
  const group = () => {
    const value = props.group()
    if (!value) throw new Error(`Missing session tab group: ${props.tabKey}`)
    return value
  }

  createEffect(() => {
    if (group().children.length > 0) return
    setState("open", false)
  })

  const cancelClose = () => {
    if (closeTimer === undefined) return
    window.clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const cancelAutoClose = () => {
    if (autoCloseTimer === undefined) return
    window.clearTimeout(autoCloseTimer)
    autoCloseTimer = undefined
  }
  const open = () => {
    if (parentContextMenuOpen) return
    if (!group().children.length) return
    cancelClose()
    cancelAutoClose()
    setState("open", true)
  }
  const close = () => {
    cancelClose()
    cancelAutoClose()
    closeTimer = window.setTimeout(() => {
      closeTimer = undefined
      setState("open", false)
    }, 150)
  }
  const activeChildID = createMemo(() => group().children.find((item) => props.active(item.tab))?.tab.id)

  createEffect(
    on(activeChildID, (childID, previousChildID) => {
      if (!childID) return
      const value = group()
      if (!value.children.length) return
      if (skipAutoRevealID === childID) {
        skipAutoRevealID = undefined
        cancelClose()
        cancelAutoClose()
        console.debug(
          `[session-bar] skip auto reveal for clicked child id=${childID} parent=${value.tab.id} previous=${previousChildID ?? "none"}`,
        )
        return
      }
      cancelClose()
      cancelAutoClose()
      setState("open", true)
      console.debug(
        `[session-bar] auto reveal child id=${childID} parent=${value.tab.id} previous=${previousChildID ?? "none"}`,
      )
      if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
      revealFrame = requestAnimationFrame(() => {
        revealFrame = undefined
        childrenViewport
          ?.querySelector<HTMLElement>('[data-component="session-tab"][data-active="true"]')
          ?.scrollIntoView({ block: "nearest" })
      })
      autoCloseTimer = window.setTimeout(() => {
        autoCloseTimer = undefined
        setState("open", false)
        console.debug(`[session-bar] auto hide child id=${childID} parent=${value.tab.id}`)
      }, autoRevealDuration)
    }),
  )
  const groupActive = () => {
    const value = group()
    return props.active(value.tab) || value.children.some((item) => props.active(item.tab))
  }
  const trigger = () => (
    <div
      class="flex h-full min-w-28 items-center"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocusIn={open}
      onFocusOut={close}
    >
      <SessionTab
        tab={group().tab}
        active={groupActive()}
        relatedTabs={group().children.map((item) => item.tab)}
        childCount={group().children.length}
        preventPopoverToggle
        hasOpenDescendants={props.hasOpenDescendants(group().tab)}
        onMenuOpenChange={(open) => {
          parentContextMenuOpen = open
          if (open) {
            cancelAutoClose()
            setState("open", false)
          }
        }}
        onOpen={() => props.onOpen(group().tab)}
        onClose={() => props.onClose(group().tab)}
        onCloseDescendants={() => props.onCloseDescendants(group().tab)}
      />
    </div>
  )

  onCleanup(() => {
    cancelClose()
    cancelAutoClose()
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  })

  return (
    <div use:sortable class="h-full flex min-w-28 items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <Show when={group().children.length} fallback={trigger()}>
        <Popover
          open={state.open}
          onOpenChange={(open) => setState("open", open)}
          placement="bottom-start"
          class="session-tab-children-popover"
          trigger={trigger()}
          triggerProps={{ role: "presentation", tabIndex: -1, class: "min-w-28" }}
        >
          <div
            ref={childrenViewport}
            data-component="session-tab-children"
            class="session-child-agent-scrollbar flex max-h-80 min-w-56 flex-col gap-1.5 overflow-y-auto"
            onMouseEnter={open}
            onMouseLeave={close}
            onFocusIn={open}
            onFocusOut={close}
          >
            <For each={group().children}>
              {(item) => (
                <div class="flex min-w-0" style={{ "padding-left": `${(item.depth - 1) * 12}px` }}>
                  <SessionTab
                    tab={item.tab}
                    active={props.active(item.tab)}
                    nested
                    hasOpenDescendants={props.hasOpenDescendants(item.tab)}
                    onMenuOpenChange={(menuOpen) => {
                      if (menuOpen) {
                        cancelClose()
                        cancelAutoClose()
                        setState("open", true)
                        return
                      }
                      close()
                    }}
                    onOpen={() => {
                      if (!props.active(item.tab)) skipAutoRevealID = item.tab.id
                      setState("open", false)
                      props.onOpen(item.tab)
                    }}
                    onClose={() => props.onClose(item.tab)}
                    onCloseDescendants={() => props.onCloseDescendants(item.tab)}
                  />
                </div>
              )}
            </For>
          </div>
        </Popover>
      </Show>
    </div>
  )
}

function SessionTab(props: {
  tab: SessionBarTab
  active: boolean
  nested?: boolean
  relatedTabs?: SessionBarTab[]
  childCount?: number
  preventPopoverToggle?: boolean
  hasOpenDescendants: boolean
  onMenuOpenChange?: (open: boolean) => void
  onOpen: () => void
  onClose: () => void
  onCloseDescendants: () => void
}) {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const sessionTabs = useSessionTabs()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const dialog = useDialog()
  const [state, setState] = createStore({ generatingTitle: false })
  const [child] = globalSync.child(props.tab.directory, { bootstrap: false })
  let triggerEl: HTMLElement | undefined

  const session = createMemo(() => (child.session ?? []).find((item) => item.id === props.tab.id))
  const subagent = createMemo(() => !!(session()?.parentID ?? props.tab.parentID))
  const title = createMemo(() => {
    const raw = session()?.title || props.tab.title
    if (!raw) return language.t("session.tab.session")
    return cleanTitle(raw)
  })

  // Keep persisted tab metadata fresh so labels and parent grouping are available
  // immediately after a restart, before project sessions finish loading.
  createEffect(() => {
    const value = session()
    if (!value) return
    if (value.title === props.tab.title && value.parentID === props.tab.parentID) return
    sessionTabs.updateMeta(props.tab.directory, props.tab.id, {
      title: value.title,
      parentID: value.parentID ?? null,
    })
  })

  const groupTabs = () => [props.tab, ...(props.relatedTabs ?? [])]
  const busy = createMemo(() =>
    groupTabs().some((tab) =>
      visiblyWorking(globalSync.session.status.get(props.tab.directory, tab.id), child.message[tab.id]),
    ),
  )
  const unseen = createMemo(() =>
    groupTabs().reduce((total, tab) => total + notification.session.unseenCount(tab.id), 0),
  )
  const permissionRequest = createMemo(() => {
    return sessionPermissionRequest(child.session, child.permission, props.tab.id, (item) => {
      return !permission.autoResponds(item, props.tab.directory)
    })
  })
  const [permissionCapsule, setPermissionCapsule] = createStore({
    request: undefined as PermissionRequest | undefined,
    closing: false,
  })
  let permissionCloseTimer: number | undefined
  createEffect(() => {
    const request = permissionRequest()
    if (request) {
      if (permissionCloseTimer !== undefined) window.clearTimeout(permissionCloseTimer)
      permissionCloseTimer = undefined
      setPermissionCapsule({ request, closing: false })
      return
    }
    if (!permissionCapsule.request || permissionCapsule.closing) return
    setPermissionCapsule("closing", true)
    console.debug(
      `[session-tab-permission] close animation request=${permissionCapsule.request.id} session=${permissionCapsule.request.sessionID}`,
    )
    permissionCloseTimer = window.setTimeout(() => {
      permissionCloseTimer = undefined
      setPermissionCapsule({ request: undefined, closing: false })
    }, SESSION_TAB_PERMISSION_EXIT_MS)
  })
  onCleanup(() => {
    if (permissionCloseTimer !== undefined) window.clearTimeout(permissionCloseTimer)
  })
  let permissionLog = ""
  createEffect(() => {
    const requestCount = Object.values(child.permission).reduce((total, items) => total + (items?.length ?? 0), 0)
    const selected = permissionRequest()
    const next = `${requestCount}:${selected?.id ?? "none"}`
    if (next === permissionLog) return
    permissionLog = next
    console.debug(
      `[session-tab-permission] state tab=${props.tab.id} sessions=${child.session.length} requests=${requestCount} selected=${selected?.id ?? "none"}`,
    )
  })

  const copy = () => {
    const text = `Session ID: ${props.tab.id}\nProject path: ${props.tab.directory}`
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[session-tab] copy info id=${props.tab.id} dir=${props.tab.directory}`)
    if (!clipboard?.writeText) {
      console.debug(`[session-tab] clipboard unavailable id=${props.tab.id}`)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: "Clipboard unavailable",
      })
      return
    }
    void clipboard.writeText(text).then(
      () => {
        console.debug(`[session-tab] copied info id=${props.tab.id} dir=${props.tab.directory}`)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: text,
        })
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.debug(`[session-tab] copy failed id=${props.tab.id} err=${message}`)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: message,
        })
      },
    )
  }

  const showInSidebar = () => {
    const owner = projectOwner(props.tab.directory, layout.projects.list())
    if (!owner) {
      console.debug(
        `[session-tab] show in sidebar ignored id=${props.tab.id} dir=${props.tab.directory} reason=no-project`,
      )
      return
    }

    console.debug(
      `[session-tab] show in sidebar id=${props.tab.id} dir=${props.tab.directory} root=${owner.root} sandbox=${String(owner.sandbox)}`,
    )
    layout.sidebar.setProject(owner.root)
    layout.sidebar.open()
  }

  const generateTitle = () => {
    if (state.generatingTitle) {
      console.debug(`[session-tab] generate title ignored id=${props.tab.id} reason=in-flight`)
      return
    }

    setState("generatingTitle", true)
    const domain = domainFromDirectory(props.tab.directory)
    console.debug(`[session-tab] generate title start id=${props.tab.id} dir=${props.tab.directory} domain=${domain}`)
    const [, setSessionStore] = globalSync.child(props.tab.directory, { bootstrap: false })
    void globalSDK
      .forDomain(domain)
      .client.session.generateTitle(
        {
          sessionID: props.tab.id,
          directory: props.tab.directory,
        },
        { throwOnError: true },
      )
      .then(
        (result) => {
          const data =
            result && typeof result === "object" && "data" in result
              ? (result as { data?: Session }).data
              : (result as Session | undefined)
          console.debug(`[session-tab] generate title response id=${props.tab.id} title=${data?.title ?? ""}`)
          if (data?.title) {
            setSessionStore("session", (list) =>
              list.map((item) => (item.id === props.tab.id ? { ...item, title: data.title } : item)),
            )
            sessionTabs.updateMeta(props.tab.directory, props.tab.id, {
              title: data.title,
              parentID: data.parentID ?? props.tab.parentID ?? null,
            })
            console.debug(`[session-tab] generate title state updated id=${props.tab.id}`)
          }
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("toast.session.generateTitle.success.title"),
            description: data?.title,
          })
        },
        (err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
          console.debug(`[session-tab] generate title failed id=${props.tab.id} err=${message}`)
          showToast({
            variant: "error",
            title: language.t("toast.session.generateTitle.failed.title"),
            description: message,
          })
        },
      )
      .finally(() => {
        setState("generatingTitle", false)
        console.debug(`[session-tab] generate title settled id=${props.tab.id}`)
      })
  }

  const editTitle = () => {
    console.debug(`[session-tab] edit title open id=${props.tab.id} dir=${props.tab.directory}`)
    dialog.show(() => (
      <DialogEditSessionTitle directory={props.tab.directory} sessionID={props.tab.id} initialTitle={title()} />
    ))
  }

  return (
    <ContextMenu modal={false} onOpenChange={props.onMenuOpenChange}>
      <ContextMenu.Trigger
        ref={(el: HTMLElement) => (triggerEl = el)}
        as="div"
        role="button"
        tabIndex={0}
        data-component="session-tab"
        data-session-id={props.tab.id}
        data-directory={props.tab.directory}
        data-active={props.active ? "true" : undefined}
        data-subagent={subagent() ? "true" : undefined}
        data-permission={!props.nested && permissionCapsule.request ? "true" : undefined}
        class="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 text-13-medium"
        classList={{
          "h-7 min-w-28 max-w-80": !props.nested,
          "w-full min-w-0 max-w-72 py-1.5": !!props.nested,
          "bg-surface-interactive-weak-hover text-text-strong": props.active,
          "session-tab-inactive text-text-weak hover:bg-surface-base-hover hover:text-text-base": !props.active,
        }}
        onClick={(event: MouseEvent) => {
          if (props.preventPopoverToggle) event.stopPropagation()
          props.onOpen()
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          if (props.preventPopoverToggle) event.stopPropagation()
          props.onOpen()
        }}
        onMouseDown={(event: MouseEvent) => {
          if (event.button === 1) event.preventDefault()
        }}
        onAuxClick={(event: MouseEvent) => {
          if (event.button !== 1) return
          event.preventDefault()
          props.onClose()
        }}
      >
        <Show
          when={subagent()}
          fallback={
            <span class="session-tab-main-icon flex shrink-0" aria-hidden="true">
              <Icon name="bubble-5" size="small" />
            </span>
          }
        >
          <span class="flex shrink-0 text-icon-weak [transform:scaleY(-1)]" aria-hidden="true">
            <Icon name="branch" size="small" />
          </span>
        </Show>
        <span class="min-w-0 flex-1 truncate">{title()}</span>
        <Show when={busy()}>
          <span
            class="size-1.5 shrink-0 animate-pulse rounded-full"
            style={{ "background-color": "var(--icon-base)" }}
            aria-hidden
          />
        </Show>
        <Show when={!busy() && unseen() > 0}>
          <span
            class="size-1.5 shrink-0 rounded-full"
            style={{ "background-color": "var(--surface-info-base)" }}
            aria-hidden
          />
        </Show>
        <Show when={(props.childCount ?? 0) > 0}>
          <span
            data-slot="session-tab-child-count"
            class="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-base-active px-1 text-10-medium text-text-weaker"
            aria-hidden="true"
          >
            <Icon name="branch" size="small" class="[transform:scaleY(-1)]" />
            {props.childCount}
          </span>
        </Show>
        <span
          data-action="session-tab-close"
          class="session-tab-close flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base transition-[opacity,background-color,color,box-shadow]"
          classList={{
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": !props.active,
            "opacity-100": props.active,
          }}
          role="button"
          tabIndex={-1}
          aria-label={language.t("common.closeTab")}
          onClick={(event) => {
            event.stopPropagation()
            props.onClose()
          }}
        >
          <Icon name="close-small" size="small" />
        </span>
      </ContextMenu.Trigger>
      <Show when={!props.nested && permissionCapsule.request} keyed>
        {(request) => (
          <SessionTabPermissionCapsule
            request={request}
            directory={props.tab.directory}
            anchor={() => triggerEl}
            closing={permissionCapsule.closing}
            onView={props.onOpen}
          />
        )}
      </Show>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item
            data-action="session-tab-show-in-sidebar"
            data-session={base64Encode(props.tab.id)}
            onSelect={showInSidebar}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="sidebar" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("command.sessionTabs.showInSidebar")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="session-tab-generate-title"
            data-session={base64Encode(props.tab.id)}
            disabled={state.generatingTitle}
            onSelect={generateTitle}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="refresh" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("session.generateTitle")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="session-tab-edit-title"
            data-session={base64Encode(props.tab.id)}
            onSelect={editTitle}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="edit" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("session.editTitle")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="session-tab-close-descendants"
            data-session={base64Encode(props.tab.id)}
            disabled={!props.hasOpenDescendants}
            onSelect={props.onCloseDescendants}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base [transform:scaleY(-1)]">
                <Icon name="branch" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("command.sessionTabs.closeDescendants")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="session-tab-close"
            data-session={base64Encode(props.tab.id)}
            onSelect={props.onClose}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="close-small" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("command.sessionTabs.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="session-tab-copy-info"
            data-session={base64Encode(props.tab.id)}
            onSelect={copy}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="copy" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("session.copyInfo")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

function DialogEditSessionTitle(props: { directory: string; sessionID: string; initialTitle: string }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ title: props.initialTitle, saving: false })

  const save = () => {
    if (state.saving) return
    const title = state.title.trim()
    if (!title) return
    const domain = domainFromDirectory(props.directory)
    setState("saving", true)
    console.debug(`[session-tab] edit title start id=${props.sessionID} dir=${props.directory} domain=${domain}`)
    const [, setSessionStore] = globalSync.child(props.directory, { bootstrap: false })
    void globalSDK
      .forDomain(domain)
      .client.session.update(
        {
          sessionID: props.sessionID,
          directory: props.directory,
          title,
        },
        { throwOnError: true },
      )
      .then(
        () => {
          setSessionStore("session", (list) =>
            list.map((item) => (item.id === props.sessionID ? { ...item, title } : item)),
          )
          dialog.close()
          console.debug(`[session-tab] edit title saved id=${props.sessionID} title=${title}`)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("toast.session.updateTitle.success.title"),
            description: title,
          })
        },
        (err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
          console.debug(`[session-tab] edit title failed id=${props.sessionID} err=${message}`)
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: message,
          })
        },
      )
      .finally(() => {
        setState("saving", false)
        console.debug(`[session-tab] edit title settled id=${props.sessionID}`)
      })
  }

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault()
    save()
  }

  return (
    <Dialog title={language.t("session.editTitle")} fit class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-6 p-6 pt-0">
        <TextField
          autofocus
          type="text"
          placeholder={language.t("session.editTitle.placeholder")}
          value={state.title}
          onChange={(v) => setState("title", v)}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            save()
          }}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={state.saving || !state.title.trim()}>
            {state.saving ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SessionTabPermissionCapsule(props: {
  request: PermissionRequest
  directory: string
  anchor: () => HTMLElement | undefined
  closing: boolean
  onView: () => void
}) {
  const mountedAt = performance.now()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [state, setState] = createStore({
    responding: false,
    left: 8,
    top: 8,
    positioned: false,
  })
  let capsuleEl: HTMLDivElement | undefined
  let animationFrame: number | undefined

  createEffect(() => {
    const state = props.closing ? "closing" : "open"
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = undefined
      if (!capsuleEl) return
      const style = getComputedStyle(capsuleEl)
      console.debug(
        `[session-tab-permission] animation style request=${props.request.id} state=${state} elapsed=${Math.round(performance.now() - mountedAt)}ms name=${style.animationName} duration=${style.animationDuration} visibility=${style.visibility} opacity=${style.opacity} transform=${style.transform} reduced=${String(window.matchMedia("(prefers-reduced-motion: reduce)").matches)}`,
      )
    })
  })

  const position = () => {
    const anchor = props.anchor()
    if (!anchor || !capsuleEl) return
    const rect = anchor.getBoundingClientRect()
    const width = capsuleEl.offsetWidth
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const permissionTabs = Array.from(
      document.querySelectorAll<HTMLElement>('[data-component="session-tab"][data-permission="true"]'),
    )
    const stackIndex = Math.max(0, permissionTabs.indexOf(anchor))
    const top = rect.bottom + 6 + stackIndex * (capsuleEl.offsetHeight + 4)
    setState({ left, top, positioned: true })
    console.debug(
      `[session-tab-permission] positioned request=${props.request.id} session=${props.request.sessionID} elapsed=${Math.round(performance.now() - mountedAt)}ms stack=${stackIndex} left=${Math.round(left)} top=${Math.round(top)} width=${width}`,
    )
  }

  createEffect(() => {
    console.debug(
      `[session-tab-permission] show request=${props.request.id} session=${props.request.sessionID} directory=${props.directory}`,
    )
    const frame = window.requestAnimationFrame(() => {
      position()
      window.dispatchEvent(new Event(sessionTabPermissionLayoutEvent))
    })
    const anchor = props.anchor()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position)
    if (anchor) observer?.observe(anchor)
    if (capsuleEl) observer?.observe(capsuleEl)
    window.addEventListener("resize", position)
    window.addEventListener("scroll", position, true)
    window.addEventListener(sessionTabPermissionLayoutEvent, position)
    onCleanup(() => {
      window.cancelAnimationFrame(frame)
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
      observer?.disconnect()
      window.removeEventListener("resize", position)
      window.removeEventListener("scroll", position, true)
      window.removeEventListener(sessionTabPermissionLayoutEvent, position)
      window.requestAnimationFrame(() => window.dispatchEvent(new Event(sessionTabPermissionLayoutEvent)))
      console.debug(`[session-tab-permission] hide request=${props.request.id} session=${props.request.sessionID}`)
    })
  })

  const removeLocal = () => {
    const [, setChild] = globalSync.child(props.directory, { bootstrap: false })
    setChild(
      "permission",
      props.request.sessionID,
      produce((draft = []) => {
        const index = draft.findIndex((item) => item.id === props.request.id)
        if (index !== -1) draft.splice(index, 1)
        return draft
      }),
    )
  }

  const decide = (response: "once" | "reject") => {
    if (state.responding) {
      console.debug(`[session-tab-permission] decide ignored request=${props.request.id} reason=in-flight`)
      return
    }
    setState("responding", true)
    console.debug(
      `[session-tab-permission] decide start request=${props.request.id} session=${props.request.sessionID} response=${response}`,
    )
    void globalSDK
      .forDomain(domainFromDirectory(props.directory))
      .client.permission.respond({
        sessionID: props.request.sessionID,
        permissionID: props.request.id,
        response,
        directory: props.directory,
      })
      .then(() => {
        console.debug(
          `[session-tab-permission] decide success request=${props.request.id} session=${props.request.sessionID} response=${response}`,
        )
        removeLocal()
      })
      .catch((error: unknown) => {
        if (permissionRequestNotFound(error, props.request.id)) {
          console.warn(
            `[session-tab-permission] stale request=${props.request.id} session=${props.request.sessionID} response=${response}`,
          )
          removeLocal()
          return
        }
        const description = error instanceof Error ? error.message : String(error)
        console.error(
          `[session-tab-permission] decide failed request=${props.request.id} session=${props.request.sessionID} response=${response} error=${description}`,
        )
        showToast({ variant: "error", title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setState("responding", false)
        console.debug(`[session-tab-permission] decide settled request=${props.request.id} response=${response}`)
      })
  }

  const view = () => {
    console.debug(`[session-tab-permission] view request=${props.request.id} session=${props.request.sessionID}`)
    props.onView()
  }

  return (
    <Portal>
      <div
        ref={capsuleEl}
        data-component="session-tab-permission-capsule"
        data-session-id={props.request.sessionID}
        data-state={props.closing ? "closing" : "open"}
        data-positioned={state.positioned ? "true" : "false"}
        role="group"
        aria-label={language.t("notification.permission.title")}
        class="fixed z-[60] flex items-center gap-1.5 rounded-full border px-2 py-1 text-text-strong"
        style={{
          left: `${state.left}px`,
          top: `${state.top}px`,
          visibility: state.positioned ? "visible" : "hidden",
        }}
        onAnimationStart={(event: AnimationEvent) => {
          console.debug(
            `[session-tab-permission] animation start request=${props.request.id} state=${props.closing ? "closing" : "open"} elapsed=${Math.round(performance.now() - mountedAt)}ms visible=${String(getComputedStyle(event.currentTarget as Element).visibility === "visible")} name=${event.animationName}`,
          )
        }}
        onAnimationEnd={(event: AnimationEvent) => {
          console.debug(
            `[session-tab-permission] animation end request=${props.request.id} state=${props.closing ? "closing" : "open"} name=${event.animationName}`,
          )
        }}
      >
        <span class="flex shrink-0 text-text-warning-base" aria-hidden="true">
          <Icon name="warning" size="small" />
        </span>
        <span class="whitespace-nowrap px-0.5 text-12-medium">{language.t("notification.permission.title")}</span>
        <Button
          data-action="session-tab-permission-allow-once"
          size="small"
          variant="primary"
          class="rounded-full"
          disabled={state.responding}
          onClick={() => decide("once")}
        >
          {language.t("ui.permission.allowOnce")}
        </Button>
        <Button
          data-action="session-tab-permission-reject"
          size="small"
          variant="ghost"
          class="rounded-full"
          disabled={state.responding}
          onClick={() => decide("reject")}
        >
          {language.t("ui.permission.deny")}
        </Button>
        <Button
          data-action="session-tab-permission-view"
          size="small"
          variant="ghost"
          class="rounded-full"
          disabled={state.responding}
          onClick={view}
        >
          {language.t("session.tabs.permission.view")}
        </Button>
      </div>
    </Portal>
  )
}

function DraftTab(props: { directory: string; active: boolean; onOpen: () => void; onClose: () => void }) {
  const language = useLanguage()

  return (
    <div class="h-full flex min-w-28 items-center">
      <div
        data-component="session-tab"
        data-draft="true"
        data-directory={props.directory}
        data-active={props.active ? "true" : undefined}
        role="button"
        aria-selected={props.active}
        tabIndex={0}
        class="group relative flex h-7 min-w-28 max-w-80 cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 text-13-medium italic"
        classList={{
          "bg-surface-interactive-weak-hover text-text-strong": props.active,
          "session-tab-inactive text-text-weak hover:bg-surface-base-hover hover:text-text-base": !props.active,
        }}
        onClick={() => {
          console.debug(`[session-bar] draft click directory=${props.directory} active=${String(props.active)}`)
          props.onOpen()
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          console.debug(`[session-bar] draft key directory=${props.directory} key=${event.key}`)
          props.onOpen()
        }}
      >
        <span class="session-tab-main-icon flex shrink-0" aria-hidden="true">
          <Icon name="bubble-5" size="small" />
        </span>
        <span class="min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
        <span
          data-action="session-tab-close"
          class="session-tab-close flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base transition-[opacity,background-color,color,box-shadow]"
          classList={{
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": !props.active,
            "opacity-100": props.active,
          }}
          role="button"
          tabIndex={-1}
          aria-label={language.t("common.closeTab")}
          onClick={(event) => {
            event.stopPropagation()
            console.debug(`[session-tabs] draft close clicked directory=${props.directory}`)
            props.onClose()
          }}
        >
          <Icon name="close-small" size="small" />
        </span>
      </div>
    </div>
  )
}
