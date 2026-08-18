import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
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
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"

import { sessionBarKey, useLayout, type SessionBarTab } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { dict as enDict } from "@/i18n/en"
import { decode64 } from "@/utils/base64"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { domainFromDirectory, extraAgentByDirectory, mainDomain } from "@/pages/layout/extra-agents"
import { waitForMatch, workspaceKey } from "@/pages/layout/helpers"
import { working } from "@/pages/session/session-working"
import {
  collectSessionTabSubtree,
  groupSessionTabs,
  reorderSessionTabGroups,
  type SessionTabGroup,
} from "./session-tab-groups"
import { pickWarmDirectories, shouldFetchTabMeta } from "./session-tab-warm"

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
  const server = useServer()
  const navigate = useNavigate()
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
  // An id-less `/:dir/session` route is a not-yet-created session. Surface it as
  // a transient draft tab; the first message turns the route into a real session
  // which then lands in the persisted list via the layout route sync.
  const draftDirectory = createMemo(() => {
    if (!onSessionRoute()) return ""
    if (params.id) return ""
    return routeDir()
  })
  const shown = createMemo(() => {
    if (!settings.general.sessionTabsBar()) return false
    return tabs().length > 0 || !!draftDirectory()
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
    void globalSDK
      .forDomain(domainFromDirectory(tab.directory))
      .client.session.get({ directory: tab.directory, sessionID: tab.id })
      .then((result) => {
        const value = result.data
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

  const open = async (tab: SessionBarTab) => {
    const href = `/${base64Encode(tab.directory)}/session/${tab.id}`
    // Tabs can point at sessions served by another server connection (extra agents).
    const extra = extraAgentByDirectory(tab.directory)
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
      navigate(href)
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
    navigate(href)
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

  const closeDraft = () => {
    const last = orderedTabs().at(-1)
    if (last) {
      void open(last)
      return
    }
    navigate("/")
  }

  // Cycle through open tabs. When the current route is not a persisted tab
  // (draft new-session page, home, config), previous lands on the last tab and
  // next on the first, matching the draft tab's visual position at the end.
  // Only top-level tabs are cycled: subagent child tabs live inside their
  // parent's group, so an active child maps onto its parent root tab.
  const switchBy = (delta: number) => {
    const roots = groups().map((group) => group.tab)
    if (roots.length === 0) return
    const index = groups().findIndex(
      (group) => isActive(group.tab) || group.children.some((item) => isActive(item.tab)),
    )
    const target =
      index === -1
        ? delta > 0
          ? roots[0]
          : roots[roots.length - 1]
        : roots[(index + delta + roots.length) % roots.length]
    if (!target) return
    console.debug(
      `[session-bar] switchBy delta=${delta} roots=${roots.map((tab) => tab.id).join(",")} activeGroupIndex=${index} target=${target.id}`,
    )
    void open(target)
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
      disabled: tabs().length === 0,
      onSelect: () => switchBy(-1),
    },
    {
      id: "sessionTabs.next",
      title: language.t("command.sessionTabs.next"),
      keywords: kw("command.sessionTabs.next"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+]",
      disabled: tabs().length === 0,
      onSelect: () => switchBy(1),
    },
  ])

  const keys = createMemo(() => groups().map((group) => sessionBarKey(group.tab)))
  const scrollTarget = createMemo(() => {
    const draft = draftDirectory()
    if (draft) return `draft:${workspaceKey(draft)}:${tabs().length}`
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
            <Show when={draftDirectory()}>
              {(directory) => <DraftTab directory={directory()} closable={tabs().length > 0} onClose={closeDraft} />}
            </Show>
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

function SessionTabGroup(props: {
  tabKey: string
  group: () => SessionTabGroup<SessionBarTab> | undefined
  active: (tab: SessionBarTab) => boolean
  hasOpenDescendants: (tab: SessionBarTab) => boolean
  onOpen: (tab: SessionBarTab) => void
  onClose: (tab: SessionBarTab) => void
  onCloseDescendants: (tab: SessionBarTab) => void
}) {
  const sortable = createSortable(props.tabKey)
  const [state, setState] = createStore({ open: false })
  let closeTimer: number | undefined
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
  const open = () => {
    if (!group().children.length) return
    cancelClose()
    setState("open", true)
  }
  const close = () => {
    cancelClose()
    closeTimer = window.setTimeout(() => {
      closeTimer = undefined
      setState("open", false)
    }, 150)
  }
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
          if (open) setState("open", false)
        }}
        onOpen={() => props.onOpen(group().tab)}
        onClose={() => props.onClose(group().tab)}
        onCloseDescendants={() => props.onCloseDescendants(group().tab)}
      />
    </div>
  )

  onCleanup(cancelClose)

  return (
    <div
      use:sortable
      class="h-full flex min-w-28 items-center"
      classList={{ "opacity-0": sortable.isActiveDraggable }}
    >
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
                        setState("open", true)
                        return
                      }
                      close()
                    }}
                    onOpen={() => {
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
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const [child] = globalSync.child(props.tab.directory, { bootstrap: false })

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
  const busy = createMemo(() => groupTabs().some((tab) => working(child.session_status[tab.id], child.message[tab.id])))
  const unseen = createMemo(() =>
    groupTabs().reduce((total, tab) => total + notification.session.unseenCount(tab.id), 0),
  )

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

  return (
    <ContextMenu modal onOpenChange={props.onMenuOpenChange}>
      <ContextMenu.Trigger
        as="div"
        role="button"
        tabIndex={0}
        data-component="session-tab"
        data-session-id={props.tab.id}
        data-directory={props.tab.directory}
        data-active={props.active ? "true" : undefined}
        data-subagent={subagent() ? "true" : undefined}
        class="group relative flex cursor-pointer select-none items-center gap-1.5 rounded-[10px] pl-2 pr-1 text-13-medium"
        classList={{
          "h-7 min-w-28 max-w-80": !props.nested,
          "w-full min-w-0 max-w-72 py-1.5": !!props.nested,
          "bg-surface-base-active text-text-strong": props.active,
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
      <ContextMenu.Portal>
        <ContextMenu.Content>
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

function DraftTab(props: { directory: string; closable: boolean; onClose: () => void }) {
  const language = useLanguage()

  return (
    <div class="h-full flex min-w-28 items-center">
      <div
        data-component="session-tab"
        data-active="true"
        class="group relative flex h-7 min-w-28 max-w-80 cursor-default select-none items-center gap-1.5 rounded-[10px] bg-surface-base-active pl-2 pr-1 text-13-medium italic text-text-strong"
      >
        <span class="session-tab-main-icon flex shrink-0" aria-hidden="true">
          <Icon name="bubble-5" size="small" />
        </span>
        <span class="min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
        <Show when={props.closable}>
          <span
            class="session-tab-close flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base transition-[opacity,background-color,color,box-shadow] hover:bg-surface-base-hover hover:text-icon-strong-base"
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
        </Show>
      </div>
    </div>
  )
}
