import type { RecentProjectTask } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useBeforeLeave, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { projectOwner } from "./layout/helpers"
import { NewProjectTaskDialog, ProjectTaskDetailDialog } from "./layout/project-tasks-panel"
import { filterManagedProjectTasks, type ProjectTaskFilter } from "./project-tasks-utils"

type TaskProject = { id: string; directory: string; label: string }

function CreateProjectTask(props: {
  projects: TaskProject[]
  initialID: string
  onCreated: (id: string, projectID: string) => void
}) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [state, setState] = createStore({ projectID: props.initialID })
  const project = createMemo(
    () => props.projects.find((project) => project.id === state.projectID) ?? props.projects[0],
  )
  return (
    <Show when={project()} keyed>
      {(project) => {
        const client = sdk.createClient({ directory: project.directory, throwOnError: true })
        return (
          <NewProjectTaskDialog
            directory={project.directory}
            projectPicker={
              <label class="flex flex-col gap-2">
                <span class="text-12-medium text-text-base">{language.t("scheduled.project")}</span>
                <Select
                  options={props.projects}
                  current={project}
                  value={(item) => item.id}
                  label={(item) => item.label}
                  onSelect={(item) => {
                    if (item) setState("projectID", item.id)
                  }}
                  class="w-full"
                />
              </label>
            }
            searchFilesAndDirectories={async (query) => (await client.find.files({ query, dirs: "true" })).data ?? []}
            onCreate={async (title, description) => {
              console.debug(`[project-task-manager] create-start project=${project.id}`)
              const result = await client.projectTask.create({ projectTaskCreateInput: { title, description } })
              if (result.data) props.onCreated(result.data.id, project.id)
              console.debug(`[project-task-manager] create-end task=${result.data?.id}`)
            }}
          />
        )
      }}
    </Show>
  )
}

