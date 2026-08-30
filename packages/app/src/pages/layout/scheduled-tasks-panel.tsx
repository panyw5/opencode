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
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, onMount, Show, untrack, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { CronExpressionField } from "@/components/cron-expression-field"
import { TimezoneSelectField } from "@/components/timezone-select-field"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import {
  sameScheduledTaskPanelScope,
  scheduledTaskEventMatchesScope,
  type ScheduledTaskPanelScope,
} from "./scheduled-tasks-panel-scope"

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

function ScheduledTaskCard(props: {
  task: ScheduledTask
  enabledLabel: string
  disabledLabel: string
  lastRunLabel: string
  nextRunLabel: string
  t: (key: string, vars?: Record<string, string | number>) => string
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="flex min-h-24 w-full flex-col gap-2 rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-3 text-left shadow-xs-border-base transition-colors hover:bg-surface-raised-base-hover"
      onClick={props.onOpen}
    >
      <div class="flex w-full items-stretch gap-2.5">
        <div class="flex w-9 shrink-0 items-center justify-center self-stretch rounded-lg bg-surface-base">
          <Icon name="clock" size="normal" class="text-icon-base" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-13-medium text-text-strong">{props.task.name}</div>
          <div class="mt-0.5 truncate text-11-regular text-text-weak">
            {scheduleLabel(props.task.schedule, props.t)}
          </div>
        </div>
      </div>
      <div class="line-clamp-3 text-12-mono text-text-base">
        {props.task.prompt.length > 200 ? props.task.prompt.slice(0, 200) + "…" : props.task.prompt}
      </div>
      <Show when={props.task.lastError}>
        <div class="line-clamp-2 text-11-regular text-text-danger">{props.task.lastError}</div>
      </Show>
      <div class="flex w-full items-center justify-between gap-2 text-11-regular text-text-weaker">
        <span class="min-w-0 truncate">
          {props.task.lastRunAt
            ? `${props.lastRunLabel} ${formatDate(props.task.lastRunAt)}`
            : props.task.enabled
              ? `${props.nextRunLabel} ${formatDate(props.task.nextRunAt)}`
              : "-"}
        </span>
        <span class="shrink-0">{props.task.enabled ? props.enabledLabel : props.disabledLabel}</span>
      </div>
    </button>
  )
}

