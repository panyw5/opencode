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
import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { decode64 } from "@/utils/base64"
import { CronExpressionField } from "@/components/cron-expression-field"
import { TimezoneSelectField } from "@/components/timezone-select-field"
import { projectOwner, workspaceKey } from "@/pages/layout/helpers"

type ScheduleKind = ScheduledTaskSchedule["kind"]

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

function statusTone(status?: ScheduledTask["lastStatus"] | ScheduledTaskRun["status"]) {
  if (status === "ok") return "text-text-success"
  if (status === "error") return "text-text-danger"
  if (status === "running" || status === "retrying") return "text-text-interactive-base"
  return "text-text-weak"
}

export default function Scheduled() {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const models = useModels()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  let routeIntentHandled = false
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
    executionMode: "existing_session" as "new_session" | "existing_session",
    sessionID: "",
    scheduleKind: "every" as ScheduleKind,
    at: "",
    intervalMinutes: "60",
    cron: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    unattended: false,
  })

  const projects = createMemo(() =>
    sync.data.project
      .filter((project) => project.worktree)
      .slice()
      .sort((a, b) => (a.name || a.worktree).localeCompare(b.name || b.worktree)),
  )
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
  const filtered = createMemo(() => {
    const directory = routeDirectory()
    const projectID = routeProject()?.id ?? state.projectID
    if (directory && !routeProject()) {
      return state.tasks.filter((task) => workspaceKey(task.directory) === workspaceKey(directory))
    }
    return projectID === "all" ? state.tasks : state.tasks.filter((task) => task.projectID === projectID)
  })
  const selected = createMemo(() => state.tasks.find((task) => task.id === state.selectedID))

  async function load() {
    setState({ loading: true, error: "" })
    try {
      const result = await sdk.client.scheduledTask.list()
      const tasks = result.data ?? []
      setState("tasks", tasks)
      if (state.selectedID && !tasks.some((task) => task.id === state.selectedID)) setState("selectedID", undefined)
      if (!routeIntentHandled) {
        routeIntentHandled = true
        const query = new URLSearchParams(location.search)
        const requested = tasks.find((task) => task.id === query.get("task"))
        if (requested && query.get("edit") === "true") resetForm(requested)
        else if (query.get("create") === "true") resetForm()
      }
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
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
    setState({ selectedID: task.id, formOpen: false, editing: false })
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
      executionMode: task?.executionMode ?? "existing_session",
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
    // existing_session binds a session on first run; keep any already-bound id when editing.
    const sessionID =
      state.executionMode === "existing_session" ? state.sessionID.trim() || undefined : null
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
      setState({ formOpen: false, editing: false })
      await load()
      if (state.selectedID) await loadRuns(state.selectedID)
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

  onMount(() => void load())
  createEffect(() => {
    const task = selected()
    if (task && state.runsTaskID !== task.id && !state.runsLoading) void loadRuns(task.id)
  })
  // listenAll: name=directory, details.type=event type (e.g. scheduled-task.created)
  const stop = sdk.listenAll((event) => {
    if (!event.details.type.startsWith("scheduled-task.")) return
    void load()
    const id = state.selectedID
    if (id) void loadRuns(id)
  })
  onCleanup(stop)

  return (
    <div class="size-full overflow-hidden bg-background-base">
      <header class="flex h-14 items-center justify-between border-b border-border-weak-base px-5">
        <div>
          <h1 class="text-18-medium text-text-strong">{language.t("scheduled.title")}</h1>
          <p class="text-12-regular text-text-weak">
            <Show when={routeProject()}>{(project) => `${project().name || getFilename(project().worktree)} · `}</Show>
            {language.t("scheduled.subtitle")}
          </p>
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

        <main class="min-h-0 overflow-y-auto">
          <Show
            when={state.formOpen}
            fallback={
              <Show
                when={selected()}
                fallback={
                  <div class="flex h-full items-center justify-center p-8 text-13-regular text-text-weak">
                    {language.t("scheduled.select")}
                  </div>
                }
              >
                {(task) => (
                  <div class="mx-auto flex max-w-5xl flex-col gap-7 p-5 md:p-8">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h2 class="truncate text-24-medium text-text-strong">{task().name}</h2>
                        <p class="mt-1 truncate text-13-regular text-text-weak">{task().directory}</p>
                      </div>
                      <div class="flex items-center gap-2">
                        <Tooltip value={language.t("scheduled.runNow")}>
                          <IconButton icon="arrow-right" onClick={() => void runNow(task())} />
                        </Tooltip>
                        <Tooltip value={language.t("scheduled.edit")}>
                          <IconButton icon="edit" onClick={() => resetForm(task())} />
                        </Tooltip>
                        <Tooltip value={language.t("scheduled.delete")}>
                          <IconButton icon="trash" onClick={() => void remove(task())} />
                        </Tooltip>
                      </div>
                    </div>

                    <div class="grid gap-5 border-y border-border-weak-base py-5 sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <div class="text-11-medium text-text-weaker">{language.t("scheduled.nextRun")}</div>
                        <div class="mt-1 text-13-regular text-text-strong">{formatDate(task().nextRunAt)}</div>
                      </div>
                      <div>
                        <div class="text-11-medium text-text-weaker">{language.t("scheduled.schedule")}</div>
                        <div class="mt-1 text-13-regular text-text-strong">
                          {scheduleLabel(task().schedule, language.t)}
                        </div>
                      </div>
                      <div>
                        <div class="text-11-medium text-text-weaker">{language.t("scheduled.model")}</div>
                        <div class="mt-1 text-13-regular text-text-strong">
                          {task().model.providerID}/{task().model.modelID}
                        </div>
                      </div>
                      <div class="flex items-center">
                        <Switch checked={task().enabled} onChange={() => void toggle(task())}>
                          {task().enabled ? language.t("scheduled.enabled") : language.t("scheduled.disabled")}
                        </Switch>
                      </div>
                    </div>

                    <section>
                      <div class="mb-2 flex items-center gap-2 text-13-medium text-text-strong">
                        <Icon name="shield" />
                        {language.t("scheduled.unattended.title")}
                      </div>
                      <p class="text-12-regular text-text-weak">{language.t("scheduled.unattended.detail")}</p>
                    </section>
                    <section>
                      <h3 class="mb-2 text-13-medium text-text-strong">{language.t("scheduled.prompt")}</h3>
                      <pre class="whitespace-pre-wrap border-l-2 border-border-strong-base pl-4 text-13-regular text-text-base">
                        {task().prompt}
                      </pre>
                    </section>
                    <section>
                      <h3 class="mb-3 text-13-medium text-text-strong">{language.t("scheduled.history")}</h3>
                      <Show when={!state.runsLoading} fallback={<Spinner />}>
                        <Show
                          when={state.runs.length > 0}
                          fallback={
                            <div class="text-12-regular text-text-weak">{language.t("scheduled.history.empty")}</div>
                          }
                        >
                          <div class="divide-y divide-border-weak-base border-y border-border-weak-base">
                            <For each={state.runs}>
                              {(run) => (
                                <div class="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 py-3 text-12-regular">
                                  <span class={statusTone(run.status)}>{run.status}</span>
                                  <div class="min-w-0">
                                    <div class="truncate text-text-base">{formatDate(run.scheduledAt)}</div>
                                    <Show when={run.error}>
                                      <div class="truncate text-text-danger">{run.error}</div>
                                    </Show>
                                  </div>
                                  <Show when={run.sessionID}>
                                    <Button
                                      size="small"
                                      variant="ghost"
                                      onClick={() =>
                                        navigate(`/${base64Encode(task().directory)}/session/${run.sessionID}`)
                                      }
                                    >
                                      {language.t("scheduled.openSession")}
                                    </Button>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                    </section>
                  </div>
                )}
              </Show>
            }
          >
            <form onSubmit={save} class="mx-auto flex max-w-4xl flex-col gap-6 p-5 md:p-8">
              <div class="flex items-center justify-between">
                <h2 class="text-20-medium text-text-strong">
                  {state.editing ? language.t("scheduled.edit") : language.t("scheduled.create")}
                </h2>
                <IconButton icon="close" variant="ghost" onClick={() => setState("formOpen", false)} />
              </div>
              <div class="grid gap-5 md:grid-cols-2">
                <div class="md:col-span-2">
                  <TextField
                    label={language.t("scheduled.name")}
                    value={state.name}
                    onChange={(value) => setState("name", value)}
                  />
                </div>
                <Show when={!state.editing && !routeDirectory()}>
                  <div class="md:col-span-2">
                    <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.project")}</label>
                    <Select
                      options={projects()}
                      current={projects().find((item) => item.id === state.projectIDForm)}
                      value={(item) => item.id}
                      label={(item) => item.name || getFilename(item.worktree)}
                      onSelect={(item) => item && chooseProject(item.id)}
                      class="w-full"
                    />
                  </div>
                </Show>
                <div class="md:col-span-2">
                  <TextField
                    multiline
                    label={language.t("scheduled.prompt")}
                    value={state.prompt}
                    onChange={(value) => setState("prompt", value)}
                    class="min-h-32"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.agent")}</label>
                  <Select
                    options={agentOptions()}
                    current={state.agent}
                    onSelect={(item) => item && setState("agent", item)}
                    class="w-full"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.model")}</label>
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
                    class="w-full"
                  />
                </div>
                <Show when={variantOptions().length > 1}>
                  <div>
                    <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.variant")}</label>
                    <Select
                      options={variantOptions()}
                      current={state.variant || "default"}
                      label={(item) => (item === "default" ? language.t("common.default") : item)}
                      onSelect={(item) => item && setState("variant", item === "default" ? "" : item)}
                      class="w-full"
                    />
                  </div>
                </Show>
                <div>
                  <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.execution")}</label>
                  <Select
                    options={["existing_session", "new_session"] as const}
                    current={state.executionMode}
                    label={(item) =>
                      language.t(item === "new_session" ? "scheduled.execution.new" : "scheduled.execution.existing")
                    }
                    onSelect={(item) => item && setState("executionMode", item)}
                    class="w-full"
                  />
                </div>
                <div>
                  <label class="mb-1 block text-12-medium text-text-weak">{language.t("scheduled.schedule")}</label>
                  <Select
                    options={["at", "every", "cron"] as const}
                    current={state.scheduleKind}
                    label={(item) =>
                      item === "at"
                        ? language.t("scheduled.schedule.at")
                        : item === "every"
                          ? language.t("scheduled.schedule.every")
                          : language.t("scheduled.schedule.cron")
                    }
                    onSelect={(item) => item && setState("scheduleKind", item)}
                    class="w-full"
                  />
                </div>
                <Show when={state.scheduleKind === "at"}>
                  <div>
                    <TextField
                      type="datetime-local"
                      label={language.t("scheduled.schedule.at")}
                      value={state.at}
                      onChange={(value) => setState("at", value)}
                    />
                  </div>
                </Show>
                <Show when={state.scheduleKind === "every"}>
                  <div>
                    <TextField
                      type="number"
                      min="1"
                      label={language.t("scheduled.intervalMinutes")}
                      value={state.intervalMinutes}
                      onChange={(value) => setState("intervalMinutes", value)}
                    />
                  </div>
                </Show>
                <Show when={state.scheduleKind === "cron"}>
                  <div class="md:col-span-2">
                    <CronExpressionField
                      label={language.t("scheduled.cron")}
                      meaningLabel={language.t("scheduled.cron.meaning")}
                      value={state.cron}
                      timezone={state.timezone}
                      locale={language.locale()}
                      onChange={(value) => setState("cron", value)}
                    />
                  </div>
                  <div>
                    <TimezoneSelectField
                      label={language.t("scheduled.timezone")}
                      value={state.timezone}
                      onChange={(value) => setState("timezone", value)}
                    />
                  </div>
                </Show>
              </div>
              <div class="border-y border-border-weak-base py-4">
                <Checkbox
                  checked={state.unattended}
                  onChange={(value) => setState("unattended", value)}
                  description={language.t("scheduled.unattended.detail")}
                >
                  {language.t("scheduled.unattended.accept")}
                </Checkbox>
              </div>
              <Show when={state.error}>
                <div class="text-12-regular text-text-danger">{state.error}</div>
              </Show>
              <div class="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setState("formOpen", false)}>
                  {language.t("common.cancel")}
                </Button>
                <Button type="submit" variant="primary" disabled={state.saving}>
                  {state.saving ? language.t("common.saving") : language.t("common.save")}
                </Button>
              </div>
            </form>
          </Show>
        </main>
      </div>
    </div>
  )
}