export default function ProjectTasks() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const [state, setState] = createStore({
    tasks: [] as RecentProjectTask[],
    loading: true,
    error: "",
    selectedID: new URLSearchParams(location.search).get("task") ?? "",
    projectID: "all",
    status: "active" as ProjectTaskFilter,
    query: "",
    sort: "recent" as "recent" | "created",
    switching: false,
    revision: 0,
  })
  const routeDirectory = createMemo(() => decode64(params.dir) ?? "")
  const projects = createMemo((): TaskProject[] =>
    sync.data.project
      .filter((project) => project.worktree)
      .map((project) => ({
        id: project.id,
        directory: project.worktree,
        label: project.name || getFilename(project.worktree) || project.worktree,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  )
  const projectID = createMemo(() => projectOwner(routeDirectory(), sync.data.project)?.project.id ?? state.projectID)
  const projectOptions = createMemo(() => [{ id: "all", label: language.t("scheduled.filter.all") }, ...projects()])
  const statusOptions = createMemo<Array<{ id: ProjectTaskFilter; label: string }>>(() => [
    { id: "active", label: language.t("projectTask.filter.unarchived") },
    { id: "all", label: language.t("projectTask.filter.allStatuses") },
    { id: "open", label: language.t("projectTask.status.open") },
    { id: "in_progress", label: language.t("projectTask.status.inProgress") },
    { id: "done", label: language.t("projectTask.status.done") },
    { id: "archived", label: language.t("projectTask.status.archived") },
  ])
  const filtered = createMemo(() =>
    filterManagedProjectTasks(state.tasks, {
      projectID: projectID(),
      status: state.status,
      query: state.query,
      sort: state.sort,
    }),
  )
  const selected = createMemo(() => state.tasks.find((task) => task.id === state.selectedID))
  let request = 0
  let guard: (() => Promise<boolean>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load(reset = false) {
    const generation = ++request
    if (reset) setState({ tasks: [], selectedID: "", loading: true })
    setState("error", "")
    console.debug(`[project-task-manager] list-start request=${generation} reset=${reset}`)
    try {
      const result = await sdk.client.experimental.projectTasks({ includeArchived: "true" })
      if (generation !== request) return
      setState("tasks", reconcile(result.data ?? [], { key: "id" }))
      setState("revision", (value) => value + 1)
      console.debug(`[project-task-manager] list-end request=${generation} count=${result.data?.length ?? 0}`)
    } catch (error) {
      if (generation !== request) return
      console.error(`[project-task-manager] list-failed request=${generation}`, error)
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === request) setState("loading", false)
    }
  }

  async function select(id: string) {
    if (state.switching || id === state.selectedID) return
    setState("switching", true)
    try {
      if (guard && !(await guard())) return
      console.debug(`[project-task-manager] select task=${id}`)
      setState("selectedID", id)
    } finally {
      setState("switching", false)
    }
  }

  async function createTask() {
    if (guard && !(await guard())) return
    dialog.show(() => (
      <CreateProjectTask
        projects={routeDirectory() ? projects().filter((project) => project.id === projectID()) : projects()}
        initialID={projectID() === "all" ? (selected()?.projectID ?? "") : projectID()}
        onCreated={(id, projectID) => {
          setState({ selectedID: id, projectID, status: "active", query: "" })
          void load()
        }}
      />
    ))
  }

  useBeforeLeave((event) => {
    if (event.defaultPrevented || !guard) return
    event.preventDefault()
    void guard().then((saved) => {
      if (saved) event.retry(true)
    })
  })
  createEffect(
    on(
      () => [server.domain, sdk.version] as const,
      (_, previous) => {
        void load(!!previous)
      },
    ),
  )
  const stop = sdk.listenAll((event) => {
    if (event.domain !== server.domain) return
    if (
      !event.details.type.startsWith("project-task.") &&
      !["session.updated", "session.deleted", "todo.updated"].includes(event.details.type)
    )
      return
    if (timer) return
    console.debug(`[project-task-manager] event=${event.details.type} action=refresh`)
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, 250)
  })
  onCleanup(() => {
    request++
    if (timer) clearTimeout(timer)
    stop()
  })

  return (
    <div
      data-component="project-task-manager"
      class="flex size-full min-h-0 flex-col overflow-hidden bg-background-base"
    >
      <header class="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-weak-base px-4 sm:px-5">
        <div class="flex min-w-0 items-center gap-3">
          <Button
            icon="arrow-left"
            variant="ghost"
            onClick={() => navigate(routeDirectory() ? `/${base64Encode(routeDirectory())}` : "/")}
          >
            {language.t("command.session.back")}
          </Button>
          <h1 class="truncate text-18-medium text-text-strong">{language.t("projectTask.title")}</h1>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <IconButton
            icon="refresh"
            aria-label={language.t("projectTask.refresh")}
            onClick={() => void load()}
            disabled={state.loading}
          />
          <Button icon="plus" variant="primary" onClick={() => void createTask()} disabled={!projects().length}>
            {language.t("projectTask.create")}
          </Button>
        </div>
      </header>
      <Show when={state.error}>
        <div
          role="alert"
          class="flex shrink-0 items-center justify-between gap-3 border-b border-border-weak-base px-4 py-2 text-12-regular text-text-danger"
        >
          <span>{state.error}</span>
          <Button size="small" variant="ghost" onClick={() => void load()}>
            {language.t("common.refresh")}
          </Button>
        </div>
      </Show>
      <div class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(180px,38%)_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-1">
        <aside class="flex min-h-0 flex-col border-b border-border-weak-base lg:border-r lg:border-b-0">
          <div class="flex shrink-0 flex-col gap-2 border-b border-border-weak-base p-3">
            <Show when={!routeDirectory()}>
              <Select
                options={projectOptions()}
                current={projectOptions().find((item) => item.id === state.projectID)}
                value={(item) => item.id}
                label={(item) => item.label}
                triggerProps={{ "aria-label": language.t("scheduled.project") }}
                onSelect={(item) => setState("projectID", item?.id ?? "all")}
                class="w-full"
              />
            </Show>
            <Select
              options={statusOptions()}
              current={statusOptions().find((item) => item.id === state.status)}
              value={(item) => item.id}
              label={(item) => item.label}
              triggerProps={{ "aria-label": language.t("projectTask.field.status") }}
              onSelect={(item) => setState("status", item?.id ?? "active")}
              class="w-full"
            />
            <TextField
              value={state.query}
              onChange={(query) => setState("query", query)}
              placeholder={language.t("projectTask.search.placeholder")}
              aria-label={language.t("projectTask.search.placeholder")}
            />
            <Button
              size="small"
              variant="ghost"
              onClick={() => setState("sort", state.sort === "recent" ? "created" : "recent")}
            >
              {language.t(state.sort === "recent" ? "projectTask.sort.recent" : "task.sort.created")} ·{" "}
              {filtered().length}
            </Button>
          </div>
          <div data-component="project-task-manager-list" class="min-h-0 flex-1 overflow-y-auto p-2">
            <Show
              when={!state.loading}
              fallback={
                <div class="flex justify-center p-8">
                  <Spinner />
                </div>
              }
            >
              <Show
                when={filtered().length}
                fallback={
                  <div class="p-6 text-center text-13-regular text-text-weak">{language.t("task.search.empty")}</div>
                }
              >
                <For each={filtered()}>
                  {(task) => (
                    <button
                      type="button"
                      data-task-id={task.id}
                      aria-pressed={task.id === state.selectedID}
                      disabled={state.switching}
                      class="mb-1 flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left hover:bg-surface-base-hover"
                      classList={{ "bg-surface-base-active": task.id === state.selectedID }}
                      onClick={() => void select(task.id)}
                    >
                      <span class="w-full truncate text-14-medium text-text-strong">{task.title}</span>
                      <span class="w-full truncate text-11-regular text-text-weak" title={task.directory}>
                        {task.projectName || getFilename(task.directory)}
                      </span>
                      <span class="flex w-full justify-between gap-2 text-11-regular text-text-weaker">
                        <span>
                          {statusOptions().find((status) => status.id === task.status)?.label} ·{" "}
                          {task.progress.completed}/{task.progress.total}
                        </span>
                        <span>{language.t("projectTask.sessions.count", { count: task.sessionCount })}</span>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </aside>
        <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <Show
            when={selected()?.id}
            keyed
            fallback={
              <div class="flex h-full items-center justify-center p-8 text-13-regular text-text-weak">
                {language.t("projectTask.select")}
              </div>
            }
          >
            {(id) => {
              const task = untrack(() => state.tasks.find((task) => task.id === id))!
              return (
                <ProjectTaskDetailDialog
                  embedded
                  task={task}
                  directory={task.directory}
                  projectName={task.projectName || getFilename(task.directory)}
                  client={sdk.createClient({ directory: task.directory, throwOnError: true })}
                  refreshToken={state.revision}
                  onBeforeLeave={(next) => {
                    guard = next
                  }}
                  onClose={() => setState("selectedID", "")}
                  onChanged={() => load()}
                />
              )
            }}
          </Show>
        </main>
      </div>
    </div>
  )
}
