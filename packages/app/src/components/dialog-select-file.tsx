import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { List } from "@opencode-ai/ui/list"
import { Progress } from "@opencode-ai/ui/progress"
import { TextField } from "@opencode-ai/ui/text-field"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { formatKeybind, useCommand, type CommandOption } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { projectOwner } from "@/pages/layout/helpers"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { decode64 } from "@/utils/base64"
import { getRelativeTime } from "@/utils/time"

type EntryType = "command" | "file" | "session" | "content"

type Entry = {
  id: string
  type: EntryType
  title: string
  description?: string
  keywords?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  archived?: number
  updated?: number
}

type DialogSelectFileMode = "all" | "files" | "commands"

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

const uniqueEntries = (items: Entry[]) => {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

const createCommandEntry = (option: CommandOption, category: string): Entry => ({
  id: "command:" + option.id,
  type: "command",
  title: option.title,
  description: option.description,
  keywords: option.keywords,
  keybind: option.keybind,
  category,
  option,
})

const createFileEntry = (path: string, category: string): Entry => ({
  id: "file:" + path,
  type: "file",
  title: path,
  category,
  path,
})

const createSessionEntry = (
  input: {
    directory: string
    id: string
    title: string
    description: string
    archived?: number
    updated?: number
  },
  category: string,
): Entry => ({
  id: `session:${input.directory}:${input.id}`,
  type: "session",
  title: input.title,
  description: input.description,
  category,
  directory: input.directory,
  sessionID: input.id,
  archived: input.archived,
  updated: input.updated,
})

function createCommandEntries(props: {
  filesOnly: () => boolean
  commandsOnly: () => boolean
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
}) {
  const allowed = createMemo(() => {
    if (props.filesOnly()) return []
    return props.command.options.filter(
      (option) =>
        !option.disabled &&
        !option.id.startsWith("suggested.") &&
        option.id !== "file.open" &&
        option.id !== "command.palette",
    )
  })

  const list = createMemo(() => {
    const category = props.language.t("palette.group.commands")
    return allowed().map((option) => createCommandEntry(option, category))
  })

  const picks = createMemo(() => {
    const all = allowed()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = props.language.t("palette.group.commands")
    return sorted.map((option) => createCommandEntry(option, category))
  })

  return { allowed, list, picks }
}

function createFileEntries(props: {
  file: ReturnType<typeof useFile>
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  language: ReturnType<typeof useLanguage>
}) {
  const tabState = createSessionTabs({
    tabs: props.tabs,
    pathFromTab: props.file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? props.file.tab(tab) : tab),
  })
  const recent = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = props.language.t("palette.group.files")
    const items: Entry[] = []

    for (const item of order) {
      const path = props.file.pathFromTab(item)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      items.push(createFileEntry(path, category))
    }

    return items.slice(0, ENTRY_LIMIT)
  })

  const root = createMemo(() => {
    const category = props.language.t("palette.group.files")
    const nodes = props.file.tree.children("")
    const paths = nodes
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
    return paths.slice(0, ENTRY_LIMIT).map((path) => createFileEntry(path, category))
  })

  return { recent, root }
}

