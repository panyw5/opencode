import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import "./config-create-menu.css"

export function ConfigCreateMenu(props: {
  kind: "skill" | "command" | "mcp"
  label: string
  globalRoot?: string
  projects: { root: string; label: string }[]
  disabled: boolean
  onCreate: (root?: string, label?: string) => void
}) {
  const language = useLanguage()
  const select = (root = "", label = "") => {
    console.debug(
      `[config-create] select kind=${props.kind} scope=${root ? "project" : "global"} root=${root || props.globalRoot || ""}`,
    )
    props.onCreate(root, label)
  }

  return (
    <DropdownMenu
      placement="bottom-start"
      gutter={6}
      onOpenChange={(open) => {
        console.debug(`[config-create] menu kind=${props.kind} open=${open} projects=${props.projects.length}`)
      }}
    >
      <DropdownMenu.Trigger
        as={Button}
        size="small"
        variant="ghost"
        icon="folder-add-left"
        data-config-create={props.kind}
        class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active focus-visible:border-border-strong focus-visible:bg-surface-base-hover disabled:border-border-weak-base disabled:bg-background-base disabled:text-text-weaker"
        disabled={props.disabled || (!props.globalRoot && props.projects.length === 0)}
      >
        {props.label}
        <Icon name="chevron-down" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-config-create-menu={props.kind}
          class="min-w-64 max-w-[min(28rem,calc(100vw-24px))] max-h-[min(40rem,var(--kb-popper-content-available-height))] overflow-y-auto"
        >
          <DropdownMenu.Item disabled={!props.globalRoot} onSelect={() => select()}>
            <Icon name="globe" size="small" />
            <div class="min-w-0 flex-1">
              <DropdownMenu.ItemLabel>{language.t("config.commands.group.global")}</DropdownMenu.ItemLabel>
              <DropdownMenu.ItemDescription class="block truncate" title={props.globalRoot}>
                {props.globalRoot}
              </DropdownMenu.ItemDescription>
            </div>
          </DropdownMenu.Item>
          <Show when={props.projects.length > 0}>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>{language.t("config.commands.group.project")}</DropdownMenu.GroupLabel>
              <For each={props.projects}>
                {(project) => (
                  <DropdownMenu.Item onSelect={() => select(project.root, project.label)}>
                    <Icon name="folder" size="small" />
                    <div class="min-w-0 flex-1">
                      <DropdownMenu.ItemLabel class="block truncate">{project.label}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemDescription class="block truncate" title={project.root}>
                        {project.root}
                      </DropdownMenu.ItemDescription>
                    </div>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Group>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
