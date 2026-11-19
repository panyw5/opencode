import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { createMemo, For } from "solid-js"
import { getAvatarColors, type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { splitI18nTemplate } from "@/pages/layout/helpers"
import { RailTooltip } from "@/pages/layout/rail-tooltip"

/**
 * Split "new session in current project" control shown left of the titlebar
 * actions. Rendered by project routes and by the home page so the session tabs
 * keep the same width when switching between them.
 */
export function NewSessionProjectPill(props: {
  projectLabel: string
  projects: LocalProject[]
  activeDirectory?: string
  onPrimary: () => void
  onSelect: (directory: string) => void
}) {
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.projectLabel
    if (!project) return language.t("command.session.new")
    return language.t("command.session.new.tooltip", { project })
  })
  const title = () => {
    const project = props.projectLabel
    if (!project) return language.t("command.session.new")
    const parts = splitI18nTemplate(language.t("command.session.new.tooltip"), "project")
    return (
      <For each={parts}>
        {(part) => (part.type === "token" ? <span data-slot="rail-tooltip-mark">{project}</span> : part.value)}
      </For>
    )
  }

  return (
    <div class="mr-2 flex items-center">
      <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
        <RailTooltip title={title()} placement="bottom">
          <IconButton
            data-action="session-new-button"
            icon="new-session"
            size="normal"
            variant="ghost"
            class="rounded-none h-full w-6 p-0 border-none shadow-none"
            aria-label={label()}
            onClick={props.onPrimary}
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
              class="session-child-agent-scrollbar w-96 max-w-[calc(100vw-32px)]"
              style={{
                padding: "8px",
                "max-height": "min(520px, calc(100dvh - 64px))",
                "overflow-y": "auto",
                "overscroll-behavior": "contain",
              }}
            >
              <DropdownMenu.Group>
                <For each={props.projects}>
                  {(project) => {
                    const name = () => project.name || getFilename(project.worktree)
                    const current = () => project.worktree === props.activeDirectory
                    return (
                      <DropdownMenu.Item
                        data-action="session-new-project-item"
                        data-project={base64Encode(project.worktree)}
                        class="min-w-0"
                        style={{ padding: "10px 14px", gap: "12px" }}
                        aria-current={current() ? "page" : undefined}
                        onSelect={() => props.onSelect(project.worktree)}
                      >
                        <Avatar
                          fallback={name()}
                          src={project.icon?.override}
                          {...getAvatarColors(project.icon?.color)}
                          class="size-6 rounded shrink-0"
                        />
                        <div class="flex min-w-0 flex-1 items-center gap-3">
                          <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate text-15-medium text-text-strong">
                            {name()}
                          </DropdownMenu.ItemLabel>
                          <DropdownMenu.ItemDescription
                            class="max-w-[55%] shrink-0 truncate text-right text-13-regular text-text-weak"
                            style={{ "font-size": "13px" }}
                          >
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
  )
}
