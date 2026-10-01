import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createSignal, onCleanup, type ParentProps } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"

const SEARCH_DEBOUNCE_MS = 150

/**
 * Fuzzy file search box for the file tree panel. While the query is empty the
 * children (the regular tree) render; once a query is typed the tree is
 * replaced by a flat list of fuzzy-matched files (backend `find.files`).
 */
export default function FileTreeSearch(props: ParentProps<{ onFileClick: (path: string) => void }>) {
  const file = useFile()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)

  let token = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let input: HTMLInputElement | undefined
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const reset = () => {
    token++
    if (timer) clearTimeout(timer)
    timer = undefined
    setResults([])
    setLoading(false)
  }

  const run = (value: string) => {
    const current = ++token
    setLoading(true)
    file
      .searchFiles(value)
      .then((paths) => {
        if (current !== token) return
        setResults(paths)
        setLoading(false)
      })
      .catch(() => {
        if (current !== token) return
        setResults([])
        setLoading(false)
      })
  }

  const onInput = (value: string) => {
    setQuery(value)
    if (!value.trim()) {
      reset()
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => run(value.trim()), SEARCH_DEBOUNCE_MS)
  }

  const clear = () => {
    setQuery("")
    reset()
    input?.focus()
  }

  const leaf = (path: string) => {
    const idx = path.lastIndexOf("/")
    return idx === -1 ? path : path.slice(idx + 1)
  }

  const dir = (path: string) => {
    const idx = path.lastIndexOf("/")
    return idx === -1 ? "" : path.slice(0, idx + 1)
  }

  return (
    <div data-component="filetree-search" class="flex h-full flex-col">
      <div class="sticky top-0 z-10 shrink-0 bg-background-stronger pb-2 pt-3">
        <div class="relative flex items-center">
          <div class="pointer-events-none absolute left-2 flex size-4 items-center justify-center text-icon-weak">
            <Icon name="magnifying-glass" size="small" />
          </div>
          <input
            ref={input}
            value={query()}
            spellcheck={false}
            autocomplete="off"
            placeholder={language.t("session.files.search")}
            data-slot="filetree-search-input"
            class="h-7 w-full rounded-md border border-border-weak-base bg-background-base pl-7 pr-7 text-12-regular text-text-strong outline-none transition-colors placeholder:text-text-weak focus:border-border-focus"
            onInput={(event) => onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query()) {
                event.stopPropagation()
                clear()
              }
            }}
          />
          <Show when={query()}>
            <button
              type="button"
              class="absolute right-1 flex size-5 items-center justify-center rounded text-icon-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
              aria-label={language.t("common.clear")}
              onClick={clear}
            >
              <Icon name="close-small" size="small" />
            </button>
          </Show>
        </div>
      </div>
      <Show
        when={query().trim()}
        fallback={props.children}
      >
        <div class="flex flex-col gap-0.5 pb-3">
          <Show when={!loading() && results().length === 0}>
            <div class="px-2 py-1 text-12-regular text-text-weak">{language.t("palette.empty")}</div>
          </Show>
          <For each={results()}>
            {(path) => {
              const node = (): FileNode => ({
                name: leaf(path),
                path,
                absolute: path,
                type: "file",
                ignored: false,
              })
              return (
                <button
                  type="button"
                  class="w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer [contain:layout_style_paint]"
                  onClick={() => props.onFileClick(path)}
                >
                  <div class="w-4 shrink-0" />
                  <FileIcon node={node()} class="size-4 shrink-0 filetree-icon filetree-icon--color" />
                  <span class="shrink-0 text-12-medium text-text-strong">{leaf(path)}</span>
                  <span class="min-w-0 truncate text-12-regular text-text-weaker">{dir(path)}</span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
