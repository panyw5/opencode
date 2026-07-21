import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"

const formatDate = (value?: number) => (value ? new Date(value).toLocaleString() : "-")

function scheduleLabel(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "at") return formatDate(schedule.at)
  if (schedule.kind === "every") return `${Math.round(schedule.interval / 60_000)} min`
  return `${schedule.expression}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`
}

function statusTone(status?: ScheduledTask["lastStatus"] | ScheduledTaskRun["status"]) {
  if (status === "ok") return "text-text-success"
  if (status === "error") return "text-text-danger"
  if (status === "running" || status === "retrying") return "text-text-interactive-base"
  return "text-text-weak"
}

function ScheduledTaskCard(props: {
  task: ScheduledTask
  enabledLabel: string
  disabledLabel: string
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="flex min-h-24 w-full flex-col gap-2 rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-3 text-left shadow-xs-border-base transition-colors hover:bg-surface-raised-base-hover"
      onClick={props.onOpen}
    >
      <div class="flex w-full items-start gap-2">
        <div class="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-base">
          <Icon name="clock" size="small" class="text-icon-base" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-13-medium text-text-strong">{props.task.name}</div>
          <div class="mt-0.5 truncate text-11-regular text-text-weak">{scheduleLabel(props.task.schedule)}</div>
        </div>
        <span class={`shrink-0 text-11-medium ${statusTone(props.task.lastStatus)}`}>
          {props.task.lastStatus ?? "-"}
        </span>
      </div>
      <div class="line-clamp-2 text-12-regular text-text-base">{props.task.prompt}</div>
      <div class="flex w-full items-center justify-between gap-2 text-11-regular text-text-weaker">
        <span class="truncate">{props.task.enabled ? formatDate(props.task.nextRunAt) : "-"}</span>
        <span class="shrink-0">{props.task.enabled ? props.enabledLabel : props.disabledLabel}</span>
      </div>
    </button>
  )
}

