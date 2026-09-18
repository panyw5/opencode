import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { usePrompt } from "@/context/prompt"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="truncate text-12-mono">{getFilename(props.path)}</span>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const platform = usePlatform()
  const sdk = useSDK()
  const server = useServer()
  const prompt = usePrompt()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })
  const fullPath = createMemo(() => {
    const value = path()
    if (!value) return
    return `${sdk.directory.replace(/[\\/]+$/, "")}/${value}`
  })
  const parentPath = (value: string) => {
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"))
    if (index === 2 && value[1] === ":") return value.slice(0, 3)
    return index < 0 ? value : value.slice(0, index) || value.slice(0, 1)
  }
  const openFolderDisabled = () => {
    if (platform.platform !== "desktop" || !server.isLocal()) return true
    return platform.os === "windows" ? !platform.openPath : !platform.openInFinder
  }
  const openFolder = () => {
    const target = fullPath()
    if (!target || openFolderDisabled()) return
    const folder = parentPath(target)
    console.debug(`[file-preview] tab open-folder path=${target} folder=${folder} os=${platform.os ?? "unknown"}`)
    const task = platform.os === "windows" ? platform.openPath?.(folder) : platform.openInFinder?.(folder)
    Promise.resolve(task).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.debug(`[file-preview] tab open-folder failed path=${target} err=${message}`)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    })
  }
  const copyPath = () => {
    const target = fullPath()
    if (!target) return
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[file-preview] tab copy-path path=${target}`)
    if (!clipboard?.writeText) {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }
    void clipboard.writeText(target).then(
      () => console.debug(`[file-preview] tab copied-path path=${target}`),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.debug(`[file-preview] tab copy-path failed path=${target} err=${message}`)
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
      },
    )
  }
  const addFileToPrompt = () => {
    const value = path()
    if (!value) return
    console.debug(`[file-preview] tab mention-file path=${value}`)
    prompt.context.add({ type: "file", path: value })
  }
  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div class="relative h-full">
        <ContextMenu>
          <ContextMenu.Trigger as="div" class="h-full">
            <Tabs.Trigger
              class="session-file-tab-trigger"
              value={props.tab}
              closeButton={
                <TooltipKeybind
                  title={language.t("common.closeTab")}
                  keybind={command.keybind("tab.close")}
                  placement="bottom"
                  gutter={10}
                >
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    class="h-5 w-5"
                    onClick={() => props.onTabClose(props.tab)}
                    aria-label={language.t("common.closeTab")}
                  />
                </TooltipKeybind>
              }
              hideCloseButton
              onMiddleClick={() => props.onTabClose(props.tab)}
            >
              <Show when={content()}>{(value) => value()}</Show>
            </Tabs.Trigger>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content>
              <ContextMenu.Item disabled={openFolderDisabled()} onSelect={openFolder}>
                <ContextMenu.Icon>
                  <Icon name="folder" size="small" />
                </ContextMenu.Icon>
                <ContextMenu.ItemLabel>{language.t("session.new.path.openFolder")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={copyPath}>
                <ContextMenu.Icon>
                  <Icon name="copy" size="small" />
                </ContextMenu.Icon>
                <ContextMenu.ItemLabel>{language.t("session.header.open.copyPath")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={addFileToPrompt}>
                <ContextMenu.Icon>
                  <Icon name="file" size="small" />
                </ContextMenu.Icon>
                <ContextMenu.ItemLabel>{language.t("session.fileTab.mentionInSession")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
      </div>
    </div>
  )
}
