import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { extraAgentByDirectory, extraAgentDomain } from "./extra-agents"
import { NewSessionItem, SessionItem, SessionGroupHeader, SessionSearchBar } from "./sidebar-items"
import {
  isInitialSessionLoad,
  sessionGroupBoundaries,
  sortedRootSessions,
  stripImChannelTitle,
  type SessionGroupKey,
  workspaceKey,
} from "./helpers"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  pendingSessionSelection: Accessor<{ directory: string; id: string } | undefined>
  sidebarExpanded: Accessor<boolean>
  sidebarReduced: Accessor<boolean>
  nav: Accessor<HTMLElement | undefined>
  selectSession: (session: Session) => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = globalSync.child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-14-medium text-text-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-14-medium text-text-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-14-medium text-text-base min-w-0 truncate"
        displayClass="text-14-medium text-text-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} size="small" class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu modal open={props.menuOpen()} onOpenChange={(open) => props.setMenuOpen(open)}>
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButton
          icon="plus-small"
          variant="ghost"
          class="size-6 rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

const GROUP_LABEL_KEYS: Record<SessionGroupKey, string> = {
  today: "sidebar.group.today",
  yesterday: "sidebar.group.yesterday",
  thisWeek: "sidebar.group.thisWeek",
  thisMonth: "sidebar.group.thisMonth",
  older: "sidebar.group.older",
}

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  root?: string
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  issue: Accessor<string | undefined>
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  refresh?: () => Promise<void>
  refreshing?: Accessor<boolean>
  restart?: () => Promise<void>
  restarting?: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  sortNow: Accessor<number>
}): JSX.Element => {
  const boundaries = createMemo(() => sessionGroupBoundaries(props.sessions(), props.sortNow()))

  return (
    <nav class="flex flex-col gap-1 px-3">
      <Show when={!!props.refresh}>
        <div class="flex gap-1 px-2 pb-1">
          <Tooltip value={props.language.t("sidebar.sessions.refresh.genericagent")} placement="top">
            <Button
              variant="ghost"
              size="large"
              class="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-surface-raised-base/35 px-2 text-12-medium text-text-weak transition-colors hover:border-border-strong hover:bg-surface-raised-base-hover hover:text-text"
              disabled={props.loading() || props.restarting?.()}
              aria-busy={props.refreshing?.() ? "true" : "false"}
              onClick={(event: MouseEvent) => {
                event.preventDefault()
                void props.refresh?.()
              }}
            >
              <Icon
                name="arrow-sync"
                size="small"
                classList={{ "genericagent-refresh-icon-spin": !!props.refreshing?.() }}
              />
              {props.language.t("sidebar.sessions.refresh.genericagent")}
            </Button>
          </Tooltip>
          <Show when={!!props.restart}>
            <Tooltip value={props.language.t("sidebar.sessions.restart.genericagent")} placement="top">
              <Button
                variant="ghost"
                size="large"
                class="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-surface-raised-base/35 px-2 text-12-medium text-text-weak transition-colors hover:border-border-strong hover:bg-surface-raised-base-hover hover:text-text"
                disabled={props.loading() || props.refreshing?.() || props.restarting?.()}
                aria-busy={props.restarting?.() ? "true" : "false"}
                onClick={(event: MouseEvent) => {
                  event.preventDefault()
                  void props.restart?.()
                }}
              >
                <Icon
                  name="arrow-sync"
                  size="small"
                  classList={{ "genericagent-refresh-icon-spin": !!props.restarting?.() }}
                />
                {props.language.t("sidebar.sessions.restart.genericagent.short")}
              </Button>
            </Tooltip>
          </Show>
        </div>
      </Show>
      <Show when={props.showNew()}>
        <NewSessionItem
          slug={props.slug()}
          mobile={props.mobile}
          reduced={props.ctx.sidebarReduced()}
          sidebarExpanded={props.ctx.sidebarExpanded}
        />
      </Show>
      <Show when={props.loading()}>
        <div
          data-component="sidebar-session-loading"
          class="relative flex h-8 items-center justify-center overflow-hidden rounded-lg px-2 text-14-regular text-text-weak"
        >
          <div data-slot="sheen" class="pointer-events-none absolute inset-0" />
          <span class="relative z-10">
            {props.language.t("common.loading")}
            {props.language.t("common.loading.ellipsis")}
          </span>
        </div>
      </Show>
      <Show when={!props.loading() && props.issue()}>
        {(value) => <div class="px-2 py-1 text-14-regular text-text-weak">{value()}</div>}
      </Show>
      <For each={props.sessions()}>
        {(session) => {
          const key = () => boundaries().get(session.id)
          return (
            <div>
              <Show when={key()}>
                {(value) => <SessionGroupHeader label={props.language.t(GROUP_LABEL_KEYS[value()])} />}
              </Show>
              <SessionItem
                session={session}
                list={props.sessions()}
                navList={props.ctx.navList}
                slug={props.slug()}
                root={props.root}
                mobile={props.mobile}
                reduced={props.ctx.sidebarReduced()}
                sidebarExpanded={props.ctx.sidebarExpanded}
                pendingSelection={props.ctx.pendingSessionSelection}
                selectSession={props.ctx.selectSession}
                prefetchSession={props.ctx.prefetchSession}
                archiveSession={props.ctx.archiveSession}
              />
            </div>
          )
        }}
      </For>
      <Show when={props.hasMore()}>
        <div class="relative w-full px-2 pt-2 pb-1">
          <Button
            variant="ghost"
            classList={{
              "flex h-8 w-full items-center justify-center rounded-lg border border-dashed border-border bg-surface-raised-base/35 px-3 text-12-medium text-text-weak": true,
              "transition-colors hover:border-border-strong hover:bg-surface-raised-base-hover hover:text-text":
                !props.ctx.sidebarReduced(),
            }}
            size="large"
            onClick={(e: MouseEvent) => {
              props.loadMore()
              ;(e.currentTarget as HTMLButtonElement).blur()
            }}
          >
            {props.language.t("common.loadMore")}
          </Button>
        </div>
      </Show>
    </nav>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore] = globalSync.child(props.directory, { bootstrap: false })
  // Keep display pagination local. GlobalSync caches sessions per directory and
  // should not be clipped by whichever sidebar view happens to load first.
  const [visibleLimit, setVisibleLimit] = createSignal(5)
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const allSessions = createMemo(() => sortedRootSessions(workspaceStore, props.sortNow()))
  const sessions = createMemo(() => allSessions().slice(0, visibleLimit()))
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => workspaceKey(props.ctx.currentDir()) === workspaceKey(props.directory))
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.directory, local()))
  const boot = createMemo(() => open() || active())
  const count = createMemo(() => sessions().length)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > visibleLimit())
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const wasBusy = createMemo((prev) => prev || busy(), false)
  const loading = createMemo(() => open() && workspaceStore.sessions === "loading" && count() === 0 && !wasBusy())
  const touch = createMediaQuery("(hover: none)")
  const showNew = createMemo(() => !loading() && (touch() || count() === 0 || (active() && !params.id)))
  let initialFullRequested = false
  const loadMore = async () => {
    setVisibleLimit((limit) => limit + 5)
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.setWorkspaceExpanded(props.directory, value)
    if (value) return
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  createEffect(() => {
    if (!boot()) return
    globalSync.child(props.directory, { bootstrap: true })
  })

  createEffect(() => {
    if (!boot()) return
    if (!open() && !active()) return
    if (workspaceStore.sessions === "loading") return
    if (initialFullRequested) return
    initialFullRequested = true
    console.debug(
      `[sidebar-project] workspace-session-list load start root=${props.project.worktree} directory=${props.directory}`,
    )
    void globalSync.project.loadSessions(props.directory, { silent: true }).finally(() => {
      console.debug(
        `[sidebar-project] workspace-session-list load done root=${props.project.worktree} directory=${props.directory} state=${workspaceStore.sessions} count=${workspaceStore.session.length}`,
      )
    })
  })

  return (
    <div
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="px-2 py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-lg ${
                      menu.open || props.ctx.sidebarReduced() ? "pr-2" : "pr-16"
                    } ${props.ctx.sidebarReduced() ? "" : "hover:bg-surface-raised-base-hover transition-[padding] duration-200 group-hover/workspace:pr-16 group-focus-within/workspace:pr-16"}`}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                  </Collapsible.Trigger>
                }
              >
                <div
                  class={`flex items-center justify-between w-full pl-2 py-1.5 rounded-lg ${
                    menu.open || props.ctx.sidebarReduced() ? "pr-2" : "pr-16"
                  } ${props.ctx.sidebarReduced() ? "" : "transition-[padding] duration-200 group-hover/workspace:pr-16 group-focus-within/workspace:pr-16"}`}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content>
          <WorkspaceSessionList
            slug={slug}
            mobile={props.mobile}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            issue={() => workspaceStore.session_error}
            sessions={sessions}
            hasMore={hasMore}
            loadMore={loadMore}
            language={language}
            sortNow={props.sortNow}
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * First-class IM channel session panel.
 * Same role as an extra-agent / project session list: occupies its own domain
 * when the route directory is the channel work folder. Not a nested filter
 * under OpenCode project sessions.
 */
export const ImChannelSidebar = (props: {
  ctx: WorkspaceSidebarContext
  channel: Accessor<string>
  channelMeta: Accessor<string>
  /** Resolved absolute work directory for this channel. */
  directory: Accessor<string>
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [visibleLimit, setVisibleLimit] = createSignal(20)
  const [searchQuery, setSearchQuery] = createSignal("")
  const initialFullRequested = new Set<string>()

  const directory = createMemo(() => props.directory())

  const childStore = createMemo(() => {
    const dir = directory()
    if (!dir) return undefined
    return globalSync.child(dir, { bootstrap: false })[0]
  })

  const rawSessions = createMemo(() => {
    const dir = directory()
    const s = childStore()
    if (!dir || !s) return []
    const channel = props.channel() || "?"
    console.debug(`[im-sidebar] channel=${channel} directory=${dir} sessions=${s.session.length}`)
    return sortedRootSessions(s, props.sortNow())
  })

  const displaySessions = createMemo(() => {
    const channel = props.channel() || ""
    const query = searchQuery().toLowerCase().trim()
    let list = rawSessions().map((session) => ({
      ...session,
      // Keep the raw title so SessionItem can detect the scheduled marker and
      // show a clock; only strip IM channel markers for channel-scoped lists.
      title: channel ? stripImChannelTitle(session.title, channel) : (session.title ?? ""),
    }))
    if (query) list = list.filter((item) => item.title?.toLowerCase().includes(query))
    return list.slice(0, visibleLimit())
  })

  const loading = createMemo(() => {
    const s = childStore()
    if (!s) return false
    return isInitialSessionLoad([s])
  })
  const hasMore = createMemo(() => {
    if (searchQuery()) return false
    return rawSessions().length > visibleLimit()
  })
  const issue = createMemo(() => childStore()?.session_error)
  const slug = createMemo(() => {
    const dir = directory()
    return dir ? base64Encode(dir) : ""
  })

  createEffect(() => {
    const dir = directory()
    if (!dir) return
    const s = childStore()
    if (!s) return
    if (s.sessions === "loading") return
    if (initialFullRequested.has(dir)) return
    console.debug(`[im-sidebar] load start channel=${props.channel() || "?"} directory=${dir}`)
    void globalSync.project.loadSessions(dir, { silent: true }).finally(() => {
      initialFullRequested.add(dir)
      console.debug(
        `[im-sidebar] load done channel=${props.channel() || "?"} directory=${dir} sessions=${s.session.length} state=${s.sessions}`,
      )
    })
  })

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="shrink-0 pl-1 py-1">
        <div class="flex items-start justify-between gap-2 py-2 pl-2 pr-0">
          <div class="flex min-w-0 flex-col">
            <div class="truncate text-14-medium text-text-strong">{props.channel()}</div>
            <div class="truncate text-12-regular text-text-weak">{props.channelMeta()}</div>
            <Show when={directory()}>
              {(dir) => (
                <div class="truncate font-mono text-12-regular text-text-weak">
                  {dir()
                    .replace(/^\/Users\/[^/]+/, "~")
                    .replace(/^\/home\/[^/]+/, "~")}
                </div>
              )}
            </Show>
          </div>
          <Icon name="speech-bubble" class="mt-1 size-5 shrink-0 text-icon-base" />
        </div>
      </div>

      <div
        ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
        class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
      >
        <Show when={rawSessions().length > 3}>
          <SessionSearchBar
            value={searchQuery}
            onInput={setSearchQuery}
            placeholder={language.t("sidebar.search.placeholder")}
            reduced={props.ctx.sidebarReduced()}
          />
        </Show>
        <Show when={!loading() && rawSessions().length === 0}>
          <div class="mx-3 mb-2 rounded-lg px-2 py-3 text-12-regular text-text-weak">
            {language.t("sidebar.im.empty")}
          </div>
        </Show>
        <WorkspaceSessionList
          slug={slug}
          mobile={props.mobile}
          ctx={props.ctx}
          showNew={() => false}
          loading={loading}
          issue={issue}
          sessions={displaySessions}
          hasMore={hasMore}
          loadMore={async () => {
            setVisibleLimit((n) => n + 10)
          }}
          language={language}
          sortNow={props.sortNow}
        />
      </div>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  directories: Accessor<string[]>
  sessions: Accessor<Session[]>
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const platform = usePlatform()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [refreshing, setRefreshing] = createSignal(false)
  const [restarting, setRestarting] = createSignal(false)
  // Project view paginates the merged, sorted session list; per-directory store
  // limits would make worktrees compete and cause rows to appear mid-list later.
  const [visibleLimit, setVisibleLimit] = createSignal(10)
  const dirs = props.directories
  const stores = createMemo(() => dirs().map((directory) => globalSync.child(directory, { bootstrap: false })))
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const allSessions = props.sessions
  const sessions = createMemo(() => {
    const query = searchQuery().toLowerCase().trim()
    if (!query) return allSessions().slice(0, visibleLimit())
    return allSessions().filter((s) => s.title?.toLowerCase().includes(query))
  })
  const loading = createMemo(() => isInitialSessionLoad(stores().map((item) => item[0])))
  const hasMore = createMemo(() => {
    if (searchQuery()) return false
    return stores().reduce((sum, item) => sum + item[0].sessionTotal, 0) > visibleLimit()
  })
  const issue = createMemo(() =>
    stores()
      .map((item) => item[0].session_error)
      .find(Boolean),
  )
  const extraAgent = createMemo(() => extraAgentByDirectory(props.project.worktree))
  const initialFullRequested = new Set<string>()
  const refresh = async () => {
    if (refreshing()) return
    const directories = dirs()
    setRefreshing(true)
    try {
      await Promise.all([
        Promise.all(directories.map((directory) => globalSync.project.loadSessions(directory, { force: true }))),
        new Promise((resolve) => window.setTimeout(resolve, 700)),
      ])
    } finally {
      setRefreshing(false)
    }
  }
  const restart = async () => {
    if (restarting()) return
    if (!platform.restartExtraAgent) {
      showToast({
        title: language.t("sidebar.sessions.restart.genericagent.unavailable.title"),
        description: language.t("sidebar.sessions.restart.genericagent.unavailable.description"),
      })
      return
    }
    setRestarting(true)
    try {
      await platform.restartExtraAgent("genericagent")
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      await globalSync.provider.refresh(extraAgentDomain("genericagent"))
      await refresh()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("sidebar.sessions.restart.genericagent.toast.title"),
      })
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRestarting(false)
    }
  }
  const loadMore = async () => {
    setVisibleLimit((limit) => limit + 5)
  }

  createEffect(() => {
    const root = props.project.worktree
    for (const directory of dirs()) {
      const [store] = globalSync.child(directory, { bootstrap: false })
      if (store.sessions === "loading") continue
      if (initialFullRequested.has(directory)) continue
      console.debug(`[sidebar-project] session-list load start root=${root} directory=${directory}`)
      void globalSync.project.loadSessions(directory, { silent: true }).finally(() => {
        initialFullRequested.add(directory)
        const [next] = globalSync.child(directory, { bootstrap: false })
        console.debug(
          `[sidebar-project] session-list load done root=${root} directory=${directory} state=${next.sessions} count=${next.session.length}`,
        )
      })
    }
  })

  return (
    <div
      ref={(el) => props.ctx.setScrollContainerRef(el, props.mobile)}
      class="size-full flex flex-col py-2 overflow-y-auto no-scrollbar [overflow-anchor:none]"
    >
      <Show when={allSessions().length > 3}>
        <SessionSearchBar
          value={searchQuery}
          onInput={setSearchQuery}
          placeholder={language.t("sidebar.search.placeholder")}
          reduced={props.ctx.sidebarReduced()}
        />
      </Show>
      <WorkspaceSessionList
        slug={slug}
        root={props.project.worktree}
        mobile={props.mobile}
        ctx={props.ctx}
        showNew={() => false}
        loading={loading}
        issue={issue}
        sessions={sessions}
        hasMore={hasMore}
        loadMore={loadMore}
        refresh={extraAgent()?.id === "genericagent" ? refresh : undefined}
        refreshing={refreshing}
        restart={extraAgent()?.id === "genericagent" ? restart : undefined}
        restarting={restarting}
        language={language}
        sortNow={props.sortNow}
      />
    </div>
  )
}
