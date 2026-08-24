import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
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
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"

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
import { ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { dict as enDict } from "@/i18n/en"
import { decode64 } from "@/utils/base64"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { domainFromDirectory, extraAgentByDirectory, mainDomain } from "@/pages/layout/extra-agents"
import { projectOwner, waitForMatch, workspaceKey } from "@/pages/layout/helpers"
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

/**
 * Global session tabs bar. One tab per open session, across projects.
 * The ordered tab list is persisted in the Layout context (`sessionBar`);
 * the active tab is derived from the current route.
 */
export function SessionTabsBar() {
  const layout = useLayout()
  const settings = useSettings()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const command = useCommand()
  const server = useServer()
  const navigate = useNavigate()
  const params = useParams()
  const location = useLocation()
  type DictKey = keyof typeof enDict
  const kw = (...keys: DictKey[]) => (language.locale() === "en" ? undefined : keys.map((k) => enDict[k]).join(" "))

  const [state, setState] = createStore({
    activeDraggable: undefined as string | undefined,
  })
  const [closedDraft, setClosedDraft] = createSignal("")
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
  // An id-less `/:dir/session` route is a not-yet-created session. Keep one
  // persisted draft tab per workspace until the first message promotes it.
  const draftDirectory = createMemo(() => {
    if (!onSessionRoute()) return ""
    if (params.id) return ""
    return routeDir()
  })
  const visibleDrafts = createMemo(() => visibleSessionBarDrafts(drafts(), draftDirectory(), closedDraft()))
  const shown = createMemo(() => {
    if (!settings.general.sessionTabsBar()) return false
    return tabs().length > 0 || visibleDrafts().length > 0
  })

  createEffect(() => {
    const directory = draftDirectory()
    if (!directory) {
      if (closedDraft()) setClosedDraft("")
      return
    }
    if (!layout.ready()) {
      console.debug(`[session-bar] draft route waiting layout storage directory=${directory}`)
      return
    }
    if (closedDraft() === workspaceKey(directory)) return
    const stored = untrack(() => layout.sessionBar.drafts())
    console.debug(
      `[session-bar] draft route observed directory=${directory} idless=true stored=${stored.length} route=${location.pathname}`,
    )
    // `openDraft` reads and writes the persisted drafts list. Keep that state
    // outside this route-driven effect so closing a promoted draft cannot
    // retrigger the old id-less route and immediately recreate it.
    untrack(() => layout.sessionBar.openDraft(directory))
  })

  const isActive = (tab: SessionBarTab) =>
    !!params.id && tab.id === params.id && workspaceKey(tab.directory) === workspaceKey(routeDir())

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

  const fetchTabMeta = (tab: SessionBarTab) => {
    const key = sessionBarKey(tab)
    if (metadataLoads.has(key)) return
    metadataLoads.add(key)
    void globalSync.session.info
      .ensure(tab.directory, tab.id)
      .then((value) => {
        if (!value) return
        layout.sessionBar.setInfo(tab.directory, tab.id, {
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
        layout.sessionBar.setInfo(tab.directory, tab.id, {
          title: session.title,
          parentID: session.parentID ?? null,
        })
      }
    }
  })

  const selectServer = async (directory: string) => {
    // Tabs can point at sessions served by another server connection (extra agents).
    const extra = extraAgentByDirectory(directory)
    if (extra) {
      const conn = server.list.find((item) => item.integration === extra.id)
      if (conn) {
        const key = ServerConnection.key(conn)
        server.setActive(key)
        await waitForMatch(
          () => server.key,
          (value) => value === key,
        )
      }
      return
    }
    if (server.domain !== mainDomain) {
      const key = server.lastNonExtraAgent
      if (key) {
        server.setActive(key)
        await waitForMatch(
          () => server.key,
          (value) => value === key,
        )
      }
    }
  }

  const open = async (tab: SessionBarTab) => {
    await selectServer(tab.directory)
    const href = `/${base64Encode(tab.directory)}/session/${tab.id}`
    navigate(href)
  }

  const openDraft = async (directory: string) => {
    console.debug(`[session-bar] draft open route directory=${directory}`)
    await selectServer(directory)
    navigate(`/${base64Encode(directory)}/session`)
  }

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
    const all = orderedTabs()
    const tabKey = sessionBarKey(tab)
    const index = all.findIndex((item) => sessionBarKey(item) === tabKey)
    if (index === -1) {
      console.debug(`[session-bar] close skip missing tab id=${tab.id} directory=${tab.directory}`)
      return
    }

    const subtree = subtreeFor(tab)
    const closing = subtree.length > 0 ? subtree : [tab]
    const closingKeys = new Set(closing.map((item) => sessionBarKey(item)))
    const viewingClosed = closing.some((item) => isActive(item))
    const firstClosed = all.findIndex((item) => closingKeys.has(sessionBarKey(item)))
    const lastClosed = all.findLastIndex((item) => closingKeys.has(sessionBarKey(item)))
    const neighbor =
      (firstClosed > 0 ? all[firstClosed - 1] : undefined) ??
      all.slice(Math.max(lastClosed, index) + 1).find((item) => !closingKeys.has(sessionBarKey(item)))

    console.debug(
      `[session-bar] close parent=${tab.id} descendants=${
        closing
          .filter((item) => sessionBarKey(item) !== tabKey)
          .map((item) => item.id)
          .join(",") || "none"
      } viewingClosed=${String(viewingClosed)} neighbor=${neighbor?.id ?? "none"}`,
    )

    layout.sessionBar.closeAll(closing)
    if (!viewingClosed) {
      console.debug(`[session-bar] close stay route id=${params.id ?? "none"}`)
      return
    }
    if (neighbor) {
      console.debug(`[session-bar] close navigate neighbor id=${neighbor.id}`)
      void open(neighbor)
      return
    }
    // Closing the last tab leaves a fresh draft, mirroring the new-session page.
    if (params.dir) {
      console.debug(`[session-bar] close navigate draft dir=${params.dir}`)
      navigate(`/${params.dir}/session`)
      return
    }
    console.debug("[session-bar] close navigate home")
    navigate("/")
  }

  const hasOpenDescendants = (tab: SessionBarTab) => subtreeFor(tab).length > 1

  const closeDescendants = (tab: SessionBarTab) => {
    const closing = subtreeFor(tab).slice(1)
    if (closing.length === 0) {
      console.debug(`[session-bar] close descendants skip none id=${tab.id} directory=${tab.directory}`)
      return
    }
    const viewingClosed = closing.some((item) => isActive(item))
    console.debug(
      `[session-bar] close descendants parent=${tab.id} descendants=${closing.map((item) => item.id).join(",")} viewingClosed=${String(viewingClosed)}`,
    )
    layout.sessionBar.closeAll(closing)
    if (!viewingClosed) return
    console.debug(`[session-bar] close descendants navigate parent id=${tab.id}`)
    void open(tab)
  }

  const closeDraft = (directory = draftDirectory()) => {
    if (!directory) return
    const active = !params.id && workspaceKey(directory) === workspaceKey(routeDir())
    console.debug(`[session-bar] draft close request directory=${directory} active=${String(active)}`)
    if (active) {
      console.debug(`[session-bar] draft close suppress directory=${directory}`)
      setClosedDraft(workspaceKey(directory))
    }
    layout.sessionBar.closeDraft(directory)
    if (!active) return

    const last = orderedTabs().at(-1)
    if (last) {
      void open(last)
      return
    }
    const next = drafts().find((item) => workspaceKey(item) !== workspaceKey(directory))
    if (next) {
      void openDraft(next)
      return
    }
    navigate("/")
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
      class="hidden h-full min-w-0 flex-1 items-center gap-1 px-1 xl:flex"
      style={{ "--tabs-bar-height": "36px" }}
    >
      <Show when={shown()}>
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
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
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
    layout.sessionBar.setInfo(props.tab.directory, props.tab.id, {
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
            layout.sessionBar.setInfo(props.tab.directory, props.tab.id, {
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
      </div>
    </div>
  )
}