function ScheduledTaskDetailDialog(props: { task: ScheduledTask; onChanged: () => void }): JSX.Element {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [state, setState] = createStore({
    task: props.task,
    runs: [] as ScheduledTaskRun[],
    loading: true,
    pending: false,
    error: "",
  })

  async function load() {
    setState({ loading: true, error: "" })
    try {
      const [task, runs] = await Promise.all([
        sdk.client.scheduledTask.get({ taskID: props.task.id }),
        sdk.client.scheduledTask.runs({ taskID: props.task.id, limit: "20" }),
      ])
      if (task.data) setState("task", task.data)
      setState("runs", runs.data ?? [])
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("loading", false)
    }
  }

  async function mutate(effect: () => Promise<unknown>) {
    setState({ pending: true, error: "" })
    try {
      await effect()
      await load()
      props.onChanged()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", false)
    }
  }

  async function remove() {
    if (!window.confirm(language.t("scheduled.delete.confirm", { name: state.task.name }))) return
    setState({ pending: true, error: "" })
    try {
      await sdk.client.scheduledTask.remove({ taskID: state.task.id })
      props.onChanged()
      dialog.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      setState("pending", false)
    }
  }

  function edit() {
    dialog.show(() => <ScheduledTaskFormDialog task={state.task} onSaved={props.onChanged} />)
  }

  function openSession(run: ScheduledTaskRun) {
    if (!run.sessionID) return
    dialog.close()
    navigate(`/${base64Encode(state.task.directory)}/session/${run.sessionID}`)
  }

  onMount(() => void load())

  return (
    <Dialog
      title={
        <div class="flex min-w-0 flex-col pl-1">
          <span class="truncate">{state.task.name}</span>
          <span class="mt-0.5 truncate text-12-regular text-text-weak">{state.task.directory}</span>
        </div>
      }
      size="large"
      transition
      action={
        <div class="flex items-center gap-1">
          <Tooltip value={language.t("scheduled.edit")}>
            <IconButton icon="edit" variant="ghost" onClick={edit} aria-label={language.t("scheduled.edit")} />
          </Tooltip>
          <Tooltip value={language.t("scheduled.delete")}>
            <IconButton
              icon="trash"
              variant="ghost"
              disabled={state.pending}
              onClick={() => void remove()}
              aria-label={language.t("scheduled.delete")}
            />
          </Tooltip>
          <IconButton
            icon="close"
            variant="ghost"
            onClick={() => dialog.close()}
            aria-label={language.t("common.close")}
          />
        </div>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <Show
          when={!state.loading}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          <div class="config-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <Show when={state.error}>
              <div class="rounded-lg border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong">
                {state.error}
              </div>
            </Show>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                <Icon name="clock" size="small" class="text-icon-base" />
                {language.t("scheduled.schedule")}
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <Detail label={language.t("scheduled.schedule")} value={scheduleLabel(state.task.schedule)} />
                <Detail label={language.t("scheduled.nextRun")} value={formatDate(state.task.nextRunAt)} />
                <Detail
                  label={language.t("scheduled.model")}
                  value={`${state.task.model.providerID}/${state.task.model.modelID}`}
                />
                <Detail
                  label={language.t("scheduled.execution")}
                  value={language.t(
                    state.task.executionMode === "new_session"
                      ? "scheduled.execution.new"
                      : "scheduled.execution.existing",
                  )}
                />
              </div>
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-2 text-12-medium text-text-weak">{language.t("scheduled.prompt")}</div>
              <MarkdownEditorField
                text={state.task.prompt}
                editable={false}
                preview
                onInput={() => undefined}
                class="h-52 bg-background-base"
              />
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                <Icon name="shield" size="small" class="text-icon-base" />
                {language.t("scheduled.unattended.title")}
              </div>
              <p class="text-12-regular leading-5 text-text-weak">{language.t("scheduled.unattended.detail")}</p>
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 text-12-medium text-text-weak">{language.t("scheduled.history")}</div>
              <Show
                when={state.runs.length > 0}
                fallback={
                  <div class="py-5 text-center text-12-regular text-text-weak">
                    {language.t("scheduled.history.empty")}
                  </div>
                }
              >
                <div class="flex flex-col divide-y divide-border-weak-base rounded-lg border border-border-weak-base bg-background-base">
                  <For each={state.runs}>
                    {(run) => (
                      <div class="flex min-h-12 items-center gap-3 px-3 py-2">
                        <span class={`w-16 shrink-0 text-11-medium ${statusTone(run.status)}`}>{run.status}</span>
                        <span class="min-w-0 flex-1 truncate text-12-regular text-text-base">
                          {formatDate(run.scheduledAt)}
                        </span>
                        <Show when={run.sessionID}>
                          <Button size="small" variant="ghost" onClick={() => openSession(run)}>
                            {language.t("scheduled.openSession")}
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </div>

          <div class="mt-4 flex shrink-0 flex-wrap items-center gap-2 border-t border-border-weak-base pt-4">
            <Button
              icon="arrow-right"
              variant="primary"
              disabled={state.pending}
              onClick={() => void mutate(() => sdk.client.scheduledTask.runNow({ taskID: state.task.id }))}
            >
              {language.t("scheduled.runNow")}
            </Button>
            <Button
              variant="ghost"
              disabled={state.pending}
              onClick={() =>
                void mutate(() =>
                  sdk.client.scheduledTask.update({
                    taskID: state.task.id,
                    scheduledTaskUpdateInput: { enabled: !state.task.enabled },
                  }),
                )
              }
            >
              {state.task.enabled ? language.t("scheduled.disable") : language.t("scheduled.enable")}
            </Button>
            <div class="ml-auto flex items-center gap-1.5 text-12-regular text-text-weak">
              <Icon name="shield" size="small" />
              {language.t("scheduled.unattended.title")}
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

type ScheduleKind = ScheduledTaskSchedule["kind"]

function ScheduledTaskFormDialog(props: {
  task?: ScheduledTask
  projectID?: string
  directory?: string
  onSaved: () => void
}): JSX.Element {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const task = props.task
  const [state, setState] = createStore({
    name: task?.name ?? "",
    prompt: task?.prompt ?? "",
    agent: task?.agent ?? "build",
    providerID: task?.model.providerID ?? "",
    modelID: task?.model.modelID ?? "",
    variant: task?.model.variant ?? "",
    executionMode: task?.executionMode ?? ("new_session" as "new_session" | "existing_session"),
    sessionID: task?.sessionID ?? "",
    scheduleKind: task?.schedule.kind ?? ("every" as ScheduleKind),
    at: task?.schedule.kind === "at" ? new Date(task.schedule.at).toISOString().slice(0, 16) : "",
    intervalMinutes: task?.schedule.kind === "every" ? String(task.schedule.interval / 60_000) : "60",
    cron: task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * 1-5",
    timezone:
      task?.schedule.kind === "cron"
        ? (task.schedule.timezone ?? "")
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    enabled: task?.enabled ?? true,
    unattended: !!task,
    saving: false,
    error: "",
  })

  function schedule(): ScheduledTaskSchedule | undefined {
    if (state.scheduleKind === "at") {
      const at = new Date(state.at).getTime()
      return Number.isFinite(at) ? { kind: "at", at } : undefined
    }
    if (state.scheduleKind === "every") {
      const interval = Number(state.intervalMinutes) * 60_000
      return Number.isSafeInteger(interval) && interval > 0 ? { kind: "every", interval } : undefined
    }
    if (!state.cron.trim()) return
    return { kind: "cron", expression: state.cron.trim(), timezone: state.timezone.trim() || undefined }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const nextSchedule = schedule()
    const projectID = task?.projectID ?? props.projectID
    const directory = task?.directory ?? props.directory
    if (
      !nextSchedule ||
      !projectID ||
      !directory ||
      !state.name.trim() ||
      !state.prompt.trim() ||
      !state.agent.trim() ||
      !state.providerID.trim() ||
      !state.modelID.trim()
    ) {
      setState("error", language.t("scheduled.error.required"))
      return
    }
    if (!state.unattended) {
      setState("error", language.t("scheduled.error.unattended"))
      return
    }
    if (state.executionMode === "existing_session" && !state.sessionID.trim()) {
      setState("error", language.t("scheduled.error.session"))
      return
    }

    setState({ saving: true, error: "" })
    const model = {
      providerID: state.providerID.trim(),
      modelID: state.modelID.trim(),
      variant: state.variant.trim() || undefined,
    }
    try {
      if (task) {
        await sdk.client.scheduledTask.update({
          taskID: task.id,
          scheduledTaskUpdateInput: {
            name: state.name.trim(),
            prompt: state.prompt.trim(),
            schedule: nextSchedule,
            executionMode: state.executionMode,
            sessionID: state.executionMode === "existing_session" ? state.sessionID.trim() : null,
            agent: state.agent.trim(),
            model,
            enabled: state.enabled,
          },
        })
      } else {
        const input: ScheduledTaskCreateInput = {
          projectID,
          directory,
          name: state.name.trim(),
          prompt: state.prompt.trim(),
          schedule: nextSchedule,
          executionMode: state.executionMode,
          sessionID: state.executionMode === "existing_session" ? state.sessionID.trim() : undefined,
          agent: state.agent.trim(),
          model,
          enabled: state.enabled,
          unattended: true,
        }
        await sdk.client.scheduledTask.create({ scheduledTaskCreateInput: input })
      }
      props.onSaved()
      dialog.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("saving", false)
    }
  }

  return (
    <Dialog
      title={
        <div class="flex min-w-0 flex-col pl-1">
          <span>{task ? language.t("scheduled.edit") : language.t("scheduled.create")}</span>
          <span class="mt-0.5 truncate text-12-regular text-text-weak">
            {task?.directory ?? props.directory ?? language.t("scheduled.subtitle")}
          </span>
        </div>
      }
      size="x-large"
      transition
      containerStyle={{ height: "min(calc(100vh - 32px), 720px)" }}
    >
      <form onSubmit={save} class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
            <section class="flex min-h-[360px] flex-col rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div class="text-13-medium text-text-strong">{language.t("scheduled.prompt")}</div>
                  <div class="mt-0.5 text-12-regular text-text-weak">{language.t("scheduled.prompt.description")}</div>
                </div>
              </div>
              <MarkdownEditorField
                text={state.prompt}
                preview
                placeholder={language.t("scheduled.prompt.placeholder")}
                onInput={(value) => setState("prompt", value)}
                class="min-h-0 flex-1 bg-background-base"
              />
            </section>

            <div class="flex min-h-0 flex-col gap-4">
              <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
                <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                  <Icon name="settings-gear" size="small" class="text-icon-base" />
                  {language.t("scheduled.section.basics")}
                </div>
                <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-1">
                  <div>
                    <TextField
                      label={language.t("scheduled.name")}
                      value={state.name}
                      onChange={(value) => setState("name", value)}
                    />
                  </div>
                  <TextField
                    label={language.t("scheduled.agent")}
                    value={state.agent}
                    onChange={(value) => setState("agent", value)}
                  />
                  <TextField
                    label={language.t("scheduled.provider")}
                    value={state.providerID}
                    onChange={(value) => setState("providerID", value)}
                  />
                  <TextField
                    label={language.t("scheduled.modelID")}
                    value={state.modelID}
                    onChange={(value) => setState("modelID", value)}
                  />
                  <TextField
                    label={language.t("scheduled.variant")}
                    value={state.variant}
                    onChange={(value) => setState("variant", value)}
                  />
                </div>
              </section>

              <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
                <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                  <Icon name="clock" size="small" class="text-icon-base" />
                  {language.t("scheduled.section.timing")}
                </div>
                <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-1">
                  <FieldLabel label={language.t("scheduled.execution")}>
                    <Select
                      options={["new_session", "existing_session"] as const}
                      current={state.executionMode}
                      label={(item) =>
                        language.t(item === "new_session" ? "scheduled.execution.new" : "scheduled.execution.existing")
                      }
                      onSelect={(item) => item && setState("executionMode", item)}
                      class="w-full"
                    />
                  </FieldLabel>
                  <Show when={state.executionMode === "existing_session"}>
                    <TextField
                      label={language.t("scheduled.sessionID")}
                      value={state.sessionID}
                      onChange={(value) => setState("sessionID", value)}
                    />
                  </Show>
                  <FieldLabel label={language.t("scheduled.schedule")}>
                    <Select
                      options={["at", "every", "cron"] as const}
                      current={state.scheduleKind}
                      label={(item) => language.t(`scheduled.schedule.${item}`)}
                      onSelect={(item) => item && setState("scheduleKind", item)}
                      class="w-full"
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
                    <TextField
                      label={language.t("scheduled.cron")}
                      value={state.cron}
                      onChange={(value) => setState("cron", value)}
                    />
                    <TextField
                      label={language.t("scheduled.timezone")}
                      value={state.timezone}
                      onChange={(value) => setState("timezone", value)}
                    />
                  </Show>
                </div>
              </section>

              <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
                <div class="flex flex-col gap-4">
                  <Switch checked={state.enabled} onChange={(value) => setState("enabled", value)}>
                    {language.t("scheduled.enabled")}
                  </Switch>
                  <Checkbox
                    checked={state.unattended}
                    onChange={(value) => setState("unattended", value)}
                    description={language.t("scheduled.unattended.detail")}
                  >
                    {language.t("scheduled.unattended.accept")}
                  </Checkbox>
                </div>
              </section>
            </div>
          </div>
          <Show when={state.error}>
            <div class="mt-4 rounded-lg border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong">
              {state.error}
            </div>
          </Show>
        </div>
        <div class="mt-4 flex shrink-0 justify-end gap-2 border-t border-border-weak-base pt-4">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={state.saving}>
            {state.saving ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function FieldLabel(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label>
      <span class="mb-1 block text-12-medium text-text-weak">{props.label}</span>
      {props.children}
    </label>
  )
}

function Detail(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="min-w-0 rounded-lg border border-border-weak-base bg-background-base p-3">
      <div class="text-11-medium text-text-weak">{props.label}</div>
      <div class="mt-1 truncate text-13-regular text-text-strong">{props.value}</div>
    </div>
  )
}

export function ScheduledTasksPanel(props: {
  projectID: Accessor<string>
  directory: Accessor<string>
  width: Accessor<number>
  mobile?: boolean
  onBack: () => void
}): JSX.Element {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ tasks: [] as ScheduledTask[], loading: true, error: "" })
  let request = 0

  async function load() {
    const current = ++request
    const projectID = props.projectID()
    if (!projectID) {
      setState({ tasks: [], loading: false, error: "" })
      return
    }
    setState({ loading: true, error: "" })
    try {
      const result = await sdk.client.scheduledTask.list({ projectID })
      if (current !== request) return
      setState("tasks", result.data ?? [])
    } catch (error) {
      if (current !== request) return
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (current !== request) return
      setState("loading", false)
    }
  }

  function open(task: ScheduledTask) {
    dialog.show(() => <ScheduledTaskDetailDialog task={task} onChanged={() => void load()} />)
  }

  function create() {
    const projectID = props.projectID()
    const directory = props.directory()
    if (!projectID || !directory) return
    dialog.show(() => (
      <ScheduledTaskFormDialog projectID={projectID} directory={directory} onSaved={() => void load()} />
    ))
  }

  createEffect(() => {
    props.projectID()
    void load()
  })
  const stop = sdk.listenAll((event) => {
    if (!event.name.startsWith("scheduled-task.")) return
    void load()
  })
  onCleanup(stop)

  const tasks = createMemo(() => state.tasks.slice().sort((a, b) => a.name.localeCompare(b.name)))

  return (
    <div
      data-component="sidebar-panel"
      class="flex h-full min-h-0 min-w-0 flex-col rounded-tl-[12px] border-l border-t border-border-weaker-base bg-background-base px-3"
      style={{ width: props.mobile ? undefined : `${props.width()}px` }}
    >
      <div class="shrink-0 px-1 py-3">
        <div class="flex items-center justify-between gap-2 py-1 pl-2">
          <div class="flex min-w-0 items-center gap-2">
            <Tooltip placement="bottom" value={language.t("scheduled.back")}>
              <IconButton
                icon="arrow-left"
                variant="ghost"
                size="large"
                class="-ml-1 rounded-lg"
                onClick={props.onBack}
                aria-label={language.t("scheduled.back")}
              />
            </Tooltip>
            <div class="truncate text-14-medium text-text-strong">{language.t("scheduled.title")}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Tooltip placement="bottom" value={language.t("scheduled.create")}>
              <IconButton
                icon="plus"
                variant="ghost"
                size="large"
                class="rounded-lg"
                onClick={create}
                aria-label={language.t("scheduled.create")}
              />
            </Tooltip>
            <Tooltip placement="bottom" value={language.t("scheduled.refresh")}>
              <IconButton
                icon="refresh"
                variant="ghost"
                size="large"
                class="rounded-lg"
                disabled={state.loading}
                onClick={() => void load()}
                aria-label={language.t("scheduled.refresh")}
              />
            </Tooltip>
          </div>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto no-scrollbar px-1 pb-4">
        <Show
          when={!state.loading}
          fallback={
            <div class="flex justify-center py-10">
              <Spinner />
            </div>
          }
        >
          <Show
            when={!state.error}
            fallback={
              <div class="rounded-lg border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong">
                {state.error}
              </div>
            }
          >
            <Show
              when={tasks().length > 0}
              fallback={
                <div class="px-4 py-10 text-center text-14-regular text-text-base">{language.t("scheduled.empty")}</div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={tasks()}>
                  {(task) => (
                    <ScheduledTaskCard
                      task={task}
                      enabledLabel={language.t("scheduled.enabled")}
                      disabledLabel={language.t("scheduled.disabled")}
                      onOpen={() => open(task)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
