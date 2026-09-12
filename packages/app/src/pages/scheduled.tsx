import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useModels } from "@/context/models"
import { decode64 } from "@/utils/base64"
import { CronExpressionField } from "@/components/cron-expression-field"
import { TimezoneSelectField } from "@/components/timezone-select-field"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { projectOwner, workspaceKey } from "@/pages/layout/helpers"
import { filterActiveProjects, filterTasksForActiveProjects } from "@/pages/scheduled-utils"

type ScheduleKind = ScheduledTaskSchedule["kind"]
type ExecutionMode = ScheduledTask["executionMode"]

function executionModeKey(mode: ExecutionMode) {
  if (mode === "automatic_session") return "scheduled.execution.automatic" as const
  if (mode === "new_session") return "scheduled.execution.new" as const
  return "scheduled.execution.existing" as const
}

type ModelOption = {
  key: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  variants?: Record<string, Record<string, unknown>>
}

const formatDate = (value?: number) => (value ? new Date(value).toLocaleString() : "-")

function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (schedule.kind === "at") return formatDate(schedule.at)
  if (schedule.kind === "every") {
    return t("scheduled.schedule.every.interval", { count: Math.round(schedule.interval / 60_000) })
  }
  return `${schedule.expression}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`
}

function FieldLabel(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span class="shrink-0 text-12-medium text-text-weak">{props.label}</span>
      <div class="ml-auto max-w-full">{props.children}</div>
    </label>
  )
}

function statusTone(status?: ScheduledTask["lastStatus"] | ScheduledTaskRun["status"]) {
  if (status === "ok") return "text-text-success"
  if (status === "error") return "text-text-danger"
  if (status === "running" || status === "retrying") return "text-text-interactive-base"
  return "text-text-weak"
}

