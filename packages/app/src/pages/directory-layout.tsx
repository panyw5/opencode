import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename, type PathContext } from "@opencode-ai/core/util/path"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, type Accessor, type ParentProps, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { getAvatarColors, useLayout } from "@/context/layout"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SkillsProvider } from "@/context/skills"
import { sessionTabsTargetHref, useSessionTabs } from "@/context/session-tabs"
import { SyncProvider, useSync } from "@/context/sync"
import { extraAgentByDirectory } from "@/pages/layout/extra-agents"
import {
  directoryProviderKey,
  newSessionProjectLabel,
  sameWorkspacePath,
  shouldNavigateDirectory,
  splitI18nTemplate,
  workspacePathContext,
} from "@/pages/layout/helpers"
import { RailTooltip } from "@/pages/layout/rail-tooltip"
import { decode64 } from "@/utils/base64"

let nextProviderID = 0

function directoryDebug(
  event: string,
  input: { rawPath?: string; logicalPath?: string; identity?: string; providerID?: number; navigated?: boolean },
) {
  if (!import.meta.env.DEV) return
  console.debug(`[directory-layout] ${event}`, input)
}

function DirectoryDataProvider(
  props: ParentProps<{
    directory: Accessor<string>
    identity: string
    setDirectory: (directory: string) => void
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const directory = createMemo(props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const providerID = ++nextProviderID
  let previousDirectory = directory()

  directoryDebug("provider-created", {
    rawPath: previousDirectory,
    logicalPath: previousDirectory,
    identity: props.identity,
    providerID,
  })
  onCleanup(() => {
    directoryDebug("provider-disposed", {
      rawPath: previousDirectory,
      logicalPath: previousDirectory,
      identity: props.identity,
      providerID,
    })
  })

  createEffect(() => {
    const next = directory()
    if (next === previousDirectory) return
    directoryDebug("provider-reused", {
      rawPath: previousDirectory,
      logicalPath: next,
      identity: props.identity,
      providerID,
    })
    previousDirectory = next
  })

  createEffect(() => {
    const next = sync.data.path.directory
    const current = directory()
    if (!next || next === current) return

    const navigateRequired = shouldNavigateDirectory(current, next, sdk.pathContext)
    directoryDebug("route-canonicalized", {
      rawPath: current,
      logicalPath: next,
      identity: props.identity,
      providerID,
      navigated: navigateRequired,
    })
    if (!navigateRequired || sameWorkspacePath(current, next, sdk.pathContext)) {
      // Keep the route/provider identity stable while allowing the backend's
      // case-preserving logical path to flow through SDK and UI consumers.
      props.setDirectory(next)
      return
    }

    const routeSlug = params.dir ?? slug()
    const routePrefix = `/${routeSlug}`
    const path = location.pathname.startsWith(routePrefix)
      ? location.pathname.slice(routePrefix.length)
      : location.pathname
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <DataProvider
      data={sync.data as never}
      directory={directory()}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
      onAbortSession={(sessionID: string) => {
        void sdk.client.session.abort({ sessionID }).catch(() => undefined)
      }}
      onAdvisorIntervention={(input) => {
        const callID = input.callID
        if (input.action === "start") {
          return sdk.client.session.advisorInterventionStart({ sessionID: input.sessionID, callID }).then((result) => {
            if (result.data !== true) throw new Error("Advisor intervention was not accepted")
          })
        }
        if (input.action === "finish") {
          return sdk.client.session.advisorInterventionFinish({ sessionID: input.sessionID, callID }).then((result) => {
            if (result.data !== true) throw new Error("Advisor intervention could not be finished")
          })
        }
        return sdk.client.session
          .advisorInterventionMessage({
            sessionID: input.sessionID,
            callID,
            message: input.message ?? "",
          })
          .then((result) => {
            if (result.data !== true) throw new Error("Advisor message was not accepted")
          })
      }}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

function DirectoryProviders(
  props: ParentProps<{
    identity: string
    routeDirectory: Accessor<string>
    context: Accessor<PathContext>
  }>,
) {
  // This signal belongs to the keyed identity scope. A true identity change
  // constructs a fresh scope with the matching logical path, while a spelling
  // change keeps the existing provider tree and SDK state alive.
  const [directory, setDirectory] = createSignal(props.routeDirectory())

  createEffect(() => {
    const next = props.routeDirectory()
    if (!next) return
    setDirectory((current) => (!current || shouldNavigateDirectory(current, next, props.context()) ? next : current))
  })

  return (
    <SDKProvider directory={directory}>
      <SyncProvider>
        <SkillsProvider>
          <ProjectStatusPortal directory={directory} />
          <DirectoryDataProvider directory={directory} identity={props.identity} setDirectory={setDirectory}>
            {props.children}
          </DirectoryDataProvider>
        </SkillsProvider>
      </SyncProvider>
    </SDKProvider>
  )
}

function ProjectStatusPortal(props: { directory: Accessor<string> }) {
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const sessionTabs = useSessionTabs()
  const mount = createMemo(() => document.getElementById("opencode-titlebar-center-project"))
  const directory = createMemo(props.directory)
  const projectLabel = createMemo(() => {
    const dir = directory()
    return newSessionProjectLabel(dir, layout.projects.list(), {
      extraName: extraAgentByDirectory(dir)?.label,
      sidebarRoot: layout.sidebar.project(),
    })
  })
  const tooltip = createMemo(() => {
    const project = projectLabel()
    if (!project) return language.t("command.session.new")
    return language.t("command.session.new.tooltip", { project })
  })
  const tooltipTitle = () => {
    const project = projectLabel()
    if (!project) return language.t("command.session.new")
    const parts = splitI18nTemplate(language.t("command.session.new.tooltip"), "project")
    return (
      <For each={parts}>
        {(part) => (part.type === "token" ? <span data-slot="rail-tooltip-mark">{project}</span> : part.value)}
      </For>
    )
  }
  const projects = createMemo(() => layout.projects.rail())
  const newSessionIn = (projectDirectory: string) => {
    console.debug(`[directory-layout] new-session-project current=${directory() || "none"} target=${projectDirectory}`)
    const draft = sessionTabs.createDraft(projectDirectory, "button")
    navigate(sessionTabsTargetHref({ type: "draft", ...draft }))
  }

  return (
    <Show when={mount()}>
      {(node) => (
        <Portal mount={node()}>
          <div class="mr-2 flex items-center">
            <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
              <RailTooltip title={tooltipTitle()} placement="bottom">
                <IconButton
                  data-action="session-new-button"
                  icon="new-session"
                  size="normal"
                  variant="ghost"
                  class="rounded-none h-full w-6 p-0 border-none shadow-none"
                  aria-label={tooltip()}
                  onClick={() => {
                    if (!params.dir) return
                    console.debug(
                      `[directory-layout] new-session dir=${directory() || "none"} project=${projectLabel() || "none"}`,
                    )
                    const draft = sessionTabs.createDraft(directory(), "button")
                    navigate(sessionTabsTargetHref({ type: "draft", ...draft }))
                  }}
                />
              </RailTooltip>
              <DropdownMenu gutter={4} placement="bottom-end">
                <Tooltip placement="bottom" value={language.t("command.session.new.selectProject")}>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    data-action="session-new-project-menu"
                    icon="chevron-down"
                    size="normal"
                    variant="ghost"
                    class="rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active"
                    aria-label={language.t("command.session.new.selectProject")}
                  />
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    class="session-child-agent-scrollbar w-80 max-w-[calc(100vw-32px)]"
                    style={{
                      "max-height": "min(520px, calc(100dvh - 64px))",
                      "overflow-y": "auto",
                      "overscroll-behavior": "contain",
                    }}
                  >
                    <DropdownMenu.Group>
                      <For each={projects()}>
                        {(project) => {
                          const name = () => project.name || getFilename(project.worktree)
                          const current = () => project.worktree === directory()
                          return (
                            <DropdownMenu.Item
                              data-action="session-new-project-item"
                              data-project={base64Encode(project.worktree)}
                              class="min-w-0"
                              aria-current={current() ? "page" : undefined}
                              onSelect={() => newSessionIn(project.worktree)}
                            >
                              <Avatar
                                fallback={name()}
                                src={project.icon?.override}
                                {...getAvatarColors(project.icon?.color)}
                                class="size-5 rounded shrink-0"
                              />
                              <div class="flex min-w-0 flex-1 items-center gap-3">
                                <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
                                  {name()}
                                </DropdownMenu.ItemLabel>
                                <DropdownMenu.ItemDescription class="max-w-[55%] shrink-0 truncate text-right text-11-regular text-text-weak">
                                  {project.worktree}
                                </DropdownMenu.ItemDescription>
                              </div>
                            </DropdownMenu.Item>
                          )
                        }}
                      </For>
                    </DropdownMenu.Group>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  const platform = usePlatform()
  const server = useServer()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })
  const context = createMemo(() =>
    workspacePathContext({ os: platform.os, isLocal: !!server.isLocal(), directory: resolved() }),
  )
  const identity = createMemo(() => directoryProviderKey(resolved(), context()))

  createEffect(() => {
    const next = resolved()
    directoryDebug("route-input", {
      rawPath: params.dir,
      logicalPath: next,
      identity: directoryProviderKey(next, context()),
    })
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={identity()} keyed>
      {(providerIdentity) => (
        <DirectoryProviders identity={providerIdentity} routeDirectory={resolved} context={context}>
          {props.children}
        </DirectoryProviders>
      )}
    </Show>
  )
}