function ScheduledTaskDetailDialog(props: {
  task: ScheduledTask
  onChanged: () => void | Promise<void>
}): JSX.Element {
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
      await props.onChanged()
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
      await props.onChanged()
      dialog.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      setState("pending", false)
    }
  }

  function edit() {
    dialog.show(() => (
      <ScheduledTaskFormDialog
        task={state.task}
        onSaved={async () => {
          await load()
          await props.onChanged()
        }}
      />
    ))
  }

  function openSession(sessionID?: string) {
    if (!sessionID) return
    dialog.close()
    navigate(`/${base64Encode(state.task.directory)}/session/${sessionID}`)
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
      size="x-large"
      transition
      containerStyle={{
        width: "min(calc(100vw - 32px), 1120px)",
        height: "min(calc(100vh - 32px), 860px)",
      }}
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
                <Detail
                  label={language.t("scheduled.schedule")}
                  value={scheduleLabel(state.task.schedule, language.t)}
                />
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
                <Detail
                  label={language.t("scheduled.lastStatus")}
                  value={state.task.lastStatus ?? "-"}
                  tone={statusTone(state.task.lastStatus)}
                />
                <div class="min-w-0 rounded-lg border border-border-weak-base bg-background-base p-3">
                  <div class="flex items-center gap-1.5 text-11-medium text-text-weak">
                    <Icon name="shield" size="small" class="text-icon-base" />
                    {language.t("scheduled.unattended.title")}
                  </div>
                  <div class="mt-1 line-clamp-3 text-13-regular text-text-strong">
                    {language.t("scheduled.unattended.detail")}
                  </div>
                </div>
              </div>
              <Show when={state.task.lastError}>
                <div class="mt-3 rounded-lg border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong break-words">
                  {state.task.lastError}
                </div>
              </Show>
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-2 text-12-medium text-text-weak">{language.t("scheduled.prompt")}</div>
              {/* Explicit height: MarkdownEditorField uses h-full and collapses when parent has no height. */}
              <div class="max-h-80 min-h-40 overflow-y-auto rounded-xl border border-border-weak-base bg-background-base px-3 py-3 shadow-xs-border-base">
                <Show
                  when={state.task.prompt.trim()}
                  fallback={<div class="text-12-regular text-text-weak">—</div>}
                >
                  <Markdown text={state.task.prompt} class="text-13-regular text-text-strong" />
                </Show>
              </div>
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
                    {(run) => {
                      const sessionID = () => run.sessionID ?? state.task.sessionID
                      return (
                        <div class="flex flex-col gap-1 px-3 py-2">
                          <div class="flex min-h-10 items-center gap-3">
                            <span class={`w-16 shrink-0 text-11-medium ${statusTone(run.status)}`}>{run.status}</span>
                            <span class="min-w-0 flex-1 truncate text-12-regular text-text-base">
                              {formatDate(run.scheduledAt)}
                            </span>
                            <Show when={sessionID()}>
                              <Button size="small" variant="ghost" onClick={() => openSession(sessionID())}>
                                {language.t("scheduled.openSession")}
                              </Button>
                            </Show>
                          </div>
                          <Show when={run.error}>
                            <div class="pl-[4.5rem] text-11-regular text-text-danger break-words">{run.error}</div>
                          </Show>
                        </div>
                      )
                    }}
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
              icon={state.task.enabled ? "stop" : "play"}
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
            <Show when={state.runs.find((run) => run.sessionID)?.sessionID ?? state.task.sessionID}>
              {(sessionID) => (
                <Button icon="speech-bubble" variant="ghost" onClick={() => openSession(sessionID())}>
                  {language.t("scheduled.openLatestSession")}
                </Button>
              )}
            </Show>
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

type ModelOption = {
  key: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  variants?: Record<string, Record<string, unknown>>
}

function ScheduledTaskFormDialog(props: {
  task?: ScheduledTask
  projectID?: string
  directory?: string
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const models = useModels()
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
    executionMode: task?.executionMode ?? ("existing_session" as "new_session" | "existing_session"),
    sessionID: task?.sessionID ?? "",
    scheduleKind: task?.schedule.kind ?? ("every" as ScheduleKind),
    at: task?.schedule.kind === "at" ? new Date(task.schedule.at).toISOString().slice(0, 16) : "",
    intervalMinutes: task?.schedule.kind === "every" ? String(task.schedule.interval / 60_000) : "60",
    cron: task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * 1-5",
    timezone:
      task?.schedule.kind === "cron"
        ? (task.schedule.timezone ?? "")
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    unattended: !!task,
    saving: false,
    error: "",
  })

  const directory = () => task?.directory ?? props.directory ?? ""

  const agentOptions = createMemo(() => {
    const dir = directory()
    const names = (
      dir
        ? globalSync.child(dir)[0].agent
        : []
    )
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
    const agents = agentOptions()
    if (!agents.includes(state.agent) && agents[0]) setState("agent", agents[0])
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
      if (task) {
        await sdk.client.scheduledTask.update({
          taskID: task.id,
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
          projectID,
          directory,
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
        await sdk.client.scheduledTask.create({ scheduledTaskCreateInput: input })
      }
      await props.onSaved()
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
      containerStyle={{
        width: "min(calc(100vw - 32px), 1120px)",
        height: "min(calc(100vh - 32px), 860px)",
      }}
    >
      <form onSubmit={save} class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <div class="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
          <MarkdownEditorField
            text={state.prompt}
            preview
            placeholder={language.t("scheduled.prompt.placeholder")}
            onInput={(value) => setState("prompt", value)}
            class="min-h-[320px] h-full min-w-0 bg-background-base lg:min-h-0"
          />

          <div class="config-scrollbar flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pr-1">
            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                <Icon name="settings-gear" size="small" class="text-icon-base" />
                {language.t("scheduled.section.basics")}
              </div>
              <div class="grid gap-4">
                <div>
                  <TextField
                    label={language.t("scheduled.name")}
                    value={state.name}
                    onChange={(value) => setState("name", value)}
                  />
                </div>
                <FieldLabel label={language.t("scheduled.agent")}>
                  <Select
                    options={agentOptions()}
                    current={state.agent}
                    onSelect={(item) => item && setState("agent", item)}
                    class="w-full"
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
                    class="w-full"
                  />
                </FieldLabel>
                <Show when={variantOptions().length > 1}>
                  <FieldLabel label={language.t("scheduled.variant")}>
                    <Select
                      options={variantOptions()}
                      current={state.variant || "default"}
                      label={(item) => (item === "default" ? language.t("common.default") : item)}
                      onSelect={(item) => item && setState("variant", item === "default" ? "" : item)}
                      class="w-full"
                    />
                  </FieldLabel>
                </Show>
              </div>
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
              <div class="mb-3 flex items-center gap-2 text-13-medium text-text-strong">
                <Icon name="clock" size="small" class="text-icon-base" />
                {language.t("scheduled.section.timing")}
              </div>
              <div class="grid gap-4">
                <FieldLabel label={language.t("scheduled.execution")}>
                  <Select
                    options={["existing_session", "new_session"] as const}
                    current={state.executionMode}
                    label={(item) =>
                      language.t(item === "new_session" ? "scheduled.execution.new" : "scheduled.execution.existing")
                    }
                    onSelect={(item) => item && setState("executionMode", item)}
                    class="w-full"
                  />
                </FieldLabel>
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

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4 shadow-xs-border-base">
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

function Detail(props: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div class="min-w-0 rounded-lg border border-border-weak-base bg-background-base p-3">
      <div class="text-11-medium text-text-weak">{props.label}</div>
      <div class={`mt-1 truncate text-13-regular ${props.tone ?? "text-text-strong"}`}>{props.value}</div>
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
  const activeScope = createMemo<ScheduledTaskPanelScope>(
    () => ({ projectID: props.projectID(), directory: props.directory().replaceAll("\\", "/").replace(/\/+$/, "") }),
    { projectID: "", directory: "" },
    { equals: sameScheduledTaskPanelScope },
  )

  async function load(options?: { silent?: boolean; source?: string; scope?: ScheduledTaskPanelScope }) {
    const current = ++request
    const scope = options?.scope ?? untrack(activeScope)
    const { projectID, directory } = scope
    const started = performance.now()
    console.debug(
      `[scheduled-panel] load start request=${current} source=${options?.source ?? "unknown"} silent=${Boolean(options?.silent)} projectID=${projectID} directory=${directory}`,
    )
    if (!projectID || !directory) {
      console.debug(`[scheduled-panel] load empty-scope request=${current}`)
      setState({ tasks: [], loading: false, error: "" })
      return
    }
    if (!options?.silent) setState({ loading: true, error: "" })
    try {
      const result = await sdk.client.scheduledTask.list({ directory })
      if (current !== request) {
        console.debug(`[scheduled-panel] load stale request=${current} latest=${request}`)
        return
      }
      console.debug(
        `[scheduled-panel] load success request=${current} durationMs=${Math.round(performance.now() - started)} count=${result.data?.length ?? 0}`,
      )
      setState({ tasks: result.data ?? [], error: "" })
    } catch (error) {
      if (current !== request) return
      console.debug(
        `[scheduled-panel] load error request=${current} durationMs=${Math.round(performance.now() - started)} error=${error instanceof Error ? error.message : String(error)}`,
      )
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (current !== request) return
      setState("loading", false)
    }
  }

  function open(task: ScheduledTask) {
    dialog.show(() => <ScheduledTaskDetailDialog task={task} onChanged={() => load({ silent: true })} />)
  }

  function create() {
    const projectID = props.projectID()
    const directory = props.directory()
    if (!projectID || !directory) return
    dialog.show(() => (
      <ScheduledTaskFormDialog
        projectID={projectID}
        directory={directory}
        onSaved={() => load({ silent: true })}
      />
    ))
  }

  createEffect(() => {
    const scope = activeScope()
    void load({ source: "scope-effect", scope })
  })
  // listenAll: name=directory, details.type=event type (e.g. scheduled-task.created)
  const stop = sdk.listenAll((event) => {
    if (!event.details.type.startsWith("scheduled-task.")) return
    const scope = activeScope()
    if (!scheduledTaskEventMatchesScope(event.name, scope)) return
    console.debug(
      `[scheduled-panel] event type=${event.details.type} directory=${event.name} activeDirectory=${scope.directory}`,
    )
    void load({ silent: true, source: `event:${event.details.type}`, scope })
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
                onClick={() => void load({ source: "manual" })}
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
                      lastRunLabel={language.t("scheduled.lastRun")}
                      nextRunLabel={language.t("scheduled.nextRun")}
                      t={language.t}
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
