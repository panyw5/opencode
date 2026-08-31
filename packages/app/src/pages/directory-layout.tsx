import { DataProvider } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, type ParentProps, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { getAvatarColors, useLayout } from "@/context/layout"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SkillsProvider } from "@/context/skills"
import { SyncProvider, useSync } from "@/context/sync"
import { extraAgentByDirectory } from "@/pages/layout/extra-agents"
import { newSessionProjectLabel, splitI18nTemplate } from "@/pages/layout/helpers"
import { RailTooltip } from "@/pages/layout/rail-tooltip"
import { decode64 } from "@/utils/base64"
import { StatusPopover } from "@/components/status-popover"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const slug = createMemo(() => base64Encode(props.directory))

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  return (
    <DataProvider
      data={sync.data as never}
      directory={props.directory}
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

function ProjectStatusPortal() {
  const language = useLanguage()
  const params = useParams()
  const navigate = useNavigate()
  const layout = useLayout()
  const mount = createMemo(() => document.getElementById("opencode-titlebar-center-project"))
  const directory = createMemo(() => (params.dir ? (decode64(params.dir) ?? "") : ""))
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
        {(part) =>
          part.type === "token" ? <span data-slot="rail-tooltip-mark">{project}</span> : part.value
        }
      </For>
    )
  }
  const projects = createMemo(() => layout.projects.rail())
  const newSessionIn = (projectDirectory: string) => {
    console.debug(
      `[directory-layout] new-session-project current=${directory() || "none"} target=${projectDirectory}`,
    )
    navigate(`/${base64Encode(projectDirectory)}/session`)
  }

  return (
    <Show when={mount()}>
      {(node) => (
        <Portal mount={node()}>
          <div class="mr-2 flex items-center gap-1">
            <div class="flex items-center">
              <RailTooltip title={tooltipTitle()} placement="bottom">
                <IconButton
                  data-action="session-new-button"
                  icon="new-session"
                  size="normal"
                  variant="ghost"
                  class="titlebar-icon w-8 h-8 p-0 box-border"
                  aria-label={tooltip()}
                  onClick={() => {
                    if (!params.dir) return
                    console.debug(
                      `[directory-layout] new-session dir=${directory() || "none"} project=${projectLabel() || "none"}`,
                    )
                    navigate(`/${params.dir}/session`)
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
                    class="titlebar-icon w-6 h-8 p-0 box-border data-[expanded]:bg-surface-base-active"
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
                              <Show when={current()}>
                                <Icon name="check-small" size="small" class="shrink-0 text-icon-weak" />
                              </Show>
                            </DropdownMenu.Item>
                          )
                        }}
                      </For>
                    </DropdownMenu.Group>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopover />
            </Tooltip>
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
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
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
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={() => resolved}>
          <SyncProvider>
            <SkillsProvider>
              <ProjectStatusPortal />
              <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
            </SkillsProvider>
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
