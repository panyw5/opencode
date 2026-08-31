import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  directoryAbsoluteToDisplay,
  directoryBrowseLeaf,
  directoryBrowsePath,
  displayToAbsolute,
  normalizeDirectoryPath,
  trimDirectoryTrailing,
  withDirectoryTrailing,
  type BrowseEntry,
} from "@/components/dialog-select-directory"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export function filterHomeDirectoryEntries(entries: BrowseEntry[], query: string) {
  const needle = directoryBrowseLeaf(query).toLocaleLowerCase()
  return entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(needle))
}

export function moveHomeDirectoryHighlight(
  current: number,
  count: number,
  key: "ArrowDown" | "ArrowUp",
  open: boolean,
) {
  if (count <= 0) return 0
  if (!open) return key === "ArrowDown" ? 0 : count - 1
  if (key === "ArrowDown") return Math.min(count - 1, current + 1)
  return Math.max(0, current - 1)
}

export function HomePathInput(props: { home: string; onOpen: (directory: string) => void; onBrowse: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  let rootRef: HTMLDivElement | undefined
  let inputRef: HTMLInputElement | undefined
  const optionRefs = new Map<number, HTMLButtonElement>()
  const [state, setState] = createStore({
    query: "~/",
    open: false,
    highlighted: 0,
    selecting: false,
    error: "",
  })

  const browseDisplayPath = createMemo(() => directoryBrowsePath(state.query))
  const browseAbsolutePath = createMemo(() => displayToAbsolute(browseDisplayPath(), props.home, props.home))
  const targetPath = createMemo(() => displayToAbsolute(state.query, props.home, props.home))

  const [entries] = createResource(
    browseAbsolutePath,
    async (directory) => {
      if (!directory || !platform.listLocalDirectory) return [] as BrowseEntry[]
      const list = await platform.listLocalDirectory(directory).catch(() => [])
      return list
        .filter((item) => item.kind === "directory")
        .map((item) => ({ name: getFilename(item.path), path: trimDirectoryTrailing(item.path.replaceAll("\\", "/")) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    { initialValue: [] as BrowseEntry[] },
  )

  const filtered = createMemo(() => filterHomeDirectoryEntries(entries.latest ?? [], state.query).slice(0, 8))
  const dropdownOpen = createMemo(() => state.open && !!platform.listLocalDirectory)
  const activeID = createMemo(() => {
    const item = filtered()[state.highlighted]
    return item ? `home-path-option-${state.highlighted}` : undefined
  })

  createEffect(() => {
    state.query
    setState("error", "")
  })

  createEffect(() => {
    state.query
    setState("highlighted", 0)
  })

  createEffect(() => {
    const items = filtered()
    const next = items.length === 0 ? 0 : Math.min(state.highlighted, items.length - 1)
    if (next !== state.highlighted) {
      setState("highlighted", next)
      return
    }
  })

  createEffect(() => {
    if (!dropdownOpen()) return
    const index = state.highlighted
    queueMicrotask(() => optionRefs.get(index)?.scrollIntoView({ block: "nearest" }))
  })

  createEffect(() => {
    state.query
    const input = inputRef
    if (!input) return
    queueMicrotask(() => {
      input.scrollLeft = input.scrollWidth
    })
  })

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      const inside = target instanceof Node && !!rootRef?.contains(target)
      if (!inside && state.open) {
        setState("open", false)
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true))
  })

  function complete(entry: BrowseEntry | undefined) {
    if (!entry) return false
    setState({ query: withDirectoryTrailing(directoryAbsoluteToDisplay(entry.path, props.home)), open: true })
    inputRef?.focus()
    return true
  }

  async function submit(path = targetPath()) {
    if (!path || state.selecting) return
    setState({ selecting: true, error: "", open: false })
    try {
      if (platform.filterDirectories) {
        const [valid] = await platform.filterDirectories([path])
        if (!valid) {
          setState({ error: language.t("home.quickAdd.invalid"), open: true })
          return
        }
        props.onOpen(valid)
        return
      }
      props.onOpen(path)
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : language.t("home.quickAdd.invalid"), open: true })
    } finally {
      setState("selecting", false)
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    const items = filtered()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const next = moveHomeDirectoryHighlight(state.highlighted, items.length, event.key, state.open)
      setState({ open: true, highlighted: next })
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      const next = moveHomeDirectoryHighlight(state.highlighted, items.length, event.key, state.open)
      setState({ open: true, highlighted: next })
      return
    }
    if (event.key === "Tab" && !event.shiftKey && dropdownOpen() && complete(items[state.highlighted])) {
      event.preventDefault()
      return
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const highlighted = dropdownOpen() && !state.query.endsWith("/") ? items[state.highlighted] : undefined
      void submit(highlighted?.path ?? targetPath())
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setState("open", false)
    }
  }

  return (
    <div ref={(node) => (rootRef = node)} data-component="home-path-input" class="home-path-launcher relative">
      <div class="flex flex-col gap-2 sm:flex-row">
        <div class="relative min-w-0 flex-1">
          <div class="pointer-events-none absolute left-3 top-1/2 z-[1] flex size-5 -translate-y-1/2 items-center justify-center text-icon-weak">
            <Icon name="terminal" size="normal" />
          </div>
          <input
            ref={(node) => (inputRef = node)}
            role="combobox"
            aria-label={language.t("home.quickAdd.label")}
            aria-autocomplete="list"
            aria-controls="home-path-options"
            aria-expanded={dropdownOpen()}
            aria-activedescendant={dropdownOpen() ? activeID() : undefined}
            value={state.query}
            onFocus={() => setState("open", true)}
            onInput={(event) => {
              const query = normalizeDirectoryPath(event.currentTarget.value)
              setState({ query, open: true })
            }}
            onKeyDown={handleKeyDown}
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            placeholder={language.t("home.quickAdd.placeholder")}
            class="home-path-field h-11 w-full rounded-lg border border-border-weak-base bg-background-base pl-10 pr-3 text-14-mono text-text-strong outline-none transition-colors placeholder:text-text-weaker focus:border-border-strong-base focus:ring-1 focus:ring-border-strong-base"
          />
          <Show when={dropdownOpen()}>
            <div
              id="home-path-options"
              role="listbox"
              class="absolute inset-x-0 top-[calc(100%+0.375rem)] z-20 max-h-72 overflow-y-auto rounded-xl border border-border-weak-base bg-surface-raised-base p-1.5 shadow-lg"
            >
              <Show
                when={!entries.loading}
                fallback={<div class="px-3 py-6 text-center text-12-regular text-text-weak">{language.t("common.loading")}</div>}
              >
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <div class="px-3 py-6 text-center text-12-regular text-text-weak">
                      {language.t("home.quickAdd.noMatches")}
                    </div>
                  }
                >
                  <For each={filtered()}>
                    {(entry, index) => (
                      <button
                        ref={(node) => {
                          if (node) optionRefs.set(index(), node)
                          else optionRefs.delete(index())
                        }}
                        id={`home-path-option-${index()}`}
                        type="button"
                        role="option"
                        aria-selected={state.highlighted === index()}
                        class="home-path-option flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-13-regular outline-none transition-colors"
                        classList={{
                          "bg-surface-base-active text-text-strong": state.highlighted === index(),
                          "text-text-base hover:bg-surface-base-hover active:bg-surface-base-active": state.highlighted !== index(),
                        }}
                        onMouseEnter={() => setState("highlighted", index())}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void submit(entry.path)}
                      >
                        <FileIcon node={{ path: entry.path, type: "directory" }} class="size-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
                        <span class="shrink-0 text-11-regular text-text-weaker">Enter</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            size="large"
            variant="primary"
            class="!h-11 min-w-24 flex-1 justify-center sm:flex-none"
            disabled={state.selecting || !targetPath()}
            onClick={() => void submit()}
          >
            {state.selecting ? language.t("common.loading") : language.t("home.quickAdd.add")}
          </Button>
          <Button
            size="large"
            variant="secondary"
            class="!h-11 justify-center px-3"
            aria-label={language.t("home.quickAdd.browse")}
            onClick={props.onBrowse}
          >
            <Icon name="folder" size="small" />
          </Button>
        </div>
      </div>
      <Show when={state.error}>
        <div role="alert" class="mt-2 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
    </div>
  )
}
