import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { getFilename } from "@opencode-ai/core/util/path"
import { DateTime } from "luxon"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { useLayout, getAvatarColors, type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { enabledExtraAgents } from "@/pages/layout/extra-agents"

type ProjectItem = {
  kind: "project"
  id: string
  name: string
  path: string
  isCurrent: boolean
  project: LocalProject
}

type ExtraAgentItem = {
  kind: "extra-agent"
  id: string
  name: string
  path: string
  isCurrent: boolean
  icon?: IconName
}

type ProjectEntry = ProjectItem | ExtraAgentItem
type Pane = "projects" | "sessions"

/**
 * Two-pane switcher (⌘T): projects on the left, every recent session on the
 * right. DOM focus never leaves the search field — arrows are forwarded to the
 * active pane's list, ←/→ swap panes and Tab opens a new session in the
 * highlighted project.
 */
export function DialogSwitchProject(props: {
  onSelect: (directory: string) => void
  onSelectNewSession?: (directory: string) => void
  current: Accessor<string | undefined>
  /** Recent sessions across every project (right pane). */
  loadSessions?: () => Promise<GlobalSession[]>
  currentSessionID?: Accessor<string | undefined>
  onSelectSession?: (session: GlobalSession) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const layout = useLayout()
  const server = useServer()

  const enabledAgents = createMemo(() => enabledExtraAgents(server.list))

  // Keyboard-highlighted project; drives the Tab hint and the Tab action.
  const [activeEntry, setActiveEntry] = createSignal<ProjectEntry | undefined>()
  const [pane, setPane] = createSignal<Pane>("projects")
  const [query, setQuery] = createSignal("")

  let inputRef: HTMLInputElement | undefined
  let projectsRef: ListRef | undefined
  let sessionsRef: ListRef | undefined

  const sessionsEnabled = () => !!props.loadSessions && !!props.onSelectSession
  // One request per dialog: filtering must not refetch the list.
  let sessionsPromise: Promise<GlobalSession[]> | undefined
  const loadSessions = () => (sessionsPromise ??= props.loadSessions?.() ?? Promise.resolve([]))

  const entries = createMemo((): ProjectEntry[] => {
    const projects = layout.projects.rail()
    const current = props.current()

    const result: ProjectEntry[] = projects.map((project) => ({
      kind: "project",
      id: project.worktree,
      name: project.name || getFilename(project.worktree),
      path: project.worktree,
      isCurrent: project.worktree === current,
      project,
    }))

    for (const agent of enabledAgents().toReversed()) {
      result.unshift({
        kind: "extra-agent",
        id: agent.directory,
        name: agent.label,
        path: agent.directory,
        isCurrent: current === agent.directory,
        icon: agent.icon,
      })
    }

    return result
  })

  const handleSelect = (entry: ProjectEntry | undefined) => {
    if (!entry) return
    dialog.close()
    props.onSelect(entry.id)
  }

  const handleSelectSession = (session: GlobalSession | undefined) => {
    if (!session) return
    dialog.close()
    props.onSelectSession?.(session)
  }

  // Tab on the highlighted entry jumps straight into that project's new-session view.
  const openNewSession = (entry: ProjectEntry | undefined) => {
    if (!entry) return
    dialog.close()
    if (props.onSelectNewSession) {
      props.onSelectNewSession(entry.id)
      return
    }
    props.onSelect(entry.id)
  }

  const handleKeyEvent = (event: KeyboardEvent, entry: ProjectEntry | undefined) => {
    if (!entry) return
    if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    openNewSession(entry)
  }

  const activeList = () => (pane() === "projects" ? projectsRef : sessionsRef)

  /**
   * ←/→ stay usable for text editing, so a pane only switches when the caret
   * sits on the matching edge of the query — always true for an empty box,
   * which is the common case.
   */
  const canSwitchPane = (key: "ArrowLeft" | "ArrowRight") => {
    const input = inputRef
    if (!input) return true
    if (input.value.length === 0) return true
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? 0
    if (start !== end) return false
    return key === "ArrowLeft" ? start === 0 : end === input.value.length
  }

  const handleSearchKey = (event: KeyboardEvent) => {
    if (event.isComposing) return

    if (event.key === "Tab") {
      event.preventDefault()
      openNewSession(activeEntry())
      return
    }

    // Modifier combos belong to the input (word jump, select all) or to the
    // app's own keybinds; never swallow them here.
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!canSwitchPane(event.key)) return
      const next: Pane = pane() === "projects" ? "sessions" : "projects"
      // The sessions pane only exists when the caller supplies a loader.
      if (next === "sessions" && !sessionsEnabled()) return
      event.preventDefault()
      setPane(next)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter") {
      // Forward first: List.onKeyDown bails out on defaultPrevented events.
      activeList()?.onKeyDown(event)
      event.preventDefault()
    }
  }

  const focusSearch = () => queueMicrotask(() => inputRef?.focus())

  return (
    <Dialog size="x-large" containerStyle={{ height: "min(calc(100vh - 32px), 720px)" }}>
      <div data-component="session-switch" class="flex w-full flex-col gap-3 p-3">
        {/* Reuses the List search markup so the field matches every other
            switcher; the input keeps DOM focus for the whole session. */}
        <div data-component="list" class="!p-0">
          <div data-slot="list-search-wrapper" class="!mb-0">
            <div
              data-slot="list-search"
              onPointerDown={(event) => {
                event.currentTarget.querySelector("input")?.focus()
                event.stopPropagation()
              }}
            >
              <div data-slot="list-search-container">
                <Icon name="magnifying-glass" />
                <TextField
                  autofocus
                  variant="ghost"
                  type="text"
                  ref={(el: HTMLInputElement | HTMLTextAreaElement) => {
                    inputRef = el as HTMLInputElement
                  }}
                  value={query()}
                  onChange={setQuery}
                  onKeyDown={handleSearchKey}
                  placeholder={language.t("project.switch.placeholder")}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                />
              </div>
              <Show when={query()}>
                <IconButton
                  icon="circle-x"
                  variant="ghost"
                  aria-label={language.t("project.switch.clear")}
                  onClick={() => {
                    setQuery("")
                    focusSearch()
                  }}
                />
              </Show>
            </div>
          </div>
        </div>

        <div class="flex min-h-0 gap-3" style={{ height: "min(520px, calc(100vh - 180px))" }}>
          <section
            data-pane="projects"
            data-pane-active={pane() === "projects" ? "true" : "false"}
            class="flex w-[300px] shrink-0 flex-col gap-1.5 min-h-0 transition-opacity"
            classList={{ "opacity-55": pane() !== "projects" }}
            onPointerEnter={() => setPane("projects")}
          >
            <div
              class="px-2 text-11-medium uppercase tracking-[0.08em]"
              classList={{ "text-text-strong": pane() === "projects", "text-text-weak": pane() !== "projects" }}
            >
              {language.t("project.switch.projects")}
            </div>
            <List<ProjectEntry>
              ref={(ref) => {
                projectsRef = ref
              }}
              search={false}
              class="min-h-0 flex-1"
              style={{ padding: 0 }}
              items={entries}
              key={(item) => item.id}
              filter={query()}
              filterKeys={["name", "path"]}
              emptyMessage={query() ? undefined : language.t("project.switch.empty")}
              onSelect={handleSelect}
              onKeyEvent={handleKeyEvent}
              onMove={(item) => setActiveEntry(item)}
            >
              {(item) => (
                <div class="w-full flex items-center justify-between rounded-md pl-1">
                  <div class="flex items-center grow min-w-0">
                    <Show
                      when={item.kind === "project" && item}
                      fallback={
                        <div class="size-6 rounded shrink-0 flex items-center justify-center bg-surface-base">
                          <Icon
                            name={item.kind === "extra-agent" ? (item.icon ?? "robot") : "robot"}
                            class="text-icon-base size-4"
                          />
                        </div>
                      }
                    >
                      {(entry) => (
                        <Avatar
                          fallback={item.name}
                          src={entry().project.icon?.override}
                          {...getAvatarColors(entry().project.icon?.color)}
                          class="size-6 rounded shrink-0"
                        />
                      )}
                    </Show>
                    <span class="text-14-medium text-text-base truncate pl-3">{item.name}</span>
                    <Show when={item.isCurrent}>
                      <Icon name="check" size="small" class="text-icon-success-base shrink-0 ml-2" />
                    </Show>
                  </div>
                  <Show when={pane() === "projects" && item.id === activeEntry()?.id}>
                    <span class="text-11-regular text-text-weak shrink-0 ml-2" data-slot="project-switch-tab-hint">
                      {language.t("project.switch.tabHint")}
                    </span>
                  </Show>
                </div>
              )}
            </List>
          </section>

          <Show when={sessionsEnabled()}>
            <section
              data-pane="sessions"
              data-pane-active={pane() === "sessions" ? "true" : "false"}
              class="flex min-w-0 flex-1 flex-col gap-1.5 min-h-0 border-l border-border-weak-base pl-3 transition-opacity"
              classList={{ "opacity-55": pane() !== "sessions" }}
              onPointerEnter={() => setPane("sessions")}
            >
              <div
                class="px-2 text-11-medium uppercase tracking-[0.08em]"
                classList={{ "text-text-strong": pane() === "sessions", "text-text-weak": pane() !== "sessions" }}
              >
                {language.t("project.switch.recentSessions")}
              </div>
              <List<GlobalSession>
                ref={(ref) => {
                  sessionsRef = ref
                }}
                search={false}
                class="min-h-0 flex-1"
                style={{ padding: 0 }}
                items={loadSessions}
                key={(item) => item.id}
                filter={query()}
                filterKeys={["title", "directory"]}
                emptyMessage={query() ? undefined : language.t("project.switch.sessionsEmpty")}
                loadingMessage={language.t("common.loading")}
                onSelect={handleSelectSession}
              >
                {(item) => (
                  <div class="w-full flex items-center justify-between rounded-md pl-1">
                    <div class="flex items-center grow min-w-0">
                      <Icon name="speech-bubble" size="small" class="shrink-0 text-icon-weak" />
                      <span class="text-14-medium text-text-base truncate grow min-w-0 pl-3">
                        {item.title?.trim() || item.id.slice(0, 8)}
                      </span>
                      <span class="text-11-regular text-text-weak truncate shrink-0 max-w-[9rem] text-left pl-3">
                        {workspaceName(item)}
                      </span>
                      <span class="text-11-regular text-text-weak shrink-0 whitespace-nowrap pl-2">
                        {updatedLabel(item)}
                      </span>
                      <Show when={props.currentSessionID?.() === item.id}>
                        <span class="text-11-regular text-text-weak shrink-0 ml-2">
                          {language.t("project.switch.current")}
                        </span>
                      </Show>
                    </div>
                  </div>
                )}
              </List>
            </section>
          </Show>
        </div>

        <div class="flex flex-wrap items-center gap-3 px-2 text-11-regular text-text-weak">
          <Hint keys="↑↓" label={language.t("project.switch.hint.move")} />
          <Show when={sessionsEnabled()}>
            <Hint keys="←→" label={language.t("project.switch.hint.pane")} />
          </Show>
          <Hint keys="Tab" label={language.t("project.switch.hint.newSession")} />
          <Hint keys="↵" label={language.t("project.switch.hint.open")} />
        </div>
      </div>
    </Dialog>
  )

  function workspaceName(session: GlobalSession) {
    return (
      session.project?.name || getFilename(session.project?.worktree ?? session.directory) || session.directory || ""
    )
  }

  function updatedLabel(session: GlobalSession) {
    return DateTime.fromMillis(session.time.updated ?? session.time.created)
      .setLocale(language.intl())
      .toRelative()
  }
}

function Hint(props: { keys: string; label: string }) {
  return (
    <span class="inline-flex items-center gap-1">
      <kbd class="rounded border border-border-weak-base bg-surface-base px-1 text-11-medium text-text-weak">
        {props.keys}
      </kbd>
      {props.label}
    </span>
  )
}
