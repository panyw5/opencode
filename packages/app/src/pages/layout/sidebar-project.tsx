import { createMemo, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { createSortable } from "@thisbeyond/solid-dnd"
import { useLayout, type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { ProjectIcon } from "./sidebar-items"
import { displayName } from "./helpers"
import { projectSelected } from "./sidebar-project-helpers"
import { RailTooltip } from "./rail-tooltip"

// Stable 1..6 hash from project path; consumed by Arc theme via [data-rail-hue].
// Inert on other themes (no selector reads the attribute).
function railHue(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0
  return (Math.abs(h) % 6) + 1
}

export type ProjectSidebarContext = {
  current: Accessor<string | undefined>
  sidebarReduced: Accessor<boolean>
  consumeProjectClick: () => boolean
  selectSidebarProject: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1" style={{ cursor: "grabbing" }}>
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

const ProjectTile = (props: {
  project: LocalProject
  mobile?: boolean
  sidebarReduced: Accessor<boolean>
  selected: Accessor<boolean>
  active: Accessor<boolean>
  dirs: Accessor<string[]>
  consumeProjectClick: () => boolean
  selectSidebarProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const notification = useNotification()
  const layout = useLayout()
  const platform = usePlatform()
  const navigate = useNavigate()
  const [copyState, setCopyState] = createStore({ copied: false })
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  const unseenCount = createMemo(() =>
    props.dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )

  const clear = () =>
    props
      .dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))

  const name = () => displayName(props.project)

  const openInFileManager = () => {
    const directory = props.project.worktree
    if (!directory) return
    console.debug(`[sidebar-project] open in file manager dir=${directory} os=${platform.os}`)
    if (platform.os === "windows" && platform.openPath) {
      void platform.openPath(directory)
      return
    }
    if (platform.openInFinder) {
      void platform.openInFinder(directory).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.debug(`[sidebar-project] open in file manager failed dir=${directory} err=${message}`)
        showToast({
          variant: "error",
          title: props.language.t("common.requestFailed"),
          description: message,
        })
      })
    }
  }

  const copyProjectPath = () => {
    const directory = props.project.worktree
    if (!directory) return
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[sidebar-project] copy path dir=${directory}`)
    if (!clipboard?.writeText) {
      console.debug(`[sidebar-project] clipboard unavailable dir=${directory}`)
      showToast({
        variant: "error",
        title: props.language.t("common.requestFailed"),
        description: "Clipboard unavailable",
      })
      return
    }
    void clipboard.writeText(directory).then(
      () => {
        console.debug(`[sidebar-project] copied path dir=${directory}`)
        setCopyState("copied", true)
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setCopyState("copied", false), 1_200)
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.debug(`[sidebar-project] copy path failed dir=${directory} err=${message}`)
        showToast({
          variant: "error",
          title: props.language.t("common.requestFailed"),
          description: message,
        })
      },
    )
  }

  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  const openNewSession = () => {
    const directory = props.project.worktree
    if (!directory) return
    console.debug(`[sidebar-project] new session dir=${directory}`)
    navigate(`/${base64Encode(directory)}/session`)
    layout.sidebar.close()
  }

  const openInFileManagerLabel = () =>
    platform.os === "macos"
      ? props.language.t("command.project.openInFinder")
      : platform.os === "windows"
        ? props.language.t("command.project.openInFileExplorer")
        : props.language.t("command.project.openInFileManager")

  const openInFileManagerDisabled = () =>
    platform.os === "windows" ? !platform.openPath : !platform.openInFinder

  return (
    <RailTooltip mobile={props.mobile} title={name()} inactive={props.active()}>
      <ContextMenu
        modal
        onOpenChange={(value) => {
          props.setMenu(value)
        }}
      >
        <ContextMenu.Trigger
          as="button"
          type="button"
          aria-label={name()}
          aria-current={props.selected() ? "true" : undefined}
          data-action="project-switch"
          data-project={base64Encode(props.project.worktree)}
          data-rail-hue={railHue(props.project.worktree)}
          classList={{
            "flex items-center justify-center size-10 p-1 rounded-full overflow-hidden cursor-pointer": true,
            "transition-all duration-150": !props.sidebarReduced(),
            "bg-surface-interactive-selected border-2 border-border-brand-base": props.selected(),
            "bg-transparent border border-transparent hover:bg-surface-base-hover hover:border-border-base hover:scale-105":
              !props.sidebarReduced() && !props.selected() && !props.active(),
            "bg-surface-base-hover border border-border-base": !props.selected() && props.active(),
          }}
          onPointerDown={(event) => {
            if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
            event.preventDefault()
          }}
          onClick={() => {
            if (props.consumeProjectClick()) return
            if (props.selected()) {
              layout.sidebar.toggle()
              return
            }
            props.selectSidebarProject(props.project.worktree)
          }}
        >
          <ProjectIcon project={props.project} notify />
        </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item
            data-action="project-open-in-finder"
            data-project={base64Encode(props.project.worktree)}
            disabled={openInFileManagerDisabled()}
            onSelect={openInFileManager}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="folder" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{openInFileManagerLabel()}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-copy-path"
            data-project={base64Encode(props.project.worktree)}
            onSelect={copyProjectPath}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name={copyState.copied ? "check" : "copy"} size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{props.language.t("command.project.copyPath")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-new-session"
            data-project={base64Encode(props.project.worktree)}
            onSelect={openNewSession}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="new-session" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{props.language.t("command.session.new")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
            <ContextMenu.ItemLabel>{props.language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-workspaces-toggle"
            data-project={base64Encode(props.project.worktree)}
            disabled={props.project.vcs !== "git" && !props.workspacesEnabled(props.project)}
            onSelect={() => props.toggleProjectWorkspaces(props.project)}
          >
            <ContextMenu.ItemLabel>
              {props.workspacesEnabled(props.project)
                ? props.language.t("sidebar.workspaces.disable")
                : props.language.t("sidebar.workspaces.enable")}
            </ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-clear-notifications"
            data-project={base64Encode(props.project.worktree)}
            disabled={unseenCount() === 0}
            onSelect={clear}
          >
            <ContextMenu.ItemLabel>{props.language.t("sidebar.project.clearNotifications")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="project-close-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.closeProject(props.project.worktree)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
    </RailTooltip>
  )
}

export const SortableProject = (props: {
  project: LocalProject
  mobile?: boolean
  ctx: ProjectSidebarContext
}): JSX.Element | null => {
  if (!props.project?.worktree) return null
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() =>
    projectSelected(props.ctx.current(), props.project.worktree, props.project.sandboxes),
  )
  const language = useLanguage()
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({ menu: false })
  const tile = () => (
    <ProjectTile
      project={props.project}
      mobile={props.mobile}
      sidebarReduced={props.ctx.sidebarReduced}
      selected={selected}
      active={() => state.menu}
      dirs={dirs}
      consumeProjectClick={props.ctx.consumeProjectClick}
      selectSidebarProject={props.ctx.selectSidebarProject}
      showEditProjectDialog={props.ctx.showEditProjectDialog}
      toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
      workspacesEnabled={props.ctx.workspacesEnabled}
      closeProject={props.ctx.closeProject}
      setMenu={(value) => setState("menu", value)}
      language={language}
    />
  )

  return (
    <div
      use:sortable
      class="flex w-full justify-center py-1.5"
      style={{
        transition: sortable.isActiveDraggable ? undefined : "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)",
        "will-change": "transform",
      }}
      classList={{ "opacity-30": sortable.isActiveDraggable }}
    >
      {tile()}
    </div>
  )
}
