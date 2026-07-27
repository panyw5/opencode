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
import { Icon } from "@opencode-ai/ui/icon"
import { base64Encode } from "@opencode-ai/core/util/encode"

import { sessionBarKey, useLayout, type SessionBarTab } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { dict as enDict } from "@/i18n/en"
import { decode64 } from "@/utils/base64"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { extraAgentByDirectory, mainDomain } from "@/pages/layout/extra-agents"
import { waitForMatch, workspaceKey } from "@/pages/layout/helpers"
import { getTabReorderIndex } from "@/pages/session/helpers"
import { working } from "@/pages/session/session-working"

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
  let tabsViewport: HTMLDivElement | undefined
  let revealFrame: number | undefined

  const tabs = createMemo(() => layout.sessionBar.all())
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

  // Titles and live status come from the per-directory session stores; make sure
  // they are loaded for every open tab (e.g. after a cold start).
  createEffect(() => {
    const dirs = new Set<string>()
    for (const tab of tabs()) dirs.add(tab.directory)
    for (const directory of dirs) {
      const [child] = globalSync.child(directory, { bootstrap: false })
      if (child.sessions === "ready" || child.sessions === "loading") continue
      void globalSync.project.loadSessions(directory, { silent: true })
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

  const close = (tab: SessionBarTab) => {
    const all = tabs()
    const index = all.findIndex((item) => sessionBarKey(item) === sessionBarKey(tab))
    if (index === -1) return
    const active = isActive(tab)
    const neighbor = all[index - 1] ?? all[index + 1]
    layout.sessionBar.close(tab.directory, tab.id)
    if (!active) return
    if (neighbor) {
      void open(neighbor)
      return
    }
    // Closing the last tab leaves a fresh draft, mirroring the new-session page.
    if (params.dir) {
      navigate(`/${params.dir}/session`)
      return
    }
    navigate("/")
  }

  const closeDraft = () => {
    const last = tabs().at(-1)
    if (last) {
      void open(last)
      return
    }
    navigate("/")
  }

  // Cycle through open tabs. When the current route is not a persisted tab
  // (draft new-session page, home, config), previous lands on the last tab and
  // next on the first, matching the draft tab's visual position at the end.
  const switchBy = (delta: number) => {
    const all = tabs()
    if (all.length === 0) return
    const index = all.findIndex((tab) => isActive(tab))
    const target =
      index === -1 ? (delta > 0 ? all[0] : all[all.length - 1]) : all[(index + delta + all.length) % all.length]
    if (!target) return
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

  const keys = createMemo(() => tabs().map((tab) => sessionBarKey(tab)))
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
    const to = getTabReorderIndex(keys(), draggable.id.toString(), droppable.id.toString())
    if (to === undefined) return
    layout.sessionBar.move(draggable.id.toString(), to)
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
              <For each={tabs()}>
                {(tab) => (
                  <SessionTab
                    tab={tab}
                    active={isActive(tab)}
                    onOpen={() => void open(tab)}
                    onClose={() => close(tab)}
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

function SessionTab(props: { tab: SessionBarTab; active: boolean; onOpen: () => void; onClose: () => void }) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const sortable = createSortable(sessionBarKey(props.tab))
  const [child] = globalSync.child(props.tab.directory, { bootstrap: false })

  const session = createMemo(() => (child.session ?? []).find((item) => item.id === props.tab.id))
  const subagent = createMemo(() => !!session()?.parentID)
  const title = createMemo(() => {
    const raw = session()?.title || props.tab.title
    if (!raw) return language.t("session.tab.session")
    return cleanTitle(raw)
  })

  // Keep the persisted title fresh so the strip has good labels after a restart,
  // before that project's sessions finish loading.
  createEffect(() => {
    const value = session()?.title
    if (!value || value === props.tab.title) return
    layout.sessionBar.setTitle(props.tab.directory, props.tab.id, value)
  })

  const busy = createMemo(() => working(child.session_status[props.tab.id], child.message[props.tab.id]))
  const unseen = createMemo(() => notification.session.unseenCount(props.tab.id))

  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div
        role="button"
        tabIndex={0}
        data-component="session-tab"
        data-active={props.active ? "true" : undefined}
        data-subagent={subagent() ? "true" : undefined}
        class="group relative flex h-7 max-w-52 min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-lg pl-2 pr-1 text-13-medium"
        classList={{
          "bg-surface-base-active text-text-strong": props.active,
          "session-tab-inactive text-text-weak hover:bg-surface-base-hover hover:text-text-base": !props.active,
        }}
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          props.onOpen()
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onAuxClick={(event) => {
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
          <span class="flex shrink-0 text-icon-weak" aria-hidden="true">
            <Icon name="branch" size="small" />
          </span>
        </Show>
        <span class="min-w-0 truncate">{title()}</span>
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
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base transition-opacity hover:bg-surface-base-active hover:text-icon-strong-base"
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

function DraftTab(props: { directory: string; closable: boolean; onClose: () => void }) {
  const language = useLanguage()

  return (
    <div class="h-full flex items-center">
      <div
        data-component="session-tab"
        data-active="true"
        class="group relative flex h-7 max-w-52 min-w-0 cursor-default select-none items-center gap-1.5 rounded-lg bg-surface-base-active pl-2 pr-1 text-13-medium italic text-text-strong"
      >
        <span class="min-w-0 truncate">{language.t("command.session.new")}</span>
        <Show when={props.closable}>
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon-base transition-opacity hover:bg-surface-base-hover hover:text-icon-strong-base"
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
