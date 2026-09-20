import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
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
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { CronExpressionField } from "@/components/cron-expression-field"
import { TimezoneSelectField } from "@/components/timezone-select-field"
import { MarkdownEditorField } from "@/components/markdown-editor-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useSessionTabs } from "@/context/session-tabs"
import { formatDateTimeLocal, parseDateTimeLocal } from "@/utils/time"
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

/** Form fields worth carrying across a minimize/restore round-trip. */
export type ScheduledTaskFormSnapshot = {
  name: string
  prompt: string
  agent: string
  providerID: string
  modelID: string
  variant: string
  executionMode: ExecutionMode
  sessionID: string
  scheduleKind: ScheduleKind
  at: string
  intervalMinutes: string
  cron: string
  timezone: string
  unattended: boolean
  enabled: boolean
}

/** Everything needed to reopen a minimized scheduled task editor. */
export type ScheduledTaskEditorStash = {
  task?: ScheduledTask
  projectID?: string
  projectName?: string
  directory?: string
  snapshot: ScheduledTaskFormSnapshot
}

function formSnapshot(state: {
  name: string
  prompt: string
  agent: string
  providerID: string
  modelID: string
  variant: string
  executionMode: ExecutionMode
  sessionID: string
  scheduleKind: ScheduleKind
  at: string
  intervalMinutes: string
  cron: string
  timezone: string
  unattended: boolean
  enabled: boolean
}): ScheduledTaskFormSnapshot {
  return {
    name: state.name,
    prompt: state.prompt,
    agent: state.agent,
    providerID: state.providerID,
    modelID: state.modelID,
    variant: state.variant,
    executionMode: state.executionMode,
    sessionID: state.sessionID,
    scheduleKind: state.scheduleKind,
    at: state.at,
    intervalMinutes: state.intervalMinutes,
    cron: state.cron,
    timezone: state.timezone,
    unattended: state.unattended,
    enabled: state.enabled,
  }
}