export default function Scheduled() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const layout = useLayout()
  const models = useModels()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  let routeIntentHandled = false
  let listRequest = 0
  const [state, setState] = createStore({
    tasks: [] as ScheduledTask[],
    runs: [] as ScheduledTaskRun[],
    runsTaskID: undefined as string | undefined,
    selectedID: undefined as string | undefined,
    projectID: "all",
    loading: true,
    runsLoading: false,
    saving: false,
    error: "",
    formOpen: false,
    editing: false,
    name: "",
    prompt: "",
    directory: "",
    projectIDForm: "",
    projectName: "",
    agent: "build",
    providerID: "",
    modelID: "",
    variant: "",
    executionMode: "automatic_session" as ExecutionMode,
    sessionID: "",
    scheduleKind: "every" as ScheduleKind,
    at: "",
    intervalMinutes: "60",
    cron: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    unattended: false,
    baseline: "",
  })

  const projects = createMemo(() =>
    filterActiveProjects(
      sync.data.project.filter((project) => project.worktree),
      layout.projects.list(),
    )
      .slice()
      .sort((a, b) => (a.name || a.worktree).localeCompare(b.name || b.worktree)),
  )
  const activeProjectIDs = createMemo(() => new Set(projects().map((project) => project.id)))
  const routeDirectory = createMemo(() => decode64(params.dir) ?? "")
  const routeProject = createMemo(() => projectOwner(routeDirectory(), projects())?.project)

  const agentOptions = createMemo(() => {
    const dir = state.directory || routeDirectory()
    const names = (dir ? sync.child(dir)[0].agent : [])
      .filter((item) => item.mode !== "subagent" && !item.hidden)
      .map((item) => item.name)
    if (state.agent && !names.includes(state.agent)) names.unshift(state.agent)
    return names.length > 0 ? names : state.agent ? [state.agent] : ["build"]
  })

  const modelOptions = createMemo((): ModelOption[] => {
    const list: ModelOption[] = models
      .list()
      .filter((item) => models.visible({ modelID: item.id, providerID: item.provider.id }))
      .map((item) => ({
        key: `${item.provider.id}/${item.id}`,
        providerID: item.provider.id,
        modelID: item.id,
        name: item.name,
        providerName: item.provider.name,
        variants: item.variants,
      }))

    if (state.providerID && state.modelID) {
      const key = `${state.providerID}/${state.modelID}`
      if (!list.some((item) => item.key === key)) {
        const found = models.find({ providerID: state.providerID, modelID: state.modelID })
        list.unshift({
          key,
          providerID: state.providerID,
          modelID: state.modelID,
          name: found?.name ?? state.modelID,
          providerName: found?.provider.name ?? state.providerID,
          variants: found?.variants,
        })
      }
    }
    return list
  })

  const currentModel = createMemo(() =>
    modelOptions().find((item) => item.providerID === state.providerID && item.modelID === state.modelID),
  )

  const variantOptions = createMemo(() => {
    const keys = currentModel()?.variants ? Object.keys(currentModel()!.variants!) : []
    return ["default", ...keys]
  })

  createEffect(() => {
    if (!state.formOpen) return
    if (state.providerID && state.modelID) return
    const recent = models.recent.list()[0]
    if (recent) {
      setState({ providerID: recent.providerID, modelID: recent.modelID })
      return
    }
    const first = modelOptions()[0]
    if (first) setState({ providerID: first.providerID, modelID: first.modelID })
  })

  createEffect(() => {
    if (!state.formOpen) return
    const agents = agentOptions()
    if (!agents.includes(state.agent) && agents[0]) setState("agent", agents[0])
  })
  const projectOptions = createMemo(() => [
    { id: "all", label: language.t("scheduled.filter.all") },
    ...projects().map((project) => ({ id: project.id, label: project.name || getFilename(project.worktree) })),
  ])
  createEffect(() => {
    if (state.projectID === "all" || activeProjectIDs().has(state.projectID)) return
    setState("projectID", "all")
  })
  const filtered = createMemo(() => {
    const directory = routeDirectory()
    const projectID = routeProject()?.id ?? state.projectID
    if (directory) return state.tasks
    const active = filterTasksForActiveProjects(state.tasks, projects())
    return projectID === "all" ? active : active.filter((task) => task.projectID === projectID)
  })
  const selected = createMemo(() => state.tasks.find((task) => task.id === state.selectedID))

  function formSnapshot() {
    return JSON.stringify([
      state.name,
      state.prompt,
      state.agent,
      state.providerID,
      state.modelID,
      state.variant,
      state.executionMode,
      state.sessionID,
      state.scheduleKind,
      state.at,
      state.intervalMinutes,
      state.cron,
      state.timezone,
      state.unattended,
    ])
  }
  const dirty = createMemo(() => formSnapshot() !== state.baseline)

  async function load(options?: { silent?: boolean }) {
    const current = ++listRequest
    if (!options?.silent) setState({ loading: true, error: "" })
    try {
      const directory = routeDirectory()
      const result = await sdk.client.scheduledTask.list(directory ? { directory } : undefined)
      if (current !== listRequest) return
      const tasks = result.data ?? []
      setState("tasks", tasks)
      if (state.selectedID && !tasks.some((task) => task.id === state.selectedID)) setState("selectedID", undefined)
      if (!routeIntentHandled) {
        routeIntentHandled = true
        const query = new URLSearchParams(location.search)
        const requested = tasks.find((task) => task.id === query.get("task"))
        if (requested && query.get("edit") === "true") resetForm(requested)
        else if (requested) selectTask(requested)
        else if (query.get("create") === "true") resetForm()
      }
    } catch (error) {
      if (current !== listRequest) return
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (current !== listRequest) return
      setState("loading", false)
    }
  }

  async function loadRuns(taskID: string) {
    setState({ runsLoading: true, runs: [], runsTaskID: taskID })
    try {
      const result = await sdk.client.scheduledTask.runs({ taskID, limit: "100" })
      if (state.selectedID === taskID) setState("runs", result.data ?? [])
    } finally {
      if (state.selectedID === taskID) setState("runsLoading", false)
    }
  }

  function selectTask(task: ScheduledTask) {
    resetForm(task)
    void loadRuns(task.id)
  }

  function resetForm(task?: ScheduledTask) {
    const project = task
      ? projects().find((item) => item.id === task.projectID)
      : (routeProject() ?? projects().find((item) => item.id === state.projectID) ?? projects()[0])
    setState({
      formOpen: true,
      editing: !!task,
      selectedID: task?.id,
      name: task?.name ?? "",
      prompt: task?.prompt ?? "",
      directory: task?.directory ?? project?.worktree ?? "",
      projectIDForm: task?.projectID ?? project?.id ?? "",
      projectName: task?.projectName ?? project?.name ?? (project ? getFilename(project.worktree) : ""),
      agent: task?.agent ?? "build",
      providerID: task?.model.providerID ?? "",
      modelID: task?.model.modelID ?? "",
      variant: task?.model.variant ?? "",
      executionMode: task?.executionMode ?? "automatic_session",
      sessionID: task?.sessionID ?? "",
      scheduleKind: task?.schedule.kind ?? "every",
      at: task?.schedule.kind === "at" ? new Date(task.schedule.at).toISOString().slice(0, 16) : "",
      intervalMinutes: task?.schedule.kind === "every" ? String(task.schedule.interval / 60_000) : "60",
      cron: task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * 1-5",
      timezone:
        task?.schedule.kind === "cron"
          ? (task.schedule.timezone ?? "")
          : Intl.DateTimeFormat().resolvedOptions().timeZone,
      unattended: !!task,
      error: "",
    })
    setState("baseline", formSnapshot())
  }

  function discardChanges() {
    const task = state.tasks.find((item) => item.id === state.selectedID)
    if (task) resetForm(task)
    else setState("formOpen", false)
  }

  function chooseProject(id: string) {
    const project = projects().find((item) => item.id === id)
    if (!project) return
    setState({
      projectIDForm: project.id,
      projectName: project.name || getFilename(project.worktree),
      directory: project.worktree,
    })
  }

  function schedule(): ScheduledTaskSchedule | undefined {
    if (state.scheduleKind === "at") {
      const at = new Date(state.at).getTime()
      if (!Number.isFinite(at)) return
      return { kind: "at", at }
    }
    if (state.scheduleKind === "every") {
      const interval = Number(state.intervalMinutes) * 60_000
      if (!Number.isSafeInteger(interval) || interval <= 0) return
      return { kind: "every", interval }
    }
    if (!state.cron.trim()) return
    return { kind: "cron", expression: state.cron.trim(), timezone: state.timezone.trim() || undefined }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const nextSchedule = schedule()
    if (
      !nextSchedule ||
      !state.name.trim() ||
      !state.prompt.trim() ||
      !state.projectIDForm ||
      !state.directory ||
      !state.providerID ||
      !state.modelID
    ) {
      setState("error", language.t("scheduled.error.required"))
      return
    }
    if (!state.unattended) {
      setState("error", language.t("scheduled.error.unattended"))
      return
    }

    setState({ saving: true, error: "" })
    const model = {
      providerID: state.providerID.trim(),
      modelID: state.modelID.trim(),
      variant: state.variant.trim() || undefined,
    }
    // Automatic and existing modes retain a stable source session; unrelated runs clear it.
    const sessionID = state.executionMode !== "new_session" ? state.sessionID.trim() || undefined : null
    try {
      if (state.editing && state.selectedID) {
        await sdk.client.scheduledTask.update({
          taskID: state.selectedID,
          scheduledTaskUpdateInput: {
            name: state.name.trim(),
            prompt: state.prompt.trim(),
            schedule: nextSchedule,
            executionMode: state.executionMode,
            sessionID,
            agent: state.agent.trim(),
            model,
          },
        })
      } else {
        const input: ScheduledTaskCreateInput = {
          projectID: state.projectIDForm,
          projectName: state.projectName || undefined,
          directory: state.directory,
          name: state.name.trim(),
          prompt: state.prompt.trim(),
          schedule: nextSchedule,
          executionMode: state.executionMode,
          sessionID: sessionID ?? undefined,
          agent: state.agent.trim(),
          model,
          enabled: true,
          unattended: true,
        }
        const result = await sdk.client.scheduledTask.create({ scheduledTaskCreateInput: input })
        setState("selectedID", result.data?.id)
      }
      setState({ formOpen: true, editing: true })
      await load()
      if (state.selectedID) await loadRuns(state.selectedID)
      const saved = state.tasks.find((item) => item.id === state.selectedID)
      if (saved) resetForm(saved)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("saving", false)
    }
  }

  async function toggle(task: ScheduledTask) {
    await sdk.client.scheduledTask.update({ taskID: task.id, scheduledTaskUpdateInput: { enabled: !task.enabled } })
    await load()
  }

  async function runNow(task: ScheduledTask) {
    await sdk.client.scheduledTask.runNow({ taskID: task.id })
    await loadRuns(task.id)
    await load()
  }

  async function remove(task: ScheduledTask) {
    if (!window.confirm(language.t("scheduled.delete.confirm", { name: task.name }))) return
    await sdk.client.scheduledTask.remove({ taskID: task.id })
    setState({ selectedID: undefined, formOpen: false })
    await load()
  }

  function goBack() {
    const directory = routeDirectory()
    navigate(directory ? `/${base64Encode(directory)}` : "/")
  }

  onMount(() => void load())
  createEffect(() => {
    const task = selected()
    if (task && state.runsTaskID !== task.id && !state.runsLoading) void loadRuns(task.id)
  })
  // listenAll: name=directory, details.type=event type (e.g. scheduled-task.created)
  const stop = sdk.listenAll((event) => {
    if (!event.details.type.startsWith("scheduled-task.")) return
    const directory = routeDirectory()
    if (directory && workspaceKey(event.name) !== workspaceKey(directory)) return
    void load({ silent: true })
    const id = state.selectedID
    if (id) void loadRuns(id)
  })
  onCleanup(stop)

  return (
    <div class="size-full overflow-hidden bg-background-base">
      <header class="flex h-14 items-center justify-between border-b border-border-weak-base px-5">
        <div class="flex min-w-0 items-center gap-3">
          <Button icon="arrow-left" variant="ghost" class="shrink-0" onClick={goBack}>
            {language.t("command.session.back")}
          </Button>
          <div class="min-w-0">
            <h1 class="truncate text-18-medium text-text-strong">{language.t("scheduled.title")}</h1>
          </div>
        </div>
        <Button icon="plus" variant="primary" onClick={() => resetForm()}>
          {language.t("scheduled.create")}
        </Button>
      </header>

      <div class="grid h-[calc(100%-3.5rem)] min-h-0 grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside class="flex min-h-0 flex-col border-b border-border-weak-base lg:border-r lg:border-b-0">
          <Show when={!routeDirectory()}>
            <div class="border-b border-border-weak-base p-3">
              <Select
                options={projectOptions()}
                current={projectOptions().find((item) => item.id === state.projectID)}
                value={(item) => item.id}
                label={(item) => item.label}
                onSelect={(item) => setState("projectID", item?.id ?? "all")}
                class="w-full"
              />
            </div>
          </Show>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <Show
              when={!state.loading}
              fallback={
                <div class="flex justify-center p-8">
                  <Spinner />
                </div>
              }
            >
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="p-6 text-center text-13-regular text-text-weak">{language.t("scheduled.empty")}</div>
                }
              >
                <For each={filtered()}>
                  {(task) => (
                    <button
                      type="button"
                      class="mb-1 flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left hover:bg-surface-base-hover"
                      classList={{ "bg-surface-base-active": state.selectedID === task.id && !state.formOpen }}
                      onClick={() => selectTask(task)}
                    >
                      <div class="flex w-full items-center gap-2">
                        <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{task.name}</span>
                      </div>
                      <div class="truncate text-11-regular text-text-weak">{task.projectName || task.directory}</div>
                      <div class="flex items-center justify-between gap-2 text-11-regular text-text-weaker">
                        <span class="truncate">{scheduleLabel(task.schedule, language.t)}</span>
                        <span class="shrink-0">
                          {task.lastRunAt
                            ? `${language.t("scheduled.lastRun")} ${formatDate(task.lastRunAt)}`
                            : task.enabled
                              ? `${language.t("scheduled.nextRun")} ${formatDate(task.nextRunAt)}`
                              : language.t("scheduled.disabled")}
                        </span>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </aside>

        <main class="flex min-h-0 flex-col overflow-hidden">
          <Show
            when={state.formOpen}
            fallback={
              <div class="flex h-full items-center justify-center p-8 text-13-regular text-text-weak">
                {language.t("scheduled.select")}
              </div>
            }
          >
            <form onSubmit={save} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden p-5 md:p-8">
              <div class="flex shrink-0 items-center justify-between gap-3 pb-4">
                <div class="min-w-0">
                  <h2 class="truncate text-20-medium text-text-strong">
                    {state.editing ? language.t("scheduled.edit") : language.t("scheduled.create")}
                  </h2>
                  <p class="mt-0.5 truncate text-12-regular text-text-weak">
                    {state.directory || language.t("scheduled.subtitle")}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Show when={state.editing && selected()}>
                    {(task) => (
                      <>
                        <Tooltip value={language.t("scheduled.runNow")}>
                          <IconButton icon="arrow-right" onClick={() => void runNow(task())} />
                        </Tooltip>
                        <Tooltip value={language.t("scheduled.delete")}>
                          <IconButton icon="trash" onClick={() => void remove(task())} />
                        </Tooltip>
                      </>
                    )}
                  </Show>
                  <Show when={!state.editing}>
                    <IconButton
                      icon="close"
                      variant="ghost"
                      onClick={() => setState("formOpen", false)}
                      aria-label={language.t("common.cancel")}
                    />
                  </Show>
                </div>
              </div>

              <div class="grid min-h-0 flex-1 gap-5 overflow-hidden lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
                <MarkdownEditorField
                  text={state.prompt}
                  preview
                  placeholder={language.t("scheduled.prompt.placeholder")}
                  onInput={(value) => setState("prompt", value)}
                  class="min-h-[320px] min-w-0 bg-background-base lg:min-h-0"
                />

                <div class="config-scrollbar flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-1">
                  <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
                    <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                      <Icon name="settings-gear" size="small" class="text-icon-base" />
                      {language.t("scheduled.section.basics")}
                    </div>
                    <div class="grid gap-4">
                      <TextField
                        label={language.t("scheduled.name")}
                        value={state.name}
                        onChange={(value) => setState("name", value)}
                      />
                      <Show when={!state.editing && !routeDirectory()}>
                        <FieldLabel label={language.t("scheduled.project")}>
                          <Select
                            options={projects()}
                            current={projects().find((item) => item.id === state.projectIDForm)}
                            value={(item) => item.id}
                            label={(item) => item.name || getFilename(item.worktree)}
                            onSelect={(item) => item && chooseProject(item.id)}
                            class="max-w-full"
                          />
                        </FieldLabel>
                      </Show>
                      <FieldLabel label={language.t("scheduled.agent")}>
                        <Select
                          options={agentOptions()}
                          current={state.agent}
                          onSelect={(item) => item && setState("agent", item)}
                          class="max-w-full"
                        />
                      </FieldLabel>
                      <FieldLabel label={language.t("scheduled.model")}>
                        <Select
                          options={modelOptions()}
                          current={currentModel()}
                          value={(item) => item.key}
                          label={(item) => `${item.providerName} / ${item.name}`}
                          groupBy={(item) => item.providerName}
                          onSelect={(item) => {
                            if (!item) return
                            const variants = item.variants ? Object.keys(item.variants) : []
                            setState({
                              providerID: item.providerID,
                              modelID: item.modelID,
                              variant: state.variant && variants.includes(state.variant) ? state.variant : "",
                            })
                          }}
                          class="max-w-full"
                        />
                      </FieldLabel>
                      <Show when={variantOptions().length > 1}>
                        <FieldLabel label={language.t("scheduled.variant")}>
                          <Select
                            options={variantOptions()}
                            current={state.variant || "default"}
                            label={(item) => (item === "default" ? language.t("common.default") : item)}
                            onSelect={(item) => item && setState("variant", item === "default" ? "" : item)}
                            class="max-w-full"
                          />
                        </FieldLabel>
                      </Show>
                      <Show when={state.editing && selected()}>
                        {(task) => (
                          <FieldLabel label={language.t("scheduled.enabled")}>
                            <Switch checked={task().enabled} onChange={() => void toggle(task())}>
                              {task().enabled ? language.t("scheduled.enabled") : language.t("scheduled.disabled")}
                            </Switch>
                          </FieldLabel>
                        )}
                      </Show>
                    </div>
                  </section>

                  <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
                    <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                      <Icon name="clock" size="small" class="text-icon-base" />
                      {language.t("scheduled.section.timing")}
                    </div>
                    <div class="grid gap-4">
                      <FieldLabel label={language.t("scheduled.execution")}>
                        <Select
                          options={["automatic_session", "existing_session", "new_session"] as const}
                          current={state.executionMode}
                          label={(item) => language.t(executionModeKey(item))}
                          onSelect={(item) => item && setState("executionMode", item)}
                          class="max-w-full"
                        />
                      </FieldLabel>
                      <FieldLabel label={language.t("scheduled.schedule")}>
                        <Select
                          options={["at", "every", "cron"] as const}
                          current={state.scheduleKind}
                          label={(item) => language.t(`scheduled.schedule.${item}`)}
                          onSelect={(item) => item && setState("scheduleKind", item)}
                          class="max-w-full"
                        />
                      </FieldLabel>
                      <Show when={state.scheduleKind === "at"}>
                        <TextField
                          type="datetime-local"
                          label={language.t("scheduled.schedule.at")}
                          value={state.at}
                          onChange={(value) => setState("at", value)}
                        />
                      </Show>
                      <Show when={state.scheduleKind === "every"}>
                        <TextField
                          type="number"
                          min="1"
                          label={language.t("scheduled.intervalMinutes")}
                          value={state.intervalMinutes}
                          onChange={(value) => setState("intervalMinutes", value)}
                        />
                      </Show>
                      <Show when={state.scheduleKind === "cron"}>
                        <CronExpressionField
                          label={language.t("scheduled.cron")}
                          meaningLabel={language.t("scheduled.cron.meaning")}
                          value={state.cron}
                          timezone={state.timezone}
                          locale={language.locale()}
                          onChange={(value) => setState("cron", value)}
                        />
                        <TimezoneSelectField
                          label={language.t("scheduled.timezone")}
                          value={state.timezone}
                          onChange={(value) => setState("timezone", value)}
                        />
                      </Show>
                    </div>
                  </section>

                  <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
                    <Checkbox
                      checked={state.unattended}
                      onChange={(value) => setState("unattended", value)}
                      description={language.t("scheduled.unattended.detail")}
                    >
                      {language.t("scheduled.unattended.accept")}
                    </Checkbox>
                  </section>

                  <Show when={state.error}>
                    <div class="rounded-lg border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong">
                      {state.error}
                    </div>
                  </Show>
                </div>
              </div>

              <div class="mt-4 flex shrink-0 items-center justify-between gap-2 border-t border-border-weak-base pt-4">
                <span class="text-12-regular text-text-weak">{dirty() ? "" : language.t("scheduled.saved")}</span>
                <div class="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => (state.editing ? discardChanges() : setState("formOpen", false))}
                  >
                    {state.editing ? language.t("scheduled.discard") : language.t("common.cancel")}
                  </Button>
                  <Button type="submit" variant="primary" disabled={!dirty() || state.saving}>
                    {state.saving ? language.t("common.saving") : language.t("common.save")}
                  </Button>
                </div>
              </div>
            </form>
          </Show>
        </main>
      </div>
    </div>
  )
}
