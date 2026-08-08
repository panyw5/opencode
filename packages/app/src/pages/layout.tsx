import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, type LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import { Session, type Message } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast, Toast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import {
  clearSessionPrefetchDirectory,
  clearSessionPrefetch,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { setNavigate } from "@/utils/notification-click"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { triggerFileFind } from "@opencode-ai/ui/pierre/file-find"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { DialogSelectProvider } from "@/components/dialog-select-provider"
import { DialogSessionContentSearch } from "@/components/dialog-select-file"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { DialogSettings } from "@/components/dialog-settings"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogEditProject } from "@/components/dialog-edit-project"
import { DialogSelectTheme } from "@/components/dialog-select-theme"
import { DialogSwitchProject } from "@/components/dialog-switch-project"
import { DebugBar } from "@/components/debug-bar"
import { QuickAssistant } from "@/components/quick-assistant"
import { Titlebar } from "@/components/titlebar"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { dict as enDict } from "@/i18n/en"
import {
  canonicalWorkspaceDir,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  findImChannelByDirectory,
  imChannelProject,
  isInitialSessionLoad,
  latestProjectSession,
  latestRootSession,
  projectOwner,
  resolveChannelDirectory,
  sessionByOneBasedIndex,
  sortedProjectSessions,
  sortedRootSessions,
  stripScheduledSessionTitle,
  waitForMatch,
  workspaceKey,
} from "./layout/helpers"
import {
  extraAgentActive,
  enabledExtraAgents,
  extraAgentByDirectory,
  extraAgentConfig,
  extraAgentDir,
  extraAgentLabelKey,
  extraAgentProject,
  mainDomain,
  sidebarExtraAgents,
} from "./layout/extra-agents"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  ImChannelSidebar,
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"
import { ScoopJoin } from "./layout/scoop-join"
import { TrellisTasksPanel } from "./layout/trellis-tasks-panel"
import { ProjectTasksPanel } from "./layout/project-tasks-panel"
import { ScheduledTasksPanel } from "./layout/scheduled-tasks-panel"

const QUICK_ASSISTANT_DIR = "quick-assistant"

function joinPath(root: string, child: string) {
  const slash = /^[A-Za-z]:\\|\\\\/.test(root) || root.includes("\\") ? "\\" : "/"
  return root.replace(/[\\/]+$/, "") + slash + child
}

