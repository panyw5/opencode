import { Popover } from "@kobalte/core/popover"
import { createEffect, createMemo, createUniqueId, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createConfigLocalLoader } from "@/pages/config-local-loader"
import {
  DialogSelectDirectory,
  directoryAbsoluteToDisplay,
  directoryBrowsePath,
  displayToAbsolute,
  normalizeDirectoryPath,
  trimDirectoryTrailing,
  withDirectoryTrailing,
  type BrowseEntry,
} from "./dialog-select-directory"
import { directoryInputValue, filterDirectoryEntries, moveDirectoryHighlight } from "./directory-completion"

/** Directory-only completion shared by the home launcher and configuration forms. */
export function DirectoryInput(props: {
  value: string
  label: string
  description?: string
  error?: string
  placeholder?: string
  disabled?: boolean
  hideLabel?: boolean
  home?: string
  absolute?: boolean
  suffix?: string
  onChange: (value: string) => void
  onSubmit?: (directory: string) => void
  onBrowse?: () => void
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const sync = useGlobalSync()
  const dialog = useDialog()
  const id = createUniqueId()
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let emitted = props.value
  let disposed = false
  const options = new Map<number, HTMLButtonElement>()
  const [state, set] = createStore({
    query: props.value,
    open: false,
    highlighted: 0,
    browsing: false,
    browseError: "",
  })
  const home = () => props.home ?? sync.data.path.home
  const open = () => state.open && !props.disabled && !!platform.listLocalDirectory
  const browsePath = createMemo(() => displayToAbsolute(directoryBrowsePath(state.query), home(), home()))
  const entries = createConfigLocalLoader(
    () => (open() ? browsePath() : false),
    async (directory) => {
      const list = await platform.listLocalDirectory!(directory)
      return list
        .filter((entry) => entry.kind === "directory")
        .map((entry) => ({
          name: getFilename(entry.path),
          path: trimDirectoryTrailing(normalizeDirectoryPath(entry.path)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    "directory-input",
  )
  const filtered = createMemo(() => filterDirectoryEntries(entries.latest ?? [], state.query).slice(0, 8))
  const available = () => (!entries.loading && !entries.error ? filtered() : [])
  const error = () => props.error || state.browseError

  createEffect(() => {
    const value = props.value
    if (value === emitted) return
    emitted = value
    set("query", value)
  })
  createEffect(() => {
    if (props.disabled) set("open", false)
  })
  createEffect(() => {
    state.query
    set("highlighted", 0)
  })
  createEffect(() => {
    const count = available().length
    if (state.highlighted >= count && state.highlighted !== 0) set("highlighted", Math.max(0, count - 1))
  })
  createEffect(() => {
    if (!open()) return
    const highlighted = state.highlighted
    queueMicrotask(() => {
      if (!disposed) options.get(highlighted)?.scrollIntoView({ block: "nearest" })
    })
  })
  onCleanup(() => {
    disposed = true
  })

  const update = (query: string) => {
    set({ query, browseError: "" })
    emitted = directoryInputValue(query, home(), props.absolute ?? false)
    if (emitted !== props.value) props.onChange(emitted)
  }
  const complete = (entry?: BrowseEntry) => {
    if (!entry) return false
    const query = withDirectoryTrailing(directoryAbsoluteToDisplay(entry.path, home()))
    update(query)
    set("open", true)
    input?.focus()
    queueMicrotask(() => {
      if (!disposed) input?.setSelectionRange(query.length, query.length)
    })
    return true
  }
  const browse = async () => {
    if (props.disabled || state.browsing) return
    set({ open: false, browseError: "" })
    if (props.onBrowse) {
      props.onBrowse()
      return
    }
    const select = (result: string | string[] | null) => {
      const value = Array.isArray(result) ? result[0] : result
      if (!value || disposed || props.disabled) return
      update(props.absolute ? value : directoryAbsoluteToDisplay(value, home()))
      input?.focus()
      set("open", false)
    }
    if (!platform.openDirectoryPickerDialog) {
      dialog.show(() => <DialogSelectDirectory title={props.label} onSelect={select} />)
      return
    }
    set("browsing", true)
    try {
      select(await platform.openDirectoryPickerDialog({ title: props.label, multiple: false }))
    } catch (error) {
      console.warn("[directory-input] picker failed error=" + String(error))
      if (!disposed) set("browseError", language.t("directoryInput.browseFailed"))
    } finally {
      if (!disposed) set("browsing", false)
    }
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const items = available()
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      set({ open: true, highlighted: moveDirectoryHighlight(state.highlighted, items.length, event.key, open()) })
    } else if (event.key === "Tab" && !event.shiftKey && open() && complete(items[state.highlighted])) {
      event.preventDefault()
    } else if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      const entry = open() ? items[state.highlighted] : undefined
      if (props.onSubmit)
        props.onSubmit(
          entry && !state.query.endsWith("/") ? entry.path : displayToAbsolute(state.query, home(), home()),
        )
      else if (open()) complete(entry)
    } else if (event.key === "Escape" && open()) {
      event.preventDefault()
      event.stopPropagation()
      set("open", false)
    }
  }

  return (
    <div ref={root} class="min-w-0 flex-1" data-component="directory-input">
      <label for={id} class={props.hideLabel ? "sr-only" : "mb-1.5 block text-12-medium text-text-base"}>
        {props.label}
      </label>
      <Popover
        open={open()}
        onOpenChange={(value) => set("open", value)}
        modal={false}
        placement="bottom-start"
        gutter={6}
        sameWidth
      >
        <div class="flex min-w-0 gap-2">
          <Popover.Anchor class="flex h-11 min-w-0 flex-1 items-center overflow-hidden rounded-lg border border-border-weak-base bg-background-base text-text-strong transition-colors focus-within:border-border-strong-base focus-within:ring-1 focus-within:ring-border-strong-base">
            <span class="pointer-events-none pl-3 text-icon-weak" aria-hidden="true">
              <Icon name="terminal" size="normal" />
            </span>
            <input
              ref={input}
              id={id}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={id + "-options"}
              aria-expanded={open()}
              aria-activedescendant={
                open() && available()[state.highlighted] ? id + "-option-" + state.highlighted : undefined
              }
              aria-describedby={error() ? id + "-error" : props.description ? id + "-description" : undefined}
              aria-invalid={!!error()}
              value={state.query}
              placeholder={props.placeholder}
              disabled={props.disabled}
              spellcheck={false}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              onFocus={() => set("open", true)}
              onClick={() => set("open", true)}
              onInput={(event) => {
                update(normalizeDirectoryPath(event.currentTarget.value))
                set("open", true)
              }}
              onKeyDown={keyDown}
              class="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-13-regular outline-none placeholder:text-text-weaker disabled:opacity-50"
            />
            <Show when={props.suffix}>
              <span class="flex h-full max-w-[50%] shrink-0 items-center border-l border-border-weak-base px-3 font-mono text-13-regular text-text-weak">
                <span class="truncate">{props.suffix}</span>
              </span>
            </Show>
          </Popover.Anchor>
          <Button
            type="button"
            size="large"
            variant="secondary"
            class="!h-11 shrink-0 justify-center px-3"
            disabled={props.disabled || state.browsing}
            aria-label={language.t("directoryInput.browse", { label: props.label })}
            onClick={() => void browse()}
          >
            <Icon name="folder" size="small" />
          </Button>
        </div>
        <Popover.Portal>
          <Popover.Content
            id={id + "-options"}
            role="listbox"
            aria-label={props.label}
            data-component="directory-completions"
            class="z-50 max-h-72 overflow-y-auto rounded-xl border border-border-weak-base bg-surface-raised-base p-1.5 outline-none"
            style={{ "max-height": "min(18rem, var(--kb-popper-content-available-height))" }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              const target = event.detail.originalEvent.target
              if (target instanceof Node && root?.contains(target)) event.preventDefault()
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              set("open", false)
            }}
          >
            <Show
              when={!entries.loading}
              fallback={
                <div class="px-3 py-5 text-center text-12-regular text-text-weak">{language.t("common.loading")}</div>
              }
            >
              <Show
                when={!entries.error}
                fallback={
                  <div role="status" class="px-3 py-5 text-center text-12-regular text-text-weak">
                    {language.t("directoryInput.listFailed")}
                  </div>
                }
              >
                <Show
                  when={filtered().length}
                  fallback={
                    <div class="px-3 py-5 text-center text-12-regular text-text-weak">
                      {language.t("home.quickAdd.noMatches")}
                    </div>
                  }
                >
                  <For each={filtered()}>
                    {(entry, index) => (
                      <button
                        ref={(node) => {
                          options.set(index(), node)
                          onCleanup(() => options.delete(index()))
                        }}
                        id={id + "-option-" + index()}
                        type="button"
                        role="option"
                        aria-selected={state.highlighted === index()}
                        class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-13-regular outline-none transition-colors"
                        classList={{
                          "bg-surface-base-active text-text-strong": state.highlighted === index(),
                          "text-text-base hover:bg-surface-base-hover": state.highlighted !== index(),
                        }}
                        onPointerEnter={() => set("highlighted", index())}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => complete(entry)}
                      >
                        <FileIcon node={{ path: entry.path, type: "directory" }} class="size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                        <span class="text-11-regular text-text-weaker">Enter</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
      <Show
        when={error()}
        fallback={
          <Show when={props.description}>
            <div id={id + "-description"} class="mt-2 text-12-regular text-text-weak">
              {props.description}
            </div>
          </Show>
        }
      >
        <div id={id + "-error"} role="alert" class="mt-2 text-12-regular text-text-danger-base">
          {error()}
        </div>
      </Show>
    </div>
  )
}