export function ScheduledTaskFormDialog(props: {
  task?: ScheduledTask
  projectID?: string
  projectName?: string
  directory?: string
  onSaved: () => void | Promise<void>
  /** Restored editing state from a previous minimize; wins over `task` defaults. */
  initialState?: ScheduledTaskFormSnapshot
  minimizeLabel?: string
  onMinimize?: (snapshot: ScheduledTaskFormSnapshot, source: HTMLElement) => void | Promise<void>
}): JSX.Element {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const models = useModels()
  const language = useLanguage()
  const dialog = useDialog()
  const sessionTabs = useSessionTabs()
  const task = props.task
  const restored = props.initialState
  const [maximized, setMaximized] = createSignal(false)
  const [state, setState] = createStore({
    name: restored?.name ?? task?.name ?? "",
    prompt: restored?.prompt ?? task?.prompt ?? "",
    agent: restored?.agent ?? task?.agent ?? "build",
    providerID: restored?.providerID ?? task?.model.providerID ?? "",
    modelID: restored?.modelID ?? task?.model.modelID ?? "",
    variant: restored?.variant ?? task?.model.variant ?? "",
    executionMode: restored?.executionMode ?? task?.executionMode ?? ("automatic_session" as ExecutionMode),
    sessionID: restored?.sessionID ?? task?.sessionID ?? "",
    scheduleKind: restored?.scheduleKind ?? task?.schedule.kind ?? ("every" as ScheduleKind),
    at:
      restored?.at ??
      (task?.schedule.kind === "at"
        ? formatDateTimeLocal(task.schedule.at, task.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
        : ""),
    intervalMinutes:
      restored?.intervalMinutes ??
      (task?.schedule.kind === "every" ? String(task.schedule.interval / 60_000) : "60"),
    cron: restored?.cron ?? (task?.schedule.kind === "cron" ? task.schedule.expression : "0 9 * * 1-5"),
    timezone:
      restored?.timezone ??
      (task?.schedule.kind === "cron"
        ? (task.schedule.timezone ?? "")
        : task?.schedule.kind === "at"
          ? (task.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
          : Intl.DateTimeFormat().resolvedOptions().timeZone),
    unattended: restored?.unattended ?? !!task,
    enabled: restored?.enabled ?? task?.enabled ?? true,
    runs: [] as ScheduledTaskRun[],
    loadingRuns: !!task,
    pendingAction: false,
    saving: false,
    error: "",
  })

  const directory = () => task?.directory ?? props.directory ?? ""
  const dialogContainerStyle = createMemo(() =>
    task && maximized()
      ? {
          width: "90vw",
          "max-width": "90vw",
          height: "95vh",
          "max-height": "95vh",
        }
      : {
          width: task ? "min(calc(100vw - 32px), 1480px)" : "min(calc(100vw - 32px), 1120px)",
          height: "min(calc(100vh - 32px), 860px)",
        },
  )

  function toggleMaximized() {
    const next = !maximized()
    console.debug(`[scheduled-panel] edit maximize task=${task?.id ?? "new"} maximized=${String(next)}`)
    setMaximized(next)
  }

  /** Park the dialog on the rail stash: snapshot the form, then close without saving. */
  async function minimize(event: MouseEvent & { currentTarget: HTMLElement }) {
    if (!props.onMinimize) return
    const snapshot = formSnapshot(state)
    console.debug(`[scheduled-panel] edit minimize task=${task?.id ?? "new"} name=${snapshot.name || "none"}`)
    const source = event.currentTarget.closest<HTMLElement>('[data-component="dialog"]')
    if (!source) {
      console.debug(`[scheduled-panel] edit minimize missing-source task=${task?.id ?? "new"}`)
      return
    }
    await props.onMinimize(snapshot, source)
    dialog.close()
  }

  const agentOptions = createMemo(() => {
    const dir = directory()
    const names = (dir ? globalSync.child(dir)[0].agent : [])
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

  async function loadRuns(source: string) {
    if (!task) return
    console.debug(`[scheduled-panel] edit runs load-start task=${task.id} source=${source}`)
    setState("loadingRuns", true)
    try {
      const result = await sdk.client.scheduledTask.runs({ taskID: task.id, limit: "20" })
      console.debug(`[scheduled-panel] edit runs load-success task=${task.id} count=${result.data?.length ?? 0}`)
      setState("runs", result.data ?? [])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit runs load-failed task=${task.id} error=${message}`)
      setState("error", message)
    } finally {
      setState("loadingRuns", false)
    }
  }

  async function runNow() {
    if (!task || state.pendingAction) return
    console.debug(`[scheduled-panel] edit run-now start task=${task.id}`)
    setState({ pendingAction: true, error: "" })
    try {
      await sdk.client.scheduledTask.runNow({ taskID: task.id })
      console.debug(`[scheduled-panel] edit run-now success task=${task.id}`)
      await loadRuns("run-now")
      await props.onSaved()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit run-now failed task=${task.id} error=${message}`)
      setState("error", message)
    } finally {
      setState("pendingAction", false)
    }
  }

  async function toggleEnabled() {
    if (!task || state.pendingAction) return
    const enabled = !state.enabled
    console.debug(`[scheduled-panel] edit toggle start task=${task.id} enabled=${enabled}`)
    setState({ pendingAction: true, error: "" })
    try {
      await sdk.client.scheduledTask.update({ taskID: task.id, scheduledTaskUpdateInput: { enabled } })
      console.debug(`[scheduled-panel] edit toggle success task=${task.id} enabled=${enabled}`)
      setState("enabled", enabled)
      await props.onSaved()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit toggle failed task=${task.id} error=${message}`)
      setState("error", message)
    } finally {
      setState("pendingAction", false)
    }
  }

  async function remove() {
    if (!task || !window.confirm(language.t("scheduled.delete.confirm", { name: task.name }))) return
    console.debug(`[scheduled-panel] edit delete start task=${task.id}`)
    setState({ pendingAction: true, error: "" })
    try {
      await sdk.client.scheduledTask.remove({ taskID: task.id })
      console.debug(`[scheduled-panel] edit delete success task=${task.id}`)
      await props.onSaved()
      dialog.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit delete failed task=${task.id} error=${message}`)
      setState({ pendingAction: false, error: message })
    }
  }

  let openingSessionID: string | undefined
  async function openSession(sessionID?: string) {
    if (!task || !sessionID || openingSessionID) {
      console.debug(
        `[scheduled-panel] edit open-session ignored task=${task?.id ?? "new"} id=${sessionID ?? "none"} pending=${openingSessionID ?? "none"}`,
      )
      return
    }
    openingSessionID = sessionID
    console.debug(`[scheduled-panel] edit open-session probe-start task=${task.id} id=${sessionID}`)
    setState("error", "")
    try {
      const session = await sdk.client.session.get({ directory: task.directory, sessionID }).then((result) => result.data)
      if (!session) throw new Error(`Session not found: ${sessionID}`)
      console.debug(
        `[scheduled-panel] edit open-session probe-success task=${task.id} id=${sessionID} archived=${String(!!session.time.archived)}`,
      )
      const restored = session.time.archived
        ? await sdk.client.session
            .update({ directory: session.directory, sessionID, time: { archived: null } })
            .then((result) => result.data)
        : session
      if (!restored) throw new Error(`Failed to restore session: ${sessionID}`)
      console.debug(`[scheduled-panel] edit open-session activate-start task=${task.id} id=${sessionID}`)
      sessionTabs.restore({
        directory: restored.directory,
        id: restored.id,
        title: restored.title,
        parentID: restored.parentID,
      })
      const result = await sessionTabs.activate({ type: "session", directory: restored.directory, id: sessionID })
      console.debug(`[scheduled-panel] edit open-session activate-finish task=${task.id} id=${sessionID} result=${result}`)
      if (result !== "navigated") throw new Error(`Failed to open session: ${result}`)
      dialog.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit open-session failed task=${task.id} id=${sessionID} error=${message}`)
      setState("error", message)
    } finally {
      openingSessionID = undefined
    }
  }

  onMount(() => void loadRuns("open"))

  function schedule(): ScheduledTaskSchedule | undefined {
    if (state.scheduleKind === "at") {
      const timezone = state.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
      const at = parseDateTimeLocal(state.at, timezone)
      return Number.isFinite(at) ? { kind: "at", at, timezone } : undefined
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
    console.debug(`[scheduled-panel] edit save start task=${task?.id ?? "new"}`)
    const model = {
      providerID: state.providerID.trim(),
      modelID: state.modelID.trim(),
      variant: state.variant.trim() || undefined,
    }
    // Automatic and existing modes retain a stable source session; unrelated runs clear it.
    const sessionID = state.executionMode !== "new_session" ? state.sessionID.trim() || undefined : null
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
      console.debug(`[scheduled-panel] edit save success task=${task?.id ?? "new"}`)
      await props.onSaved()
      dialog.close()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[scheduled-panel] edit save failed task=${task?.id ?? "new"} error=${message}`)
      setState("error", message)
    } finally {
      setState("saving", false)
    }
  }

  return (
    <>
      <style
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={`
          [data-component="dialog"][data-scheduled-task-dialog][data-maximized] [data-slot="dialog-container"] {
            display: flex;
            flex-direction: column;
          }
          [data-component="dialog"][data-scheduled-task-dialog][data-maximized] [data-slot="dialog-content"] {
            height: 100% !important;
            max-height: 100% !important;
            overflow: hidden !important;
          }
          [data-component="dialog"][data-scheduled-task-dialog][data-maximized] [data-slot="dialog-body"] {
            min-height: 0;
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
          }
        `}
      />
      <Dialog
      title={
        <div class="flex min-w-0 flex-col pl-1">
          <div class="flex min-w-0 items-center gap-3">
            <span class="min-w-0 flex-1 truncate leading-6">{task?.name ?? language.t("scheduled.create")}</span>
            <Show when={props.projectName || props.directory}>
              <span class="max-w-[40%] shrink-0 truncate rounded-full bg-surface-base px-2.5 py-0.5 text-16-medium leading-6 text-text-weak">
                {props.projectName || getFilename(props.directory ?? "") || props.directory}
              </span>
            </Show>
          </div>
          <span class="mt-0.5 truncate text-12-regular leading-4 text-text-weak">
            {task?.id ?? props.directory ?? language.t("scheduled.subtitle")}
          </span>
        </div>
      }
      size="x-large"
      transition
      containerStyle={dialogContainerStyle()}
      data-scheduled-task-dialog={task?.id}
      data-maximized={task && maximized() ? "" : undefined}
      action={
        task || props.onMinimize ? (
          <div class="flex items-center gap-2">
            <Show when={props.onMinimize}>
              <Tooltip placement="bottom" value={props.minimizeLabel ?? ""}>
                <IconButton
                  icon="panel-minimize"
                  size="large"
                  variant="ghost"
                  onClick={minimize}
                  aria-label={props.minimizeLabel}
                  data-action="dialog-minimize"
                />
              </Tooltip>
            </Show>
            <Show when={task}>
              <Tooltip
                placement="bottom"
                value={maximized() ? language.t("trellis.tasks.restore") : language.t("trellis.tasks.maximize")}
              >
                <IconButton
                  icon={maximized() ? "collapse" : "expand"}
                  size="large"
                  variant="ghost"
                  onClick={toggleMaximized}
                  aria-label={maximized() ? language.t("trellis.tasks.restore") : language.t("trellis.tasks.maximize")}
                />
              </Tooltip>
            </Show>
            <IconButton
              icon="close"
              size="large"
              variant="ghost"
              onClick={() => dialog.close()}
              aria-label={language.t("common.close")}
            />
          </div>
        ) : undefined
      }
    >
      <form onSubmit={save} class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <div
          class="grid min-h-0 flex-1 gap-4 overflow-hidden"
          classList={{
            "lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]": !task,
            "lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)_minmax(220px,0.65fr)]": !!task,
          }}
        >
          <MarkdownEditorField
            text={state.prompt}
            preview
            placeholder={language.t("scheduled.prompt.placeholder")}
            onInput={(value) => setState("prompt", value)}
            class="min-h-[320px] h-full min-w-0 bg-background-base lg:min-h-0"
          />

          <div class="config-scrollbar flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-1">
            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
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
              </div>
            </section>

            <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
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
                    onSelect={(item) => {
                      if (!item) return
                      setState({
                        scheduleKind: item,
                        ...(item === "at" && !state.timezone
                          ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                          : {}),
                      })
                    }}
                    class="max-w-full"
                  />
                </FieldLabel>
                <Show when={state.scheduleKind === "at"}>
                  <FieldLabel label={language.t("scheduled.schedule.at.time")}>
                    <TextField
                      type="datetime-local"
                      value={state.at}
                      onChange={(value) => setState("at", value)}
                      class="!w-fit max-w-full"
                    />
                  </FieldLabel>
                  <TimezoneSelectField
                    label={language.t("scheduled.timezone")}
                    value={state.timezone}
                    onChange={(value) => setState("timezone", value)}
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

          <Show when={task}>
            <aside class="config-scrollbar min-h-0 min-w-0 overflow-y-auto px-1">
              <section class="rounded-xl border border-border-weak-base bg-surface-raised-base p-4">
                <div class="mb-3 flex items-center justify-between gap-2">
                  <div class="text-12-medium text-text-weak">{language.t("scheduled.history")}</div>
                  <span class="text-11-regular text-text-weaker">{state.runs.length}</span>
                </div>
                <Show
                  when={!state.loadingRuns && state.runs.length > 0}
                  fallback={
                    <Show when={!state.loadingRuns}>
                      <div class="py-3 text-center text-12-regular text-text-weak">
                        {language.t("scheduled.history.empty")}
                      </div>
                    </Show>
                  }
                >
                  <div class="grid gap-2">
                    <For each={state.runs}>
                      {(run) => {
                        const sessionID = () => run.sessionID ?? task?.sessionID
                        return (
                          <button
                            type="button"
                            class="min-w-0 rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-left transition-colors enabled:hover:bg-surface-raised-base-hover disabled:cursor-default"
                            disabled={!sessionID()}
                            title={run.error ?? (sessionID() ? language.t("scheduled.openSession") : undefined)}
                            onClick={() => void openSession(sessionID())}
                          >
                            <div class={`truncate text-11-medium ${statusTone(run.status)}`}>{run.status}</div>
                            <div class="mt-1 text-11-regular leading-4 text-text-weak">
                              {formatDate(run.scheduledAt)}
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </section>
            </aside>
          </Show>
        </div>
        <div class="mt-4 flex shrink-0 flex-wrap items-center gap-2 border-t border-border-weak-base pt-4">
          <Show when={task}>
            <Button
              type="button"
              icon="arrow-right"
              variant="ghost"
              disabled={state.pendingAction}
              onClick={() => void runNow()}
            >
              {language.t("scheduled.runNow")}
            </Button>
            <Button
              type="button"
              icon={state.enabled ? "stop" : "play"}
              variant="ghost"
              disabled={state.pendingAction}
              onClick={() => void toggleEnabled()}
            >
              {state.enabled ? language.t("scheduled.disable") : language.t("scheduled.enable")}
            </Button>
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <Show when={task}>
              <Tooltip value={language.t("scheduled.delete")}>
                <Button
                  type="button"
                  icon="trash"
                  variant="ghost"
                  disabled={state.pendingAction}
                  onClick={() => void remove()}
                  aria-label={language.t("scheduled.delete")}
                >
                  {language.t("common.delete")}
                </Button>
              </Tooltip>
            </Show>
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={state.saving || state.pendingAction}>
              {state.saving ? language.t("common.saving") : language.t("common.save")}
            </Button>
          </div>
        </div>
      </form>
      </Dialog>
    </>
  )
}

function FieldLabel(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span class="shrink-0 text-12-medium text-text-weak">{props.label}</span>
      <div class="ml-auto max-w-full">{props.children}</div>
    </label>
  )
}

export function ScheduledTasksPanel(props: {
  projectID: Accessor<string>
  projectName: Accessor<string>
  directory: Accessor<string>
  width: Accessor<number>
  mobile?: boolean
  onBack: () => void
  /** Optional: let the task editor dialog park itself on the rail stash. */
  editorMinimizeLabel?: string
  onStashEditor?: (payload: ScheduledTaskEditorStash, source: HTMLElement) => void | Promise<void>
  onDismissEditorStash?: (taskID: string | undefined) => void
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
    dialog.show(() => (
      <ScheduledTaskFormDialog
        task={task}
        projectName={props.projectName() || task.projectName}
        onSaved={() => {
          // The stashed editing session (if any) is superseded by this save.
          props.onDismissEditorStash?.(task.id)
          return load({ silent: true })
        }}
        minimizeLabel={props.editorMinimizeLabel}
        onMinimize={
          props.onStashEditor
            ? (snapshot, source) =>
                props.onStashEditor!({
                  task,
                  projectID: props.projectID() || undefined,
                  projectName: props.projectName() || task.projectName,
                  directory: props.directory() || task.directory || undefined,
                  snapshot,
                }, source)
            : undefined
        }
      />
    ))
  }

  function create() {
    const projectID = props.projectID()
    const directory = props.directory()
    if (!projectID || !directory) return
    dialog.show(() => (
      <ScheduledTaskFormDialog
        projectID={projectID}
        projectName={props.projectName()}
        directory={directory}
        onSaved={() => {
          props.onDismissEditorStash?.(undefined)
          return load({ silent: true })
        }}
        minimizeLabel={props.editorMinimizeLabel}
        onMinimize={
          props.onStashEditor
            ? (snapshot, source) => props.onStashEditor!({ projectID, projectName: props.projectName(), directory, snapshot }, source)
            : undefined
        }
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