function createSessionEntries(props: {
  workspaces: () => string[]
  label: (directory: string) => string
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
}) {
  const state: {
    token: number
    inflight: Promise<Entry[]> | undefined
    cached: Entry[] | undefined
  } = {
    token: 0,
    inflight: undefined,
    cached: undefined,
  }

  const sessions = (text: string) => {
    const query = text.trim()
    if (!query) {
      state.token += 1
      state.inflight = undefined
      state.cached = undefined
      return [] as Entry[]
    }

    if (state.cached) return state.cached
    if (state.inflight) return state.inflight

    const current = state.token
    const dirs = props.workspaces()
    if (dirs.length === 0) return [] as Entry[]

    state.inflight = Promise.all(
      dirs.map((directory) => {
        const description = props.label(directory)
        return props.globalSDK.client.session
          .list({ directory, roots: true })
          .then((x) =>
            (x.data ?? [])
              .filter((s) => !!s?.id)
              .map((s) => ({
                id: s.id,
                title: s.title ?? props.language.t("command.session.new"),
                description,
                directory,
                archived: s.time?.archived,
                updated: s.time?.updated,
              })),
          )
          .catch(
            () =>
              [] as {
                id: string
                title: string
                description: string
                directory: string
                archived?: number
                updated?: number
              }[],
          )
      }),
    )
      .then((results) => {
        if (state.token !== current) return [] as Entry[]
        const seen = new Set<string>()
        const category = props.language.t("command.category.session")
        const next = results
          .flat()
          .filter((item) => {
            const key = `${item.directory}:${item.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((item) => createSessionEntry(item, category))
        state.cached = next
        return next
      })
      .catch(() => [] as Entry[])
      .finally(() => {
        state.inflight = undefined
      })

    return state.inflight
  }

  return { sessions }
}

function createContentSearchEntries(props: {
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
}) {
  const [results, setResults] = createSignal<Entry[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [index, setIndex] = createSignal<{
    enabled: boolean
    state: "disabled" | "running" | "paused" | "complete"
    indexed: number
    total: number
    complete: boolean
    known: boolean
  }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let token = 0

  const setStatus = (value: typeof index extends () => infer Value ? Value : never) => setIndex(value)

  const refreshIndex = () =>
    props.globalSDK.client.experimental.session.contentSearchStatus({}).then((response) => {
      const value = response.data
      if (!value) return
      setStatus({
        indexed: Number.isFinite(Number(value.indexed)) ? Number(value.indexed) : 0,
        total: Number.isFinite(Number(value.total)) ? Number(value.total) : 0,
        enabled: value.enabled,
        state: value.state,
        complete: value.complete,
        known: value.known,
      })
    })

  const pollIndex = () => {
    void refreshIndex()
      .catch(() => undefined)
      .finally(() => {
        if (disposed) return
        pollTimer = setTimeout(pollIndex, index()?.state === "running" ? 1_000 : 10_000)
      })
  }

  const search = (text: string) => {
    const query = text.trim()
    token += 1
    const current = token
    if (timer) clearTimeout(timer)
    if (!query) {
      setResults([])
      setLoading(false)
      setError()
      return Promise.resolve([] as Entry[])
    }
    setLoading(true)
    setError()
    return new Promise<Entry[]>((resolve) => {
      timer = setTimeout(() => {
        void props.globalSDK.client.experimental.session
          .contentSearch({ q: query, limit: "20" })
          .then((response) => {
            if (current !== token) return resolve([])
            const data = response.data
            setStatus(
              data?.index
                ? {
                    indexed: Number.isFinite(Number(data.index.indexed)) ? Number(data.index.indexed) : 0,
                    total: Number.isFinite(Number(data.index.total)) ? Number(data.index.total) : 0,
                    enabled: data.index.enabled,
                    state: data.index.state,
                    complete: data.index.complete,
                    known: data.index.known,
                  }
                : undefined,
            )
            const next = (data?.results ?? []).map((item) => ({
              id: `content:${item.directory}:${item.partID}`,
              type: "content" as const,
              title: item.sessionTitle || props.language.t("command.session.new"),
              description: `${item.directory} · ${item.snippet}`,
              category: data?.index.complete ? "Content matches" : "Content matches (indexing)",
              directory: item.directory,
              sessionID: item.sessionID,
              updated: typeof item.time === "number" ? item.time : undefined,
            }))
            setResults(next)
            resolve(next)
          })
          .catch(() => {
            if (current === token) setError("Unable to search session content")
            resolve([])
          })
          .finally(() => {
            if (current === token) setLoading(false)
          })
      }, 180)
    })
  }
  pollIndex()
  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    if (pollTimer) clearTimeout(pollTimer)
  })
  return { results, loading, error, index, search }
}

export function DialogSelectFile(props: { mode?: DialogSelectFileMode; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const file = useFile()
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const { params, tabs, view } = useSessionLayout()
  const filesOnly = () => props.mode === "files"
  const commandsOnly = () => props.mode === "commands"
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const [grouped, setGrouped] = createSignal(false)
  const commandEntries = createCommandEntries({ filesOnly, commandsOnly, command, language })
  const fileEntries = createFileEntries({ file, tabs, language })

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return undefined
    return projectOwner(directory, layout.projects.list())?.project
  })
  const workspaces = createMemo(() => {
    const directory = projectDirectory()
    const current = project()
    if (!current) return directory ? [directory] : []

    const dirs = [current.worktree, ...(current.sandboxes ?? [])]
    if (directory && !dirs.includes(directory)) return [...dirs, directory]
    return dirs
  })
  const homedir = createMemo(() => globalSync.data.path.home)
  const label = (directory: string) => {
    const current = project()
    const kind =
      current && directory === current.worktree
        ? language.t("workspace.type.local")
        : language.t("workspace.type.sandbox")
    const [store] = globalSync.child(directory, { bootstrap: false })
    const home = homedir()
    const path = home ? directory.replace(home, "~") : directory
    const name = store.vcs?.branch ?? getFilename(directory)
    return `${kind} : ${name || path}`
  }

  const { sessions } = createSessionEntries({ workspaces, label, globalSDK, language })
  const contentSearch = createContentSearchEntries({ globalSDK, language })

  const items = async (text: string) => {
    const query = text.trim()
    setGrouped(query.length > 0)

    if (commandsOnly()) {
      if (!query) return commandEntries.picks()
      return commandEntries.list()
    }

    if (!query && filesOnly()) {
      const loaded = file.tree.state("")?.loaded
      const pending = loaded ? Promise.resolve() : file.tree.list("")
      const next = uniqueEntries([...fileEntries.recent(), ...fileEntries.root()])

      if (loaded || next.length > 0) {
        void pending
        return next
      }

      await pending
      return uniqueEntries([...fileEntries.recent(), ...fileEntries.root()])
    }

    if (!query) return [...commandEntries.picks(), ...fileEntries.recent()]

    if (filesOnly()) {
      const files = await file.searchFiles(query)
      const category = language.t("palette.group.files")
      return files.map((path) => createFileEntry(path, category))
    }

    const [files, nextSessions, content] = await Promise.all([
      file.searchFiles(query),
      Promise.resolve(sessions(query)),
      contentSearch.search(query),
    ])
    const category = language.t("palette.group.files")
    const entries = files.map((path) => createFileEntry(path, category))
    return [...content, ...commandEntries.list(), ...nextSessions, ...entries]
  }

  const handleMove = (item: Entry | undefined) => {
    state.cleanup?.()
    if (!item) return
    if (item.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const open = (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(value)

    requestAnimationFrame(() => {
      void file.load(path)
    })
  }

  const handleSelect = (item: Entry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()

    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }

    if (item.type === "session" || item.type === "content") {
      if (!item.directory || !item.sessionID) return
      navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
      return
    }

    if (!item.path) return
    open(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <Dialog class="pt-4 !max-h-[480px]" transition>
      <List
        search={{
          placeholder: commandsOnly()
            ? language.t("palette.search.commands")
            : filesOnly()
              ? language.t("session.header.searchFiles")
              : language.t("palette.search.placeholder"),
          autofocus: true,
          hideIcon: true,
        }}
        emptyMessage={language.t("palette.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "description", "category", "keywords"]}
        groupBy={grouped() ? (item) => item.category : () => ""}
        onMove={handleMove}
        onSelect={handleSelect}
      >
        {(item) => (
          <Switch
            fallback={
              <div class="w-full flex items-center justify-between rounded-md pl-1">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.path ?? "", type: "file" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular">
                    <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                      {getDirectory(item.path ?? "")}
                    </span>
                    <span class="text-text-strong whitespace-nowrap">{getFilename(item.path ?? "")}</span>
                  </div>
                </div>
              </div>
            }
          >
            <Match when={item.type === "command"}>
              <div class="w-full flex items-center justify-between gap-4">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-14-regular text-text-strong whitespace-nowrap">{item.title}</span>
                  <Show when={item.description}>
                    <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                  </Show>
                </div>
                <Show when={item.keybind}>
                  <Keybind class="rounded-[4px]">{formatKeybind(item.keybind ?? "", language.t)}</Keybind>
                </Show>
              </div>
            </Match>
            <Match when={item.type === "session" || item.type === "content"}>
              <div class="w-full flex items-center justify-between rounded-md pl-1">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak" />
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="text-14-regular text-text-strong truncate"
                      classList={{ "opacity-70": !!item.archived }}
                    >
                      {item.title}
                    </span>
                    <Show when={item.description}>
                      <span
                        class="text-14-regular text-text-weak truncate"
                        classList={{ "opacity-70": !!item.archived }}
                      >
                        {item.description}
                      </span>
                    </Show>
                  </div>
                </div>
                <Show when={item.updated}>
                  <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                    {getRelativeTime(new Date(item.updated!).toISOString(), language.t)}
                  </span>
                </Show>
              </div>
            </Match>
          </Switch>
        )}
      </List>
    </Dialog>
  )
}

export function DialogSessionContentSearch() {
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const contentSearch = createContentSearchEntries({ globalSDK, language })
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let viewport: HTMLDivElement | undefined
  const indexProgress = (): JSX.Element | undefined => {
    const index = contentSearch.index()
    if (!index?.enabled || !index.known) return
    if (index.complete)
      return (
        <div class="flex flex-col gap-1.5 px-3 py-2 text-12-regular text-text-weak">
          <span>Index ready. {index.indexed.toLocaleString()} messages indexed.</span>
          <Progress value={1} maxValue={1} hideLabel>
            Index complete
          </Progress>
        </div>
      )
    if (index.total === 0)
      return (
        <div class="flex flex-col gap-1.5 px-3 py-2 text-12-regular text-text-weak">
          <span>Preparing index</span>
          <Progress hideLabel>Preparing index</Progress>
        </div>
      )
    const indexed = Math.min(index.indexed, index.total)
    const percent = Math.floor((indexed / index.total) * 100)
    return (
      <div class="flex flex-col gap-1.5 px-3 py-2 text-12-regular text-text-weak">
        <span>
          {indexed.toLocaleString()} / {index.total.toLocaleString()} messages indexed ({percent}%)
        </span>
        <Progress value={indexed} maxValue={index.total} hideLabel>
          Index progress
        </Progress>
      </div>
    )
  }
  const indexDisabled = () => contentSearch.index()?.enabled === false

  createEffect(() => {
    const text = query()
    void contentSearch.search(text)
    setActive(0)
  })

  createEffect(() => {
    const item = contentSearch.results()[active()]
    if (!item || !viewport) return
    viewport.querySelector<HTMLElement>(`[data-key="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: "nearest" })
  })

  const handleSelect = (item: Entry | undefined) => {
    if (!item?.directory || !item.sessionID) return
    dialog.close()
    navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") return

    const results = contentSearch.results()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (results.length) setActive((index) => Math.min(index + 1, results.length - 1))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      if (results.length) setActive((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      handleSelect(results[active()])
    }
  }

  return (
    <Dialog class="pt-4 !max-h-[480px]" transition>
      <div data-component="list">
        <div data-slot="list-search-wrapper">
          <div data-slot="list-search">
            <div data-slot="list-search-container">
              <TextField
                autofocus
                variant="ghost"
                data-slot="list-search-input"
                type="text"
                value={query()}
                onChange={setQuery}
                onKeyDown={handleKeyDown}
                placeholder="Search session content"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
            </div>
          </div>
        </div>
        <div ref={viewport} data-slot="list-viewport">
          <Show when={indexProgress()}>{indexProgress()}</Show>
          <Show when={indexDisabled()}>
            <div data-slot="list-empty-state">
              <div data-slot="list-message">Enable the global index in Settings to search session content.</div>
            </div>
          </Show>
          <Show
            when={contentSearch.results().length > 0 && !indexDisabled()}
            fallback={
              <div data-slot="list-empty-state">
                <div data-slot="list-message">
                  <Show when={contentSearch.loading()} fallback={contentSearch.error() ?? language.t("palette.empty")}>
                    {language.t("common.loading")}
                  </Show>
                </div>
              </div>
            }
          >
            <For each={contentSearch.results()}>
              {(item, index) => (
                <button
                  data-slot="list-item"
                  data-key={item.id}
                  data-active={index() === active()}
                  type="button"
                  onClick={() => handleSelect(item)}
                  onMouseMove={(event) => {
                    if (event.movementX || event.movementY) setActive(index())
                  }}
                  onKeyDown={handleKeyDown}
                >
                  <div class="w-full flex items-center justify-between rounded-md pl-1">
                    <div class="flex items-center gap-x-3 grow min-w-0">
                      <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak" />
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-14-regular text-text-strong truncate">{item.title}</span>
                        <Show when={item.description}>
                          <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={item.updated}>
                      <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                        {getRelativeTime(new Date(item.updated!).toISOString(), language.t)}
                      </span>
                    </Show>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
