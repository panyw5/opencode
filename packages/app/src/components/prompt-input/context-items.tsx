import { Component, For, Show } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { A } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/core/util/path"
import type { ContextItem, FileContextItem } from "@/context/prompt"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: FileContextItem & { key: string }) => boolean
  openComment: (item: FileContextItem & { key: string }) => void
  remove: (item: PromptContextItem) => void
  t: (key: string) => string
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  return (
    <Show when={props.items.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
        <For each={props.items}>
          {(item) => {
            if (item.type === "session")
              return (
                <div
                  data-component="session-reference"
                  data-session-id={item.sessionID}
                  data-directory={item.directory}
                  class="shrink-0 flex flex-col gap-1.5 rounded-xl border border-border-weak-base/70 p-3 w-72 max-w-[calc(100vw-64px)] bg-background-stronger transition-colors duration-150 hover:border-border-base"
                >
                  <div class="flex items-center gap-2">
                    <div class="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised-base">
                      <Icon name="speech-bubble" size="small" class="text-icon-weak" />
                    </div>
                    <A
                      class="min-w-0 flex-1 truncate text-12-medium text-text-strong hover:underline"
                      href={`/${base64Encode(item.directory)}/session/${item.sessionID}`}
                      title={props.t("prompt.session.open")}
                    >
                      {item.title || props.t("prompt.session.menuTitle")}
                    </A>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto shrink-0 size-5 rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                      aria-label={props.t("prompt.session.remove")}
                      onClick={() => props.remove(item)}
                    />
                  </div>
                  <div class="pl-8 truncate text-11-regular text-text-weak" title={item.directory}>
                    {getFilename(item.directory)}
                  </div>
                  <div
                    class="mt-1 border-l-2 border-border-base/60 pl-2 text-12-regular leading-relaxed text-text-weak line-clamp-2 whitespace-pre-wrap"
                    title={item.summary}
                  >
                    {item.summary || props.t("prompt.session.noMessages")}
                  </div>
                </div>
              )
            const directory = getDirectory(item.path)
            const filename = getFilename(item.path)
            const label = getFilenameTruncated(item.path, 14)
            const selected = props.active(item)

            return (
              <Tooltip
                value={
                  <span class="flex max-w-[300px]">
                    <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                      {directory}
                    </span>
                    <span class="shrink-0">{filename}</span>
                  </span>
                }
                placement="top"
                openDelay={2000}
              >
                <div
                  classList={{
                    "group shrink-0 flex flex-col rounded-[6px] pl-4 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all transition-transform shadow-xs-border hover:shadow-xs-border-hover": true,
                    "hover:bg-surface-interactive-weak": !!item.commentID && !selected,
                    "bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover": selected,
                    "bg-background-stronger": !selected,
                  }}
                  onClick={() => props.openComment(item)}
                >
                  <div class="flex items-center gap-1.5">
                    <FileIcon
                      node={{ path: item.path, type: item.path.endsWith("/") ? "directory" : "file" }}
                      class="shrink-0 size-3.5"
                    />
                    <div class="flex items-center text-11-regular min-w-0 font-medium">
                      <span class="text-text-strong whitespace-nowrap">{label}</span>
                      <Show when={item.selection}>
                        {(sel) => (
                          <span class="text-text-weak whitespace-nowrap shrink-0">
                            {sel().startLine === sel().endLine
                              ? `:${sel().startLine}`
                              : `:${sel().startLine}-${sel().endLine}`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto size-3.5 text-text-weak hover:text-text-strong transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.remove(item)
                      }}
                      aria-label={props.t("prompt.context.removeFile")}
                    />
                  </div>
                  <Show when={item.comment}>
                    {(comment) => <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{comment()}</div>}
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