function normalizeDirectory(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export default function Layout(props: ParentProps) {
  type CurrentProject = LocalProject & {
    root: string
    entry: string
  }

  const [store, setStore, , ready] = persisted(
    Persist.global("layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      gettingStartedDismissed: false,
      sidebarPanel: "project" as "project" | "tasks" | "scheduled" | "projectTasks",
    }),
  )

  const pageReady = createMemo(() => ready())
  let booted = false
  let preserveSidebarPanelOnRouteChange = false

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const location = useLocation()
  const navigate = useNavigate()
  setNavigate(navigate)
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const [reloadingBackend, setReloadingBackend] = createSignal(false)
  createEffect(() => {
    if (!import.meta.env.DEV) return
    if (platform.platform !== "desktop") return
    console.debug("[layout] debug bar disabled on desktop dev")
  })
  type DictKey = keyof typeof enDict
  const kw = (...keys: DictKey[]) => (language.locale() === "en" ? undefined : keys.map((k) => enDict[k]).join(" "))
  // Keep the route slug, resolved directory, and comparison key separate.
  // Most bugs in the project rail/sidebar flow came from mixing these layers.
  const routeSlug = createMemo(() => params.dir)
  const initialDirectory = decode64(routeSlug())
  const routeDir = createMemo(() => {
    const slug = routeSlug()
    if (!slug) return ""
    const dir = decode64(slug)
    if (!dir) return ""
    // Prefer the synced child directory because the raw route value may be a
    // non-canonical path that later resolves to a normalized worktree path.
    return canonicalWorkspaceDir(dir, globalSync.peek(dir, { bootstrap: false })[0].path.directory)
  })
  // Use this only for equality checks, never as a directory source.
  const routeKey = createMemo(() => workspaceKey(routeDir()))
  // Treat the project rail as having no active directory while the config
  // route is mounted. The URL still carries the project slug so existing
  // resolvers keep working, but the icon should not look "selected".
  const onConfigRoute = createMemo(() => /\/config(?:\/|$)/.test(location.pathname))
  const onSessionRoute = createMemo(() => /\/session(?:\/|$)/.test(location.pathname))
  const tasksPanelActive = createMemo(() => store.sidebarPanel === "tasks")
  const scheduledPanelActive = createMemo(() => store.sidebarPanel === "scheduled")
  const projectTasksPanelActive = createMemo(() => store.sidebarPanel === "projectTasks")
  const [pendingSessionSelection, setPendingSessionSelection] = createSignal<
    { directory: string; id: string } | undefined
  >()
  let pendingSessionSelectionTimer: ReturnType<typeof setTimeout> | undefined
  const sessionRouteMatches = (directory: string, id: string) =>
    params.id === id && workspaceKey(routeDir()) === workspaceKey(directory)

  function clearPendingSessionSelection() {
    setPendingSessionSelection(undefined)
    if (pendingSessionSelectionTimer === undefined) return
    clearTimeout(pendingSessionSelectionTimer)
    pendingSessionSelectionTimer = undefined
  }

  function selectSession(session: Session) {
    if (sessionRouteMatches(session.directory, session.id)) {
      clearPendingSessionSelection()
      return
    }
    setPendingSessionSelection({ directory: session.directory, id: session.id })
    if (pendingSessionSelectionTimer !== undefined) clearTimeout(pendingSessionSelectionTimer)
    pendingSessionSelectionTimer = setTimeout(() => {
      pendingSessionSelectionTimer = undefined
      setPendingSessionSelection(undefined)
    }, 3000)
  }

  onCleanup(clearPendingSessionSelection)
  createEffect(() => {
    const pending = pendingSessionSelection()
    if (!pending) return
    if (!sessionRouteMatches(pending.directory, pending.id)) return
    clearPendingSessionSelection()
  })
  createEffect(
    on(
      () => [pageReady(), location.pathname] as const,
      ([isReady, pathname]) => {
        if (!isReady) return
        if (!/\/(?:config|scheduled|session)(?:\/|$)/.test(pathname)) return
        if (untrack(() => store.sidebarPanel) === "project") return
        if (preserveSidebarPanelOnRouteChange) {
          preserveSidebarPanelOnRouteChange = false
          return
        }
        setStore("sidebarPanel", "project")
      },
    ),
  )
  const canConfigureExtraAgents = createMemo(
    () =>
      platform.platform === "desktop" &&
      !!(
        platform.getOpenclawConfig ||
        platform.getHermesConfig ||
        platform.getGenericagentConfig ||
        platform.cliAgents
      ),
  )
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const waitServer = (key: ServerConnection.Key) =>
    waitForMatch(
      () => server.key,
      (value) => value === key,
    )
  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    previewSidebarWidth: undefined as number | undefined,
  })

  const [findbar, setFindbar] = createStore({
    open: false,
    q: "",
  })
  const [switching, setSwitching] = createSignal<string | undefined>()
  let findInput: HTMLInputElement | undefined

  const closeFindbar = () => {
    setFindbar("open", false)
  }

  const openFindbar = (seed?: string) => {
    const q = seed?.trim() || findbar.q
    if (triggerFileFind("open", q || undefined)) {
      closeFindbar()
      return
    }
    if (!platform.find) return
    setFindbar({ open: true, q })
    queueMicrotask(() => {
      findInput?.focus()
      findInput?.select()
    })
  }

  const runFindbar = (dir: 1 | -1) => {
    if (triggerFileFind(dir === 1 ? "next" : "previous")) {
      closeFindbar()
      return
    }
    const q = findbar.q.trim()
    if (!q) return
    void platform.find?.(q, dir)
  }

  const findbarKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeFindbar()
      return
    }
    if (event.key !== "Enter") return
    event.preventDefault()
    event.stopPropagation()
    runFindbar(event.shiftKey ? -1 : 1)
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = workspaceKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[workspaceKey(directory)]
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
  })

  onMount(() => {
    const stop = () => {
      setState("sizing", false)
      setState("previewSidebarWidth", undefined)
    }
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    window.addEventListener("blur", blur)
    document.addEventListener("visibilitychange", hide)
    onCleanup(() => {
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      window.removeEventListener("blur", blur)
      document.removeEventListener("visibilitychange", hide)
    })
  })

  const sidebarExpanded = createMemo(() => layout.sidebar.opened())
  const sidebarReduced = createMemo(() => false)
  const reset = () => undefined

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useUpdatePolling = () =>
    onMount(() => {
      if (!platform.checkUpdate || !platform.update || !platform.restart) return

      let toastId: number | undefined
      let interval: ReturnType<typeof setInterval> | undefined

      const pollUpdate = () =>
        platform.checkUpdate!().then(({ updateAvailable, version }) => {
          if (!updateAvailable) return
          if (toastId !== undefined) return
          toastId = showToast({
            persistent: true,
            icon: "download",
            title: language.t("toast.update.title"),
            description: language.t("toast.update.description", { version: version ?? "" }),
            actions: [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  await platform.update!()
                  await platform.restart!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss",
              },
            ],
          })
        })

      createEffect(() => {
        if (!settings.ready()) return

        if (!settings.updates.startup()) {
          if (interval === undefined) return
          clearInterval(interval)
          interval = undefined
          return
        }

        if (interval !== undefined) return
        void pollUpdate()
        interval = setInterval(pollUpdate, 10 * 60 * 1000)
      })

      onCleanup(() => {
        if (interval === undefined) return
        clearInterval(interval)
      })
    })

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        toaster.dismiss(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = globalSDK.listenAll((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(e.name, e.details.properties?.message ?? language.t("common.requestFailed"))
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const quickAssistantDirectory = globalSync.data.path.config
          ? normalizeDirectory(joinPath(globalSync.data.path.config, QUICK_ASSISTANT_DIR))
          : ""
        if (quickAssistantDirectory && normalizeDirectory(directory) === quickAssistantDirectory) return
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = globalSync.child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, href)
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, href)
          }
        }

        const currentSession = params.id
        if (workspaceKey(directory) === routeKey() && props.sessionID === currentSession) return
        if (workspaceKey(directory) === routeKey() && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!routeDir() || !currentSession) return
        const sessionKey = `${routeDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = globalSync.child(routeDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${routeDir()}:${child.id}`)
        }
      })
    })

  useUpdatePolling()
  useSDKNotificationToasts()

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  function resolveProject(directory: string | undefined) {
    if (!directory) return
    const extra = extraAgentByDirectory(directory)
    if (extra) {
      return {
        extra: extra.directory,
        project: extraAgentProject(extra.id),
        root: extra.directory,
      }
    }

    // IM channels are independent session domains (like extra agents), not
    // nested filters under OpenCode project lists.
    const im = findImChannelByDirectory(
      directory,
      globalSync.data.config.channels,
      globalSync.data.path.config || "",
      globalSync.data.path.home || "",
    )
    if (im) {
      return {
        extra: im.directory,
        project: imChannelProject(im.name, im.directory),
        root: im.directory,
      }
    }

    const projects = layout.projects.list()
    const owner = projectOwner(directory, projects)
    if (owner) return { project: owner.project, root: owner.root }

    const key = workspaceKey(directory)
    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => workspaceKey(root) === key || dirs.some((item) => workspaceKey(item) === key),
    )
    if (!known) return

    const root = known[0]
    const projectByRoot = projects.find((item) => workspaceKey(item.worktree) === workspaceKey(root))
    return {
      project: projectByRoot,
      root,
    }
  }

  /** Active IM channel when the route directory is a channel work folder. */
  const activeImChannel = createMemo(() =>
    findImChannelByDirectory(
      routeDir(),
      globalSync.data.config.channels,
      globalSync.data.path.config || "",
      globalSync.data.path.home || "",
    ),
  )

  const currentProject = createMemo(() => {
    const active = resolveProject(routeDir())
    if (!active?.project) return
    return {
      ...active.project,
      root: active.root,
      entry: active.extra ?? active.root,
    } satisfies CurrentProject
  })

  createEffect(
    on(
      () => [pageReady(), globalSync.data.ready, routeDir()] as const,
      ([ready, globalReady, directory]) => {
        // Channel config arrives with the global bootstrap. Waiting prevents an
        // IM work directory from being persisted as an ordinary project first.
        if (!ready || !globalReady || !directory) return
        const im = findImChannelByDirectory(
          directory,
          globalSync.data.config.channels,
          globalSync.data.path.config || "",
          globalSync.data.path.home || "",
        )
        if (im) {
          console.debug(`[layout] skipped IM channel project registration channel=${im.name} directory=${directory}`)
          return
        }
        if (resolveProject(directory)) return
        console.debug(`[layout] registering untracked route directory=${directory}`)
        layout.projects.open(directory)
      },
      { defer: true },
    ),
  )

  const currentProjectDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    return workspaceIds(project)
  })

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return
    if (routeDir()) {
      console.debug(`[layout] skipping auto-selection for explicit route directory=${routeDir()}`)
      return
    }

    const list = layout.projects.list()
    const last = server.projects.last()

    if (list.length === 0) {
      if (!last) return
      await openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = workspaceKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = workspaceKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = routeDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = workspaceKey(directory) === workspaceKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const project = projectOwner(directory, projects)?.project
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    globalSync.version
    const now = Date.now()
    const project = currentProject()
    const dirs = !workspaceSetting() && project ? workspaceIds(project) : visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    if (!workspaceSetting()) {
      return sortedProjectSessions(
        dirs.map((dir) => globalSync.child(dir, { bootstrap: false })[0]),
        now,
      )
    }
    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = globalSync.child(dir, { bootstrap: false })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  const projectContentLoading = createMemo(() => {
    // Session selection pending is only for sidebar highlight. Using it here
    // unmounts the session page, which paints a blank frame before remount.
    const pending = switching()
    if (!pending) return false
    const project = currentProject()
    if (!project || workspaceKey(project.root) !== workspaceKey(pending)) return false
    const stores = currentProjectDirs().map((directory) => globalSync.child(directory, { bootstrap: false })[0])
    return isInitialSessionLoad(stores)
  })

  const startup = createMemo(() => {
    const page = pageReady()
    const layout = layoutReady()
    const selecting = autoselecting.loading
    const dir = routeDir()
    if (!page || !layout || selecting) {
      return false
    }
    if (!dir) {
      return true
    }
    const [child] = globalSync.child(dir, { bootstrap: false })
    const sessionCount = child.session.length
    return sessionCount > 0 || child.sessions === "ready" || child.status === "complete"
  })

  createEffect(() => {
    if (booted) return
    if (!startup()) return
    booted = true
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("opencode:startup-interactive"))
    })
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchAttempts = new Set<string>()
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && workspaceKey(directory) === routeKey() ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of [...prefetchedByDir.keys()]) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    routeDir()
    globalSDK.url

    prefetchToken.value += 1
    prefetchAttempts.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of [...prefetchQueues]) {
      if (visible.has(directory)) continue
      clearSessionPrefetchDirectory(directory)
      prefetchedByDir.delete(directory)
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  const mergeByID = <T extends { id: string }>(current: T[], incoming: T[]) => {
    if (current.length === 0) {
      return incoming.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = globalSync.child(directory, { bootstrap: false })

    return runSessionPrefetch({
      directory,
      sessionID,
      task: (rev) =>
        retry(() => globalSDK.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
            const next = items.map((x) => x.info).filter((m): m is Message => !!m?.id)
            const sorted = mergeByID([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.response.headers.get("x-next-cursor") ?? undefined

            if (stale.length > 0) {
              clearSessionPrefetch(directory, stale)
              for (const id of stale) {
                globalSync.todo.set(id, undefined)
              }
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeByID(
              current.filter((item): item is Message => !!item?.id),
              sorted,
            )
            const meta = {
              count: merged.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(merged, { key: "id" }))
              setSessionPrefetch({ directory, sessionID, ...meta })

              for (const message of items) {
                const currentParts = store.part[message.info.id] ?? []
                const mergedParts = mergeByID(
                  currentParts.filter((item): item is (typeof currentParts)[number] & { id: string } => !!item?.id),
                  message.parts.filter((item): item is (typeof message.parts)[number] & { id: string } => !!item?.id),
                )

                setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
              }
            })

            return meta
          })
          .catch((error) => {
            // A failed prefetch leaves no message cache, so retain a short-lived
            // marker to prevent reactive session updates from immediately requeueing it.
            console.error(
              `[layout] session prefetch failed directory=${directory} sessionID=${sessionID} err=${error instanceof Error ? error.message : String(error)}`,
            )
            if (prefetchToken.value === token && isSessionPrefetchCurrent(directory, sessionID, rev)) {
              setSessionPrefetch({ directory, sessionID, count: 0, complete: false })
            }
            return undefined
          }),
    })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    // Session records (especially legacy rows in the shared DB) may persist the
    // `directory` with platform-native separators (e.g. "D:\\chat"), while the
    // rest of the app keys workspaces by the normalized forward-slash form via
    // workspaceKey(). Normalize at the entry point so prefetch, the SDK query,
    // and the shared child store land on the same keys as the page's
    // sync.session.sync (which uses sdk.directory).
    const directory = session.directory ? workspaceKey(session.directory) : session.directory
    if (!directory) return

    const [store] = globalSync.child(directory, { bootstrap: false })
    const cached = untrack(() => {
      const info = getSessionPrefetch(directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const attemptKey = `${directory}\n${session.id}`
    if (prefetchAttempts.has(attemptKey)) return
    // Session and event writes can re-run this effect before prefetch metadata is
    // observable. One navigation gets one opportunistic request per session.
    prefetchAttempts.add(attemptKey)

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    if (!params.id) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateSessionByIndex(index: number) {
    const sessions = currentSessions()
    const session = sessionByOneBasedIndex(sessions, index)
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, index - 1)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.root
    const fallback = routeDir() ? projectRoot(routeDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // Warm the full instance in the background; session list loading stays independent.
    globalSync.project.warm(target.worktree)
    openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  async function archiveSession(session: Session) {
    const [store, setStore] = globalSync.child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    layout.sessionBar.close(session.directory, session.id)
    await globalSDK.client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  async function reloadBackendFromCommand() {
    if (!platform.reloadBackend || reloadingBackend()) return
    setReloadingBackend(true)
    await platform
      .reloadBackend()
      .then(() => {
        showToast({
          variant: "success",
          title: language.t("toast.server.reloadBackend.success.title"),
          description: language.t("toast.server.reloadBackend.success.description"),
          duration: 1800,
        })
      })
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
          duration: 2200,
        })
      })
      .finally(() => setReloadingBackend(false))
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        keywords: kw("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "trellis.tasks.open",
        title: language.t("command.trellis.tasks.open"),
        description: language.t("command.trellis.tasks.open.description"),
        keywords: kw("command.trellis.tasks.open", "command.trellis.tasks.open.description"),
        category: language.t("command.category.view"),
        disabled: !params.dir,
        onSelect: () => openTasksPanel(),
      },
      {
        id: "projectTask.open",
        title: language.t("command.projectTask.open"),
        description: language.t("command.projectTask.open.description"),
        keywords: kw("command.projectTask.open", "command.projectTask.open.description"),
        category: language.t("command.category.view"),
        disabled: !params.dir,
        onSelect: () => openProjectTasksPanel(),
      },
      {
        id: "page.find",
        title: language.t("command.page.find"),
        description: language.t("command.page.find.description"),
        keywords: kw("command.page.find", "command.page.find.description"),
        category: language.t("command.category.view"),
        keybind: "mod+f",
        disabled: !platform.find,
        onSelect: () => openFindbar(window.getSelection?.()?.toString().trim() || ""),
      },
      {
        id: "session.content.search",
        title: "Search session content",
        description: "Search across all session messages",
        category: language.t("command.category.session"),
        keybind: "mod+shift+f",
        onSelect: () => {
          dialog.show(() => <DialogSessionContentSearch />, undefined, {
            modal: false,
            preventScroll: false,
          })
        },
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        keywords: kw("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.switch",
        title: language.t("command.project.switch"),
        keywords: kw("command.project.switch"),
        category: language.t("command.category.project"),
        keybind: "mod+t",
        disabled: layout.projects.list().length === 0 && enabledExtraAgents(server.list).length === 0,
        onSelect: () => {
          dialog.show(
            () => <DialogSwitchProject onSelect={switchProjectFromDialog} current={() => currentProject()?.entry} />,
            undefined,
            {
              modal: false,
              preventScroll: false,
            },
          )
        },
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        keywords: kw("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        keywords: kw("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "server.reloadBackend",
        title: language.t("command.server.reloadBackend"),
        description: language.t("command.server.reloadBackend.description"),
        keywords: kw("command.server.reloadBackend", "command.server.reloadBackend.description"),
        category: language.t("command.category.server"),
        disabled: !platform.reloadBackend || reloadingBackend(),
        onSelect: () => void reloadBackendFromCommand(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        keywords: kw("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "project.openInFinder",
        title:
          platform.os === "macos"
            ? language.t("command.project.openInFinder")
            : platform.os === "windows"
              ? language.t("command.project.openInFileExplorer")
              : language.t("command.project.openInFileManager"),
        category: language.t("command.category.project"),
        disabled: !params.dir || (platform.os === "windows" ? !platform.openPath : !platform.openInFinder),
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (!dir) return
          if (platform.os === "windows" && platform.openPath) {
            await platform.openPath(dir)
            return
          }
          if (platform.openInFinder) await platform.openInFinder(dir)
        },
      },
      {
        id: "project.openInVscode",
        title: "Open in VSCode",
        category: language.t("command.category.project"),
        disabled: !params.dir || (platform.os === "windows" ? !platform.openPath : !platform.openInVscode),
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (!dir) return
          if (platform.os === "windows" && platform.openPath) {
            await platform.openPath(dir, "code")
            return
          }
          if (platform.openInVscode) await platform.openInVscode(dir)
        },
      },
      {
        id: "project.openInCursor",
        title: "Open in Cursor",
        category: language.t("command.category.project"),
        disabled: !params.dir || !platform.openInEditor,
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (dir && platform.openInEditor) await platform.openInEditor("cursor", dir)
        },
      },
      {
        id: "project.openInSublime",
        title: "Open in Sublime Text",
        category: language.t("command.category.project"),
        disabled: !params.dir || !platform.openInEditor,
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (dir && platform.openInEditor) await platform.openInEditor("sublime", dir)
        },
      },
      {
        id: "project.openInZed",
        title: "Open in Zed",
        category: language.t("command.category.project"),
        disabled: !params.dir || !platform.openInEditor,
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (dir && platform.openInEditor) await platform.openInEditor("zed", dir)
        },
      },
      {
        id: "project.openInEditor",
        title: "Open in Editor",
        category: language.t("command.category.project"),
        disabled: !params.dir || !platform.openInEditor,
        onSelect: async () => {
          const dir = params.dir ? decode64(params.dir) : null
          if (dir && platform.openInEditor && platform.getDefaultEditor) {
            const editor = (await platform.getDefaultEditor()) || "vscode"
            await platform.openInEditor(editor, dir)
          }
        },
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        keywords: kw("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        keywords: kw("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        keywords: kw("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        keywords: kw("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      ...[1, 2, 3, 4, 5].map((index) => ({
        id: `session.jump.${index}`,
        title: language.t("command.session.jump", { index }),
        keywords: kw("command.session.jump"),
        category: language.t("command.category.session"),
        keybind: `mod+${index}`,
        disabled: currentSessions().length < index,
        onSelect: () => navigateSessionByIndex(index),
      })),
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        keywords: kw("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        keywords: kw("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        keywords: kw("command.workspace.toggle", "command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        keywords: kw("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
      {
        id: "theme.select",
        title: language.t("command.theme.select"),
        keywords: kw("command.theme.select"),
        category: language.t("command.category.theme"),
        onSelect: () => dialog.show(() => <DialogSelectTheme />),
      },
    ]

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.setTheme(id),
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      keywords: kw("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      keywords: kw("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-select-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSettings() {
    const run = ++dialogRun
    void import("@/components/dialog-settings").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings />)
    })
  }

  function openConfig(section?: string, pick?: string) {
    if (!params.dir) return
    const q = new URLSearchParams()
    if (section) q.set("section", section)
    if (pick) q.set("pick", pick)
    const next = q.size ? `/${params.dir}/config?${q.toString()}` : `/${params.dir}/config`
    batch(() => {
      setStore("sidebarPanel", "project")
      if (platform.platform === "desktop" && layout.sidebar.opened()) {
        layout.sidebar.close()
      }
      navigate(next)
    })
  }

  function openTasksPanel() {
    if (!params.dir) return
    setStore("sidebarPanel", "tasks")
    layout.sidebar.open()
  }

  function openProjectTasksPanel() {
    if (!params.dir) return
    setStore("sidebarPanel", "projectTasks")
    layout.sidebar.open()
  }

  function openScheduledPanel() {
    if (!params.dir) return

    if (onSessionRoute()) {
      setStore("sidebarPanel", "scheduled")
      layout.sidebar.open()
      return
    }

    const root = sidebarProject()?.root ?? activeProjectRoot(routeDir())
    const session = cachedProjectSession(root)
    preserveSidebarPanelOnRouteChange = true
    batch(() => {
      setStore("sidebarPanel", "scheduled")
      if (session) {
        selectSession(session)
        setSwitching(undefined)
        navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
        return
      }
      setSwitching(root)
      navigate(`/${base64Encode(root)}/session`)
    })
    layout.sidebar.open()
  }

  /** Resolve the channel's own work directory (not an OpenCode project). */
  function channelWorkDirectory(name: string, entry?: { directory?: string } | null): string {
    const home = globalSync.data.path.home || ""
    const configDir = globalSync.data.path.config || ""
    return resolveChannelDirectory(name, entry?.directory, configDir, home)
  }

  function collectImChannelSessions(directory: string): Session[] {
    const [child] = globalSync.child(directory, { bootstrap: false })
    return sortedRootSessions(child, Date.now())
  }

  /**
   * Open an IM channel as its own session-list domain (same pattern as
   * GenericAgent / extra agents). Does not nest under any OpenCode project.
   */
  function openImChannel(name: string) {
    const current = activeImChannel()?.name
    console.debug(`[layout] openImChannel name=${name} current=${current ?? "none"}`)
    const entry = globalSync.data.config.channels?.[name]
    if (!entry || entry.enabled === false) {
      console.debug(`[layout] openImChannel unavailable name=${name} enabled=${entry?.enabled}`)
      showToast({
        title: language.t("sidebar.im.toast.unavailable"),
        description: language.t("sidebar.im.toast.configure"),
        actions: [
          {
            label: language.t("config.channels.title"),
            onClick: () => openConfig("channels", entry?.type === "discord" ? "channels:discord" : "channels:feishu"),
          },
        ],
      })
      return
    }

    const dir = channelWorkDirectory(name, entry)
    // Already on this channel domain — no-op (like openExtraAgent).
    if (workspaceKey(routeDir()) === workspaceKey(dir) && onSessionRoute()) {
      console.debug(`[layout] openImChannel already active name=${name} directory=${dir}`)
      setStore("sidebarPanel", "project")
      layout.sidebar.open()
      return
    }

    batch(() => {
      setStore("sidebarPanel", "project")
      layout.sidebar.open()
    })

    console.debug(`[layout] openImChannel workdir=${dir}`)
    void globalSync.project.loadSessions(dir, { silent: true })

    const imSessions = collectImChannelSessions(dir)
    const viewingIm = imSessions.some((session) => sessionRouteMatches(session.directory, session.id))
    if (viewingIm) {
      console.debug(`[layout] openImChannel already viewing im session name=${name}`)
    } else if (imSessions[0]) {
      console.debug(`[layout] openImChannel navigate latest id=${imSessions[0].id} dir=${imSessions[0].directory}`)
      navigateToSession(imSessions[0])
    } else {
      console.debug(`[layout] openImChannel navigate new-session dir=${dir}`)
      navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
    }

    console.debug(`[layout] openImChannel opened name=${name} type=${entry.type} imCount=${imSessions.length}`)
  }

  function openExtraAgent(id: Parameters<typeof extraAgentDir>[0]) {
    console.debug(
      `[layout] open extra agent id=${id} current=${server.current?.integration ?? "none"} directory=${routeDir() || "none"}`,
    )
    const conn = server.list.find((item) => item.integration === id)
    if (!conn) {
      const cfg = extraAgentConfig(id)
      showToast({
        title: `${language.t(extraAgentLabelKey(id) as keyof typeof enDict)} ${language.t("config.claws.badge.disabled")}`,
        description: language.t("config.claws.field.enabledDescription"),
        actions: cfg
          ? [
              {
                label: language.t("config.claws.title"),
                onClick: () => openConfig(cfg.section, cfg.pick),
              },
            ]
          : undefined,
      })
      return
    }
    if (
      extraAgentActive(id, {
        directory: routeDir(),
        integration: server.current?.integration,
        pathname: location.pathname,
      })
    ) {
      console.debug(
        `[layout] extra agent already active id=${id} directory=${routeDir() || "none"} path=${location.pathname}`,
      )
      return
    }
    console.debug(`[layout] navigate to extra agent id=${id} directory=${extraAgentDir(id)}`)
    void navigateToProject(extraAgentDir(id))
  }

  function projectRoot(directory: string) {
    return resolveProject(directory)?.root ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.root ?? projectRoot(directory)
  }

  function cachedProjectSession(root: string) {
    const project = layout.projects.list().find((item) => workspaceKey(item.worktree) === workspaceKey(root))
    if (!project) return

    const dirs = workspaceIds(project)
    if (dirs.length === 0) return

    const recent = store.lastProjectSession[root]
    const known =
      recent && dirs.some((item) => workspaceKey(item) === workspaceKey(recent.directory)) ? recent : undefined
    const stores = dirs.map((item) => globalSync.child(item, { bootstrap: false })[0])
    const session = latestProjectSession(
      {
        root,
        dirs,
        recent: known,
        stores,
      },
      Date.now(),
    )
    return session
  }

  function warmProjectSessions(root: string) {
    const [child] = globalSync.child(root, { bootstrap: false })
    if (child.sessions === "ready" || child.sessions === "loading") return
    void globalSync.project.loadSessions(root, { silent: true })
    globalSync.project.warm(root)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    const quickAssistant = globalSync.data.path.config
      ? normalizeDirectory(joinPath(globalSync.data.path.config, QUICK_ASSISTANT_DIR))
      : ""
    if (normalizeDirectory(directory) !== quickAssistant) {
      const title = globalSync
        .child(directory, { bootstrap: false })[0]
        .session.find((session) => session.id === id)?.title
      layout.sessionBar.open(directory, id, title)
    }
    notification.session.markViewed(id)
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    console.debug(`[project-switch] request directory=${directory} navigated=true`)
    const extra = extraAgentByDirectory(directory)
    if (extra) {
      setSwitching(undefined)
      console.debug(`[project-switch] open extra-agent directory=${extra.directory}`)
      const conn = server.list.find((item) => item.integration === extra.id)
      if (conn) {
        const key = ServerConnection.key(conn)
        server.setActive(key)
        await waitServer(key)
      }
      navigateWithSidebarReset(`/${base64Encode(extra.directory)}/session`)
      return
    }

    if (server.domain !== mainDomain) {
      const key = server.lastNonExtraAgent
      if (key) {
        server.setActive(key)
        await waitServer(key)
      }
    }

    const root = projectRoot(directory)
    warmProjectSessions(root)
    const session = cachedProjectSession(root)
    if (session) {
      setSwitching(undefined)
      console.debug(`[project-switch] restore session root=${root} directory=${session.directory} id=${session.id}`)
      navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
      return
    }

    setSwitching(root)
    console.debug(`[project-switch] load project sessions root=${root}`)
    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    selectSession(session)
    setSwitching(undefined)
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) return navigateToProject(directory)
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(slug, { prompt: link.prompt })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    window.addEventListener(deepLinkEvent, handler as EventListener)
    onCleanup(() => window.removeEventListener(deepLinkEvent, handler as EventListener))
  })

  const [folderDragging, setFolderDragging] = createSignal(false)
  const [fileDragging, setFileDragging] = createSignal(false)

  onMount(() => {
    if (platform.platform !== "desktop") return

    const dragDropEventName = "opencode:drag-drop"

    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; paths: string[]; position: { x: number; y: number } }>)
        .detail
      if (!detail) return

      if (detail.type === "enter") {
        if (detail.paths.length > 0 && platform.filterDirectories) {
          const dirs = await platform.filterDirectories(detail.paths).catch((): string[] => [])
          const hasFiles = dirs.length < detail.paths.length
          setFolderDragging(dirs.length > 0)
          setFileDragging(hasFiles)
        }
        return
      }

      if (detail.type === "leave") {
        setFolderDragging(false)
        setFileDragging(false)
        return
      }

      if (detail.type !== "drop") return

      setFolderDragging(false)
      setFileDragging(false)
      if (detail.paths.length === 0 || !platform.filterDirectories) return

      const dirs = await platform.filterDirectories(detail.paths).catch((): string[] => [])
      const files = detail.paths.filter((path) => !dirs.includes(path))

      if (dirs.length > 0) {
        for (const dir of dirs) {
          openProject(dir, false)
        }
        await navigateToProject(dirs[0])
      }

      if (files.length > 0) {
        window.dispatchEvent(new CustomEvent("opencode:file-drop", { detail: { paths: files } }))
      }
    }

    window.addEventListener(dragDropEventName, handler as EventListener)
    onCleanup(() => window.removeEventListener(dragDropEventName, handler as EventListener))
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      await globalSDK.client.project.update({ projectID: project.id, directory: project.worktree, name })
      return
    }

    globalSync.project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = workspaceKey(directory)
    const index = list.findIndex((x) => workspaceKey(x.worktree) === key)
    const active = workspaceKey(currentProject()?.root ?? "") === key
    if (index === -1) return
    const next = list[index + 1]

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (!next) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (project: LocalProject) => {
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogEditProject project={project} />)
    })
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory, false)
        }
        navigateToProject(result[0])
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      const run = ++dialogRun
      void import("@/components/dialog-select-directory").then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(
          () => <x.DialogSelectDirectory multiple={true} onSelect={resolve} />,
          () => resolve(null),
        )
      })
    }
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = routeDir()
    const currentKey = workspaceKey(current)
    const deletedKey = workspaceKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await globalSDK.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (workspaceKey(store.lastProjectSession[root]?.directory ?? "") === workspaceKey(directory)) {
      clearLastProjectSession(root)
    }

    globalSync.set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = routeDir()
    const nextKey = workspaceKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => workspaceKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await globalSDK.client.session
      .list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
    )
    await globalSDK.client.instance.dispose({ directory }).catch(() => undefined)

    const result = await globalSDK.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          globalSDK.client.session
            .update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && routeKey() === workspaceKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigateWithSidebarReset(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await globalSDK.client.session
        .list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogArchivedSessions(props: { project: LocalProject }) {
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      sessions: [] as Session[],
    })

    const load = async () => {
      const dirs = [props.project.worktree, ...(props.project.sandboxes ?? [])]
      const rows = await Promise.all(
        dirs.map((directory) =>
          globalSDK.client.session
            .list({ directory, roots: "true", archived: "true" })
            .then((x) => x.data ?? [])
            .catch(() => []),
        ),
      )
      setState({
        status: "ready",
        sessions: rows
          .flatMap((list) => list)
          .filter((item) => item.time.archived !== undefined)
          .toSorted((a, b) => b.time.updated - a.time.updated),
      })
    }

    onMount(() => {
      load().catch(() => setState("status", "error"))
    })

    const remove = (sessionID: string) => setState("sessions", (list) => list.filter((item) => item.id !== sessionID))

    const open = (session: Session) => {
      dialog.close()
      navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
    }

    const label = (session: Session) => {
      if (session.directory === props.project.worktree) return language.t("workspace.type.local")
      const [workspace] = globalSync.child(session.directory, { bootstrap: false })
      return workspaceLabel(session.directory, workspace.vcs?.branch, props.project.id)
    }

    const restore = async (session: Session) => {
      try {
        const restored = await globalSDK.client.session
          .update({
            directory: session.directory,
            sessionID: session.id,
            time: { archived: null },
          })
          .then((x) => x.data)
        if (!restored) throw new Error(language.t("common.requestFailed"))
        const [, setChild] = globalSync.child(session.directory)
        setChild(
          produce((draft) => {
            const match = Binary.search(draft.session, restored.id, (s) => s.id)
            if (match.found) {
              draft.session[match.index] = restored
              return
            }
            draft.session.splice(match.index, 0, restored)
          }),
        )
        if (!restored.parentID) setChild("sessionTotal", (value) => value + 1)
        await globalSync.project.loadSessions(session.directory, { silent: true, force: true })
        remove(session.id)
      } catch (err) {
        showToast({
          title: language.t("session.restore.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
      }
    }

    const removeArchived = async (session: Session) => {
      const ok = await globalSDK.client.session
        .delete({ sessionID: session.id, directory: session.directory })
        .then((x) => x.data)
        .catch((err) => {
          showToast({
            title: language.t("session.delete.failed.title"),
            description: errorMessage(err, language.t("common.requestFailed")),
          })
          return false
        })
      if (!ok) return false
      return true
    }

    return (
      <Dialog title={language.t("sidebar.project.archivedSessions")} fit>
        <div class="flex flex-col gap-3 pl-6 pr-2.5 pb-3 min-w-[32rem] max-w-[40rem]">
          <Show when={state.status === "loading"}>
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Spinner class="size-4" />
              {language.t("prompt.loading")}
            </div>
          </Show>
          <Show when={state.status === "error"}>
            <div class="text-12-regular text-text-weak">{language.t("common.requestFailed")}</div>
          </Show>
          <Show when={state.status === "ready" && state.sessions.length === 0}>
            <div class="text-12-regular text-text-weak">{language.t("sidebar.project.noArchivedSessions")}</div>
          </Show>
          <Show when={state.status === "ready" && state.sessions.length > 0}>
            <div class="max-h-80 overflow-y-auto flex flex-col gap-1 pr-1">
              <For each={state.sessions}>
                {(session) => {
                  const [confirm, setConfirm] = createStore({ on: false })
                  let timer: ReturnType<typeof setTimeout> | undefined

                  const start = () => {
                    setConfirm("on", true)
                    clearTimeout(timer)
                    timer = setTimeout(() => setConfirm("on", false), 3000)
                  }

                  const removeSession = async () => {
                    clearTimeout(timer)
                    const ok = await removeArchived(session)
                    if (!ok) {
                      setConfirm("on", false)
                      return
                    }
                    remove(session.id)
                  }

                  onCleanup(() => clearTimeout(timer))

                  return (
                    <div class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-raised-base-hover">
                      <button class="flex-1 min-w-0 text-left" onClick={() => open(session)}>
                        <div class="text-14-regular text-text-strong truncate">
                          {stripScheduledSessionTitle(session.title)}
                        </div>
                        <div class="text-12-regular text-text-weak truncate">{label(session)}</div>
                      </button>
                      <div class="flex items-center gap-1 shrink-0">
                        <Tooltip value={language.t("session.restore")} placement="top">
                          <IconButton
                            icon="arrow-left"
                            variant="ghost"
                            class="size-6 rounded-md cursor-pointer"
                            aria-label={language.t("session.restore")}
                            onClick={() => void restore(session)}
                          />
                        </Tooltip>
                        <Show
                          when={confirm.on}
                          fallback={
                            <Tooltip value={language.t("common.delete")} placement="top">
                              <IconButton
                                icon="trash"
                                variant="ghost"
                                class="size-6 rounded-md cursor-pointer"
                                style={{ "--icon-base": "var(--icon-critical-base)" }}
                                aria-label={language.t("common.delete")}
                                onClick={start}
                              />
                            </Tooltip>
                          }
                        >
                          <Button
                            variant="primary"
                            size="small"
                            class="shrink-0 cursor-pointer"
                            style={{
                              "background-color": "var(--surface-critical-base)",
                              "border-color": "var(--surface-critical-base)",
                              color: "var(--text-on-critical-base)",
                            }}
                            onClick={removeSession}
                          >
                            {language.t("session.delete.button")}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => [pageReady(), routeDir(), params.id, currentProject()?.root, switching(), onSessionRoute()] as const,
      ([ready, dir, id, root, pending, sessionRoute]) => {
        if (!sessionRoute) {
          if (pending) setSwitching(undefined)
          return
        }
        if (!ready || !dir || !root || !pending) return
        if (workspaceKey(root) !== workspaceKey(pending)) return
        if (id) {
          setSwitching(undefined)
          return
        }

        const dirs = currentProjectDirs()
        if (dirs.length === 0) {
          setSwitching(undefined)
          return
        }

        const recent = store.lastProjectSession[root]
        const known =
          recent && dirs.some((item) => workspaceKey(item) === workspaceKey(recent.directory)) ? recent : undefined
        const stores = dirs.map((item) => globalSync.child(item, { bootstrap: false })[0])
        const session = latestProjectSession(
          {
            root,
            dirs,
            recent: known,
            stores,
          },
          Date.now(),
        )
        const rootStore = stores.find((item) => workspaceKey(item.path.directory) === workspaceKey(root))

        console.debug(
          `[project-switch] activate root=${root} dir=${dir} recent=${known?.directory ?? ""}:${known?.id ?? ""} session=${session?.directory ?? ""}:${session?.id ?? ""}`,
        )
        if (!session && rootStore?.sessions === "loading") {
          return
        }

        setSwitching(undefined)
        if (!session) {
          server.projects.touch(root)
          return
        }
        navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => {
        return [pageReady(), routeSlug(), params.id, currentProject()?.root, routeDir(), onSessionRoute()] as const
      },
      ([ready, slug, id, root, dir, sessionRoute]) => {
        if (!ready || !slug || !dir || !sessionRoute) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  let observedSidebarRoute = ""
  let pendingSidebarRoute = ""
  createEffect(
    on(
      () => [pageReady(), onSessionRoute(), routeSlug(), routeDir()] as const,
      ([ready, sessionRoute, slug, directory]) => {
        if (!ready || !sessionRoute) {
          pendingSidebarRoute = ""
          return
        }
        const marker = `${slug ?? ""}\u0000${directory}`
        if (marker === observedSidebarRoute) return
        observedSidebarRoute = marker
        pendingSidebarRoute = marker

        console.debug(`[sidebar-project] route-observed marker=${marker} route-directory=${directory || "none"}`)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [currentProject()?.root, layout.projects.list()] as const,
      ([root, projects]) => {
        if (!pendingSidebarRoute || !root) return
        const project = root
          ? projects.find((item) => workspaceKey(item.worktree) === workspaceKey(root))
          : undefined
        const next = project?.worktree
        if (workspaceKey(sidebarProjectRoot() ?? "") !== workspaceKey(next ?? "")) {
          console.debug(
            `[sidebar-project] route-sync root=${next ?? "none"} route-directory=${routeDir() || "none"} navigated=true`,
          )
          setSidebarProjectRoot(next)
        }

        pendingSidebarRoute = ""
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [sidebarProjectRoot(), layout.projects.list(), currentProject()?.root] as const,
      ([selected, projects, routeRoot]) => {
        if (!selected) return
        if (projects.some((item) => workspaceKey(item.worktree) === workspaceKey(selected))) return

        const fallback = routeRoot
          ? projects.find((item) => workspaceKey(item.worktree) === workspaceKey(routeRoot))?.worktree
          : undefined
        console.debug(
          `[sidebar-project] fallback selected-root=${selected} fallback-root=${fallback ?? "none"} route-directory=${routeDir() || "none"} navigated=false`,
        )
        setSidebarProjectRoot(fallback)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const sidebarWidth = layout.sidebar.opened() ? Math.max(layout.sidebar.width(), 244) : 48
    document.documentElement.style.setProperty("--dialog-left-margin", `${sidebarWidth}px`)
  })

  const side = createMemo(() => Math.max(state.previewSidebarWidth ?? layout.sidebar.width(), 244))
  const dragSide = createMemo(() => Math.max(state.previewSidebarWidth ?? layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))
  // Keep the floating list above main while width collapses (300ms). Dropping
  // z-index immediately on close hides the transition under the main pane.
  const SIDEBAR_WIDTH_MS = 300
  const [sidebarElevated, setSidebarElevated] = createSignal(layout.sidebar.opened())
  createEffect(() => {
    if (layout.sidebar.opened()) {
      setSidebarElevated(true)
      return
    }
    const id = window.setTimeout(() => setSidebarElevated(false), SIDEBAR_WIDTH_MS)
    onCleanup(() => clearTimeout(id))
  })
  const drag = {
    click: false,
    frame: 0,
  }
  let projectOver = ""

  let started = false

  onCleanup(() => {
    if (!drag.frame) return
    cancelAnimationFrame(drag.frame)
  })

  createEffect(
    on(
      () => [visibleSessionDirs(), routeDir(), autoselecting.loading] as const,
      ([dirs, dir, selecting]) => {
        if (selecting) return
        if (dirs.length === 0) return

        if (!started) {
          started = true
          if (!dir) return
          const [child] = globalSync.child(dir, { bootstrap: false })
          if (child.sessions === "ready" || child.sessions === "loading") return
          globalSync.project.loadSessions(dir, { silent: true })
          return
        }

        for (const directory of dirs) {
          const [child] = globalSync.child(directory, { bootstrap: false })
          if (child.sessions === "ready" || child.sessions === "loading") continue
          globalSync.project.loadSessions(directory, { silent: true })
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    projectOver = ""
    console.debug(`[project-dnd] start draggable=${id}`)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return
    const next = `${draggable.id.toString()}->${droppable.id.toString()}`
    if (next === projectOver) return
    projectOver = next

    const projects = layout.projects.list()
    const from = projects.findIndex((p) => p.worktree === draggable.id.toString())
    const to = projects.findIndex((p) => p.worktree === droppable.id.toString())
    console.debug(
      `[project-dnd] over draggable=${draggable.id.toString()} droppable=${droppable.id.toString()} from=${from} to=${to} order=${projects.map((project) => project.worktree).join(" | ")}`,
    )
  }

  function handleDragEnd(event: DragEvent) {
    if (store.activeProject) {
      drag.click = true
      if (drag.frame) cancelAnimationFrame(drag.frame)
      drag.frame = requestAnimationFrame(() => {
        drag.click = false
        drag.frame = 0
      })
    }
    const { draggable, droppable } = event
    setStore("activeProject", undefined)
    if (!draggable || !droppable) {
      console.debug("[project-dnd] end cancelled")
      projectOver = ""
      return
    }

    const projects = layout.projects.list()
    const from = projects.findIndex((p) => p.worktree === draggable.id.toString())
    const to = projects.findIndex((p) => p.worktree === droppable.id.toString())
    console.debug(
      `[project-dnd] end draggable=${draggable.id.toString()} droppable=${droppable.id.toString()} from=${from} to=${to} order=${projects.map((project) => project.worktree).join(" | ")}`,
    )
    projectOver = ""
    if (from === -1 || to === -1 || from === to) return

    // Pass the target project ID, not the filtered list index. The backing
    // store may contain hidden extra-agent entries, so only server-side code
    // can safely translate this visible drop target into a real insertion slot.
    layout.projects.move(draggable.id.toString(), droppable.id.toString())
  }

  function consumeProjectClick() {
    if (!drag.click) return false
    drag.click = false
    if (drag.frame) cancelAnimationFrame(drag.frame)
    drag.frame = 0
    return true
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = workspaceKey(active?.root ?? "") === workspaceKey(project.worktree) ? routeDir() : undefined
    const extra =
      directory &&
      workspaceKey(directory) !== workspaceKey(local) &&
      !dirs.some((item) => workspaceKey(item) === workspaceKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const [sidebarProjectRoot, setSidebarProjectRoot] = createSignal<string | undefined>()

  createEffect(() => {
    const root = sidebarProjectRoot()
    if (workspaceKey(layout.sidebar.project() ?? "") === workspaceKey(root ?? "")) return
    console.debug(`[sidebar-project] context-sync root=${root ?? "none"} route-directory=${routeDir() || "none"}`)
    layout.sidebar.setProject(root)
  })

  const sidebarProject = createMemo(() => {
    const selected = sidebarProjectRoot()
    const project = selected
      ? layout.projects.list().find((item) => workspaceKey(item.worktree) === workspaceKey(selected))
      : undefined
    if (project) {
      return {
        ...project,
        root: project.worktree,
        entry: project.worktree,
      } satisfies CurrentProject
    }
    return currentProject()
  })

  const railCurrentProject = createMemo(() => (onConfigRoute() ? undefined : sidebarProject()?.root))

  const sidebarProjectDirs = createMemo(() => {
    const project = sidebarProject()
    if (!project) return [] as string[]
    return workspaceIds(project)
  })

  const sidebarWorkspaceSetting = createMemo(() => {
    const project = sidebarProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const sidebarVisibleSessionDirs = createMemo(() => {
    const project = sidebarProject()
    if (!project) return [] as string[]
    if (!sidebarWorkspaceSetting()) return [project.worktree]

    return sidebarProjectDirs().filter((directory) => {
      return store.workspaceExpanded[directory] ?? directory === project.worktree
    })
  })

  const sidebarSessions = createMemo(() => {
    globalSync.version
    const now = Date.now()
    const project = sidebarProject()
    const dirs = !sidebarWorkspaceSetting() && project ? sidebarProjectDirs() : sidebarVisibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    if (!sidebarWorkspaceSetting()) {
      return sortedProjectSessions(
        dirs.map((directory) => globalSync.child(directory, { bootstrap: false })[0]),
        now,
      )
    }
    const result: Session[] = []
    for (const directory of dirs) {
      const [store] = globalSync.child(directory, { bootstrap: false })
      result.push(...sortedRootSessions(store, now))
    }
    return result
  })

  function selectSidebarProject(directory: string, options?: { navigateWhenNoSession?: boolean }) {
    const project = layout.projects.list().find((item) => workspaceKey(item.worktree) === workspaceKey(directory))
    if (!project) {
      console.debug(
        `[sidebar-project] select ignored root=${directory} route-directory=${routeDir() || "none"} navigated=false`,
      )
      return
    }

    const hasCurrentSession = onSessionRoute() && !!params.id
    const navigateWhenNoSession = options?.navigateWhenNoSession ?? true
    console.debug(
      `[sidebar-project] select root=${project.worktree} route-directory=${routeDir() || "none"} current-session=${hasCurrentSession} navigated=${!hasCurrentSession && navigateWhenNoSession}`,
    )
    setSidebarProjectRoot(project.worktree)
    warmProjectSessions(project.worktree)
    if (!hasCurrentSession && navigateWhenNoSession) {
      // Config / non-session routes: open a new session for the project and
      // still expand the session list so the rail click matches session-route UX.
      setSwitching(undefined)
      navigateWithSidebarReset(`/${base64Encode(project.worktree)}/session`)
    }
    layout.sidebar.open()
  }

  function switchProjectFromDialog(directory: string) {
    const project = layout.projects.list().find((item) => workspaceKey(item.worktree) === workspaceKey(directory))
    if (!project) {
      console.debug(
        `[project-switch] dialog explicit navigation directory=${directory} route-directory=${routeDir() || "none"} reason=non-project`,
      )
      void navigateToProject(directory)
      return
    }

    const hasCurrentSession = onSessionRoute() && !!params.id
    selectSidebarProject(project.worktree, { navigateWhenNoSession: false })

    const directories = new Set(workspaceIds(project).map(workspaceKey))
    const openTab = layout
      .sessionBar
      .all()
      .toReversed()
      .find((tab) => directories.has(workspaceKey(tab.directory)))
    if (openTab) {
      console.debug(
        `[project-switch] dialog open-tab root=${project.worktree} directory=${openTab.directory} id=${openTab.id} route-directory=${routeDir() || "none"}`,
      )
      setSwitching(undefined)
      navigateWithSidebarReset(`/${base64Encode(openTab.directory)}/session/${openTab.id}`)
      return
    }

    if (hasCurrentSession) {
      console.debug(
        `[project-switch] dialog keep-current root=${project.worktree} route-directory=${routeDir() || "none"} reason=no-open-tab`,
      )
      return
    }

    console.debug(
      `[project-switch] dialog new-session root=${project.worktree} route-directory=${routeDir() || "none"} reason=no-current-session`,
    )
    setSwitching(undefined)
    navigateWithSidebarReset(`/${base64Encode(project.worktree)}/session`)
  }

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => workspaceKey(directory) !== workspaceKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    clearSidebarHoverState()
    const created = await globalSDK.client.worktree
      .create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch ?? "", project.id, created.branch)

    const local = project.worktree
    const key = workspaceKey(created.directory)
    const root = workspaceKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = workspaceKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    globalSync.project.warm(created.directory)
    navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
  }

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir: routeDir,
    navList: sidebarSessions,
    pendingSessionSelection,
    sidebarExpanded,
    sidebarReduced,
    nav: () => state.nav,
    selectSession,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    current: railCurrentProject,
    sidebarReduced,
    consumeProjectClick,
    selectSidebarProject,
    closeProject,
    showEditProjectDialog,
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => globalSync.data.path.home)
    const copyProjectPath = () => {
      const directory = worktree()
      if (!directory) return
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
      console.debug(`[sidebar-project] copy path dir=${directory}`)
      if (!clipboard?.writeText) {
        console.debug(`[sidebar-project] clipboard unavailable dir=${directory}`)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: "Clipboard unavailable",
        })
        return
      }
      void clipboard.writeText(directory).then(
        () => {
          console.debug(`[sidebar-project] copied path dir=${directory}`)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("session.share.copy.copied"),
            description: directory,
          })
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          console.debug(`[sidebar-project] copy path failed dir=${directory} err=${message}`)
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: message,
          })
        },
      )
    }

    return (
      <div
        data-component="sidebar-panel"
        classList={{
          // Scoop join (merged desktop): top-left radius reveals ScoopJoin
          // chrome, forming a continuous arc into the rail/titlebar. Right
          // radii float against the main pane.
          "relative z-[1] flex flex-col min-h-0 min-w-0 box-border overflow-hidden px-3": true,
          "rounded-tl-[12px]": !panelProps.mobile,
          "rounded-tr-[12px] rounded-br-[12px]": merged() && !panelProps.mobile,
          "border border-b-0 border-border-weak-base": !merged(),
          // Left/top stay weaker (flush to rail); right rim is stronger so the
          // floating face reads against main. Arc overrides border via CSS.
          "border-l border-t border-border-weaker-base border-r border-border-weak-base": merged(),
          "bg-background-base": merged(),
          "bg-background-stronger": !merged(),
          // Desktop: fill the shell slot; open/close is driven by the nav
          // width so we never paint a 0→N width underlayer behind content.
          "flex-1 min-w-0": true,
          "max-w-full": panelProps.mobile,
        }}
      >
        <Show
          when={activeImChannel()}
          fallback={
            <Show
              when={project()}
              fallback={
                <Show when={empty()}>
                  <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                    <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                      <div class="flex flex-col gap-3">
                        <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                        <div
                          class="text-14-regular text-text-base"
                          style={{ "line-height": "var(--line-height-normal)" }}
                        >
                          {language.t("sidebar.empty.description")}
                        </div>
                      </div>
                      <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                        {language.t("command.project.open")}
                      </Button>
                    </div>
                  </div>
                </Show>
              }
            >
              <>
                <div class="shrink-0 pl-1 py-1">
                  <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                    <div class="flex flex-col min-w-0">
                      <InlineEditor
                        id={`project:${projectId()}`}
                        value={projectName}
                        onSave={(next) => {
                          const item = project()
                          if (!item) return
                          renameProject(item, next)
                        }}
                        class="text-14-medium text-text-strong truncate"
                        displayClass="text-14-medium text-text-strong truncate"
                        stopPropagation
                      />

                      <div class="flex min-w-0 items-center gap-1">
                        <Tooltip
                          placement="bottom"
                          gutter={2}
                          value={worktree()}
                          class="min-w-0"
                          contentStyle={{
                            "max-width": "640px",
                            transform: "translate3d(52px, 0, 0)",
                          }}
                        >
                          <span class="block min-w-0 truncate select-text text-12-mono text-text-weak">
                            {worktree().replace(homedir(), "~")}
                          </span>
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("session.header.open.copyPath")}>
                          <IconButton
                            icon="copy"
                            variant="ghost"
                            class="size-5 shrink-0 rounded-md text-icon-base"
                            aria-label={language.t("session.header.open.copyPath")}
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              copyProjectPath()
                            }}
                          />
                        </Tooltip>
                      </div>
                    </div>

                    <DropdownMenu modal>
                      <DropdownMenu.Trigger
                        as={IconButton}
                        icon="dot-grid"
                        variant="ghost"
                        data-action="project-menu"
                        data-project={slug()}
                        class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                        classList={{
                          "opacity-100": panelProps.mobile || merged(),
                          "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                            !panelProps.mobile && !merged(),
                        }}
                        aria-label={language.t("common.moreOptions")}
                      />
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="mt-1">
                          <DropdownMenu.Item
                            onSelect={() => {
                              const item = project()
                              if (!item) return
                              showEditProjectDialog(item)
                            }}
                          >
                            <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            data-action="project-workspaces-toggle"
                            data-project={slug()}
                            disabled={!canToggle()}
                            onSelect={() => {
                              const item = project()
                              if (!item) return
                              toggleProjectWorkspaces(item)
                            }}
                          >
                            <DropdownMenu.ItemLabel>
                              {workspacesEnabled()
                                ? language.t("sidebar.workspaces.disable")
                                : language.t("sidebar.workspaces.enable")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            data-action="project-clear-notifications"
                            data-project={slug()}
                            disabled={unseenCount() === 0}
                            onSelect={clearNotifications}
                          >
                            <DropdownMenu.ItemLabel>
                              {language.t("sidebar.project.clearNotifications")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item
                            data-action="project-close-menu"
                            data-project={slug()}
                            onSelect={() => {
                              const dir = worktree()
                              if (!dir) return
                              closeProject(dir)
                            }}
                          >
                            <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  </div>
                </div>

                <div class="flex-1 min-h-0 flex flex-col">
                  <Show
                    when={workspacesEnabled()}
                    fallback={
                      <>
                        <div class="shrink-0 py-4 px-3">
                          <div class="grid grid-cols-6 gap-2">
                            <Tooltip placement="bottom" value={language.t("command.session.new")}>
                              <IconButton
                                icon="new-session"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                aria-label={language.t("command.session.new")}
                                onClick={() => {
                                  const dir = worktree()
                                  if (!dir) return
                                  console.debug(`[sidebar-project] new-session root=${dir} source=sidebar-button`)
                                  navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                                }}
                              />
                            </Tooltip>
                            <Tooltip placement="bottom" value={language.t("projectTask.title")}>
                              <IconButton
                                icon="checklist"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                aria-label={language.t("projectTask.title")}
                                onClick={openProjectTasksPanel}
                              />
                            </Tooltip>
                            <Tooltip placement="bottom" value={language.t("trellis.tasks.title")}>
                              <IconButton
                                icon="task"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                aria-label={language.t("trellis.tasks.title")}
                                onClick={openTasksPanel}
                              />
                            </Tooltip>
                            <Tooltip placement="bottom" value={language.t("scheduled.title")}>
                              <IconButton
                                icon="clock"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                aria-label={language.t("scheduled.title")}
                                onClick={openScheduledPanel}
                              />
                            </Tooltip>
                            <Tooltip placement="bottom" value={language.t("sidebar.project.clearNotifications")}>
                              <IconButton
                                icon="bell-off"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                disabled={unseenCount() === 0}
                                aria-label={language.t("sidebar.project.clearNotifications")}
                                onClick={clearNotifications}
                              />
                            </Tooltip>
                            <Tooltip placement="bottom" value={language.t("sidebar.project.viewArchivedSessions")}>
                              <IconButton
                                icon="archive"
                                variant="ghost"
                                size="large"
                                class="sidebar-action-button h-10 w-full rounded-xl"
                                aria-label={language.t("sidebar.project.viewArchivedSessions")}
                                onClick={() => {
                                  const item = project()
                                  if (!item) return
                                  dialog.show(() => <DialogArchivedSessions project={item} />)
                                }}
                              />
                            </Tooltip>
                          </div>
                        </div>
                        <div class="flex-1 min-h-0">
                          <LocalWorkspace
                            ctx={workspaceSidebarCtx}
                            project={project()!}
                            directories={sidebarProjectDirs}
                            sessions={sidebarSessions}
                            sortNow={sortNow}
                            mobile={panelProps.mobile}
                          />
                        </div>
                      </>
                    }
                  >
                    <>
                      <div class="shrink-0 py-4 px-3">
                        <div class="grid grid-cols-6 gap-2">
                          <Tooltip placement="bottom" value={language.t("workspace.new")}>
                            <IconButton
                              icon="plus-small"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              aria-label={language.t("workspace.new")}
                              onClick={() => {
                                const item = project()
                                if (!item) return
                                createWorkspace(item)
                              }}
                            />
                          </Tooltip>
                          <Tooltip placement="bottom" value={language.t("projectTask.title")}>
                            <IconButton
                              icon="checklist"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              aria-label={language.t("projectTask.title")}
                              onClick={openProjectTasksPanel}
                            />
                          </Tooltip>
                          <Tooltip placement="bottom" value={language.t("trellis.tasks.title")}>
                            <IconButton
                              icon="task"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              aria-label={language.t("trellis.tasks.title")}
                              onClick={openTasksPanel}
                            />
                          </Tooltip>
                          <Tooltip placement="bottom" value={language.t("scheduled.title")}>
                            <IconButton
                              icon="clock"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              aria-label={language.t("scheduled.title")}
                              onClick={openScheduledPanel}
                            />
                          </Tooltip>
                          <Tooltip placement="bottom" value={language.t("sidebar.project.clearNotifications")}>
                            <IconButton
                              icon="bell-off"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              disabled={unseenCount() === 0}
                              aria-label={language.t("sidebar.project.clearNotifications")}
                              onClick={clearNotifications}
                            />
                          </Tooltip>
                          <Tooltip placement="bottom" value={language.t("sidebar.project.viewArchivedSessions")}>
                            <IconButton
                              icon="archive"
                              variant="ghost"
                              size="large"
                              class="sidebar-action-button h-10 w-full rounded-xl"
                              aria-label={language.t("sidebar.project.viewArchivedSessions")}
                              onClick={() => {
                                const item = project()
                                if (!item) return
                                dialog.show(() => <DialogArchivedSessions project={item} />)
                              }}
                            />
                          </Tooltip>
                        </div>
                      </div>
                      <div class="relative flex-1 min-h-0">
                        <DragDropProvider
                          onDragStart={handleWorkspaceDragStart}
                          onDragEnd={handleWorkspaceDragEnd}
                          onDragOver={handleWorkspaceDragOver}
                          collisionDetector={closestCenter}
                        >
                          <DragDropSensors />
                          <ConstrainDragXAxis />
                          <div
                            ref={(el) => {
                              if (!panelProps.mobile) scrollContainerRef = el
                            }}
                            class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                          >
                            <SortableProvider ids={workspaces()}>
                              <For each={workspaces()}>
                                {(directory) => (
                                  <SortableWorkspace
                                    ctx={workspaceSidebarCtx}
                                    directory={directory}
                                    project={project()!}
                                    sortNow={sortNow}
                                    mobile={panelProps.mobile}
                                  />
                                )}
                              </For>
                            </SortableProvider>
                          </div>
                          <DragOverlay>
                            <WorkspaceDragOverlay
                              sidebarProject={sidebarProject}
                              activeWorkspace={() => store.activeWorkspace}
                              workspaceLabel={workspaceLabel}
                            />
                          </DragOverlay>
                        </DragDropProvider>
                      </div>
                    </>
                  </Show>
                </div>
              </>
            </Show>
          }
        >
          {(match) => (
            <ImChannelSidebar
              ctx={workspaceSidebarCtx}
              // Use Show's keyed match accessor — never re-read activeImChannel()
              // with `!`, which throws when the memo goes undefined mid-update.
              channel={() => match().name}
              channelMeta={() => {
                if (match().type === "discord") return language.t("sidebar.im.meta.discord")
                return language.t("sidebar.im.meta.feishu")
              }}
              directory={() => match().directory}
              sortNow={sortNow}
              mobile={panelProps.mobile}
            />
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden:
              !!activeImChannel() ||
              store.gettingStartedDismissed ||
              !(providers.all().length > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Use the dedicated project rail source. This keeps the normal OpenCode
  // project rail decoupled from extra-agent entry rendering while still
  // preserving rail visibility when browsing extra-agent domains.
  const projects = createMemo(() => {
    const channels = globalSync.data.config.channels
    const configDir = globalSync.data.path.config || ""
    const home = globalSync.data.path.home || ""
    return layout.projects
      .rail()
      .filter((project) => !findImChannelByDirectory(project.worktree, channels, configDir, home))
  })
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      projects={projects}
      renderProject={(project) => <SortableProject ctx={projectSidebarCtx} project={project} mobile={mobile} />}
      handleDragStart={handleDragStart}
      handleDragOver={handleDragOver}
      handleDragEnd={handleDragEnd}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      extraAgents={() =>
        sidebarExtraAgents(server.list, { includeConfigurable: canConfigureExtraAgents() }).map((agent) => {
          const enabled = !!server.list.find((item) => item.integration === agent.id)
          return {
            id: agent.id,
            label: () => language.t(agent.labelKey),
            active: () => routeDir() === agent.directory,
            available: () => enabled,
            healthy: enabled ? () => server.healthyFor(`extra-agent/${agent.id}`) : undefined,
            icon: agent.icon,
            onOpen: () => openExtraAgent(agent.id),
          }
        })
      }
      imChannels={() => {
        const cfg = globalSync.data.config.channels ?? {}
        const home = globalSync.data.path.home || ""
        const configDir = globalSync.data.path.config || ""
        return Object.entries(cfg)
          .filter(([, entry]) => entry.enabled !== false)
          .map(([name, entry]) => {
            const dir = resolveChannelDirectory(name, entry.directory, configDir, home)
            const platform =
              entry.type === "feishu" ? language.t("sidebar.im.meta.feishu") : language.t("sidebar.im.meta.discord")
            return {
              id: name,
              // Platform first, then channel name: e.g. "飞书 | cc"
              label: () => `${platform} | ${name}`,
              // Active when route is this channel's work directory (independent domain).
              active: () => workspaceKey(routeDir()) === workspaceKey(dir),
              available: () => true,
              icon: "speech-bubble" as IconName,
              onOpen: () => openImChannel(name),
            }
          })
          .sort((a, b) => a.id.localeCompare(b.id))
      }}
      imChannelsLabel={() => language.t("sidebar.im.title")}
      onOpenImChannelsConfig={() => openConfig("channels")}
      configLabel={() => language.t("config.title")}
      configActive={onConfigRoute}
      onOpenConfig={openConfig}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => platform.openLink("https://opencode.ai/desktop-feedback")}
      renderPanel={() =>
        scheduledPanelActive() && (!mobile || layout.mobileSidebar.opened()) ? (
          <ScheduledTasksPanel
            projectID={() => sidebarProject()?.id ?? ""}
            directory={() => sidebarProject()?.root ?? routeDir()}
            width={panel}
            mobile={mobile}
            onBack={() => setStore("sidebarPanel", "project")}
          />
        ) : projectTasksPanelActive() && (!mobile || layout.mobileSidebar.opened()) ? (
          <ProjectTasksPanel
            directory={() => sidebarProject()?.root ?? routeDir()}
            width={panel}
            mobile={mobile}
            onBack={() => setStore("sidebarPanel", "project")}
          />
        ) : tasksPanelActive() && (!mobile || layout.mobileSidebar.opened()) ? (
          <TrellisTasksPanel
            directory={() => sidebarProject()?.root ?? routeDir()}
            width={panel}
            mobile={mobile}
            onBack={() => setStore("sidebarPanel", "project")}
          />
        ) : mobile ? (
          <SidebarPanel project={sidebarProject} mobile />
        ) : (
          <SidebarPanel project={sidebarProject} merged />
        )
      }
    />
  )

  return (
    <div
      data-component="app-root"
      class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
    >
      <Show when={folderDragging() || fileDragging()}>
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-background-base/80 pointer-events-none">
          <div class="flex flex-col items-center gap-3 text-text-weak">
            <Show when={folderDragging()} fallback={<Icon name="photo" class="size-12" />}>
              <Icon name="folder" class="size-12" />
            </Show>
            <span class="text-16-medium">
              {folderDragging() ? language.t("sidebar.dropFolder") : language.t("sidebar.dropFile")}
            </span>
          </div>
        </div>
      </Show>
      <Show when={reloadingBackend()}>
        <div
          class="fixed inset-0 z-[120] flex items-center justify-center bg-background-base/80 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div class="flex items-center gap-3 rounded-[24px] border border-border-weak-base bg-surface-raised-base/90 px-5 py-4 text-text-strong shadow-2xl">
            <Spinner class="size-5 text-text-strong" />
            <span class="text-15-medium">{language.t("config.reloadBackend.loading")}</span>
          </div>
        </div>
      </Show>
      <Titlebar />
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <nav
              aria-label={language.t("sidebar.nav.projectsAndSessions")}
              data-component="sidebar-nav-desktop"
              classList={{
                "hidden xl:block": true,
                "absolute inset-y-0 left-0": true,
                // Floating overlay: under main when fully collapsed so the panel
                // hit area does not steal clicks; above main while open/closing
                // so the width transition is visible.
                "z-10": !sidebarElevated(),
                "z-30": sidebarElevated(),
                "pointer-events-none": state.sizing,
              }}
              style={{
                // Collapse to the rail only when closed so no full-width
                // chrome slab appears ahead of the session list.
                width: layout.sidebar.opened() ? `${side()}px` : "4rem",
                transition: state.sizing
                  ? undefined
                  : `width ${SIDEBAR_WIDTH_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
              }}
              ref={(el) => {
                setState("nav", el)
              }}
            >
              <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
              {/* Cast shadow rides on the nav's right edge (left: 100%) so it
                  tracks the CSS width transition on open/close. A layout
                  sibling with an absolute `left` would jump to the final width
                  on mount while the panel is still expanding. Kept outside
                  contain-strict so paint containment cannot clip it. */}
              <Show when={sidebarElevated()}>
                <div
                  data-component="sidebar-float-shadow"
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-y-0 left-full"
                />
              </Show>
            </nav>

            <Show when={layout.sidebar.opened()}>
              {/* Click-outside dismiss: covers main (z-20) while the floating
                  session list (z-30) and resize handle (z-40) stay above. */}
              <div
                data-component="sidebar-dismiss-overlay"
                aria-hidden="true"
                class="hidden xl:block absolute inset-0 z-[25]"
                style={{ left: `${side()}px` }}
                onClick={() => layout.sidebar.close()}
              />
              <div
                class="hidden xl:block absolute inset-y-0 z-40 w-0 overflow-visible"
                style={{ left: `${dragSide()}px` }}
                onPointerDown={() => {
                  setState("sizing", true)
                  setState("previewSidebarWidth", layout.sidebar.width())
                }}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={state.previewSidebarWidth ?? layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                  onResize={(w) => {
                    setState("sizing", true)
                    if (sizet !== undefined) clearTimeout(sizet)
                    sizet = window.setTimeout(() => setState("sizing", false), 120)
                    setState("previewSidebarWidth", w)
                  }}
                  onResizeEnd={(w) => {
                    setState("previewSidebarWidth", undefined)
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              data-component="layout-top-divider"
              class="hidden xl:block pointer-events-none absolute top-0 right-0 z-0 border-t border-border-weaker-base"
              style={{ left: "calc(4rem + 12px)" }}
            />

            {/* Same ScoopJoin as the session panel: fills main's top-left
                radius when the list is collapsed (panel covers it when open). */}
            <ScoopJoin class="hidden xl:block z-[15]" style={{ left: "4rem" }} />

            <div class="xl:hidden">
              <div
                classList={{
                  "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                  "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                  "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                }}
              />
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-mobile"
                classList={{
                  "@container fixed top-10 bottom-0 left-0 z-50 w-full max-w-[400px] overflow-hidden border-r border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                  "translate-x-0": layout.mobileSidebar.opened(),
                  "-translate-x-full": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebarContent(true)}
              </nav>
            </div>

            <Show when={findbar.open && platform.find}>
              <div class="pointer-events-none absolute top-3 right-3 z-30 w-[min(480px,calc(100%-24px))]">
                <div
                  class="pointer-events-auto flex flex-row items-center gap-2 rounded-2xl border border-border-weak-base px-2 py-2 shadow-lg"
                  style={{
                    "background-color": "color-mix(in srgb, var(--background-stronger) 92%, transparent)",
                    "backdrop-filter": "blur(24px) saturate(150%)",
                    "-webkit-backdrop-filter": "blur(24px) saturate(150%)",
                  }}
                >
                  <div class="flex flex-1 min-w-0 flex-row items-center gap-2 rounded-xl bg-surface-panel px-3 ring-1 ring-border-weaker-base/70">
                    <Icon name="magnifying-glass" size="small" class="shrink-0 text-text-weaker" />
                    <InlineInput
                      ref={findInput}
                      value={findbar.q}
                      autofocus
                      placeholder={language.t("common.search.placeholder")}
                      style={{ "--inline-input-shadow": "none" }}
                      class="h-10 flex-1 min-w-0 bg-transparent text-14-regular text-text-strong placeholder:text-text-weaker"
                      onInput={(event) => setFindbar("q", event.currentTarget.value)}
                      onKeyDown={findbarKeyDown}
                    />
                  </div>
                  <div class="flex flex-row items-center gap-1 rounded-xl bg-surface-panel px-1.5 py-1 ring-1 ring-border-weaker-base/70">
                    <IconButton
                      icon="arrow-left"
                      variant="ghost"
                      size="large"
                      class="rounded-lg text-text-weak hover:text-text-strong"
                      aria-label={language.t("command.page.find.previous")}
                      onClick={() => runFindbar(-1)}
                    />
                    <IconButton
                      icon="arrow-right"
                      variant="ghost"
                      size="large"
                      class="rounded-lg text-text-weak hover:text-text-strong"
                      aria-label={language.t("command.page.find.next")}
                      onClick={() => runFindbar(1)}
                    />
                    <div class="mx-0.5 h-5 w-px bg-border-weaker-base" />
                    <IconButton
                      icon="close"
                      variant="ghost"
                      size="large"
                      class="rounded-lg text-text-weak hover:text-text-strong"
                      aria-label={language.t("common.close")}
                      onClick={closeFindbar}
                    />
                  </div>
                </div>
              </div>
            </Show>

            <div
              classList={{
                "absolute inset-0": true,
                // Always dock to the project rail (4rem). The session list
                // floats over this pane instead of pushing it sideways.
                "xl:inset-y-0 xl:right-0 xl:left-16": true,
                "z-20": true,
              }}
            >
              <main
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base xl:border-l xl:rounded-tl-[12px]": true,
                  "bg-background-base": !onSessionRoute(),
                  "bg-background-stronger": onSessionRoute(),
                  "overflow-y-hidden": onConfigRoute(),
                }}
              >
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  <Show
                    when={!projectContentLoading()}
                    fallback={
                      <div
                        data-component="project-content-loading"
                        class="size-full flex items-center justify-center bg-background-stronger text-14-regular text-text-weak"
                      >
                        <div class="flex items-center gap-2 rounded-lg border border-border-weak-base bg-surface-raised-base/40 px-3 py-2">
                          <Spinner class="size-4" />
                          <span>
                            {language.t("common.loading")}
                            {language.t("common.loading.ellipsis")}
                          </span>
                        </div>
                      </div>
                    }
                  >
                    {props.children}
                  </Show>
                </Show>
              </main>
            </div>
          </div>
        </div>
        {import.meta.env.DEV && platform.platform !== "desktop" && <DebugBar />}
      </div>
      <QuickAssistant />
      <Toast.Region />
    </div>
  )
}
