import { Show, createMemo, type JSX } from "solid-js"
import { useData } from "../context"
import { useI18n, type UiI18nKey } from "../context/i18n"
import { Icon } from "./icon"

export type PresentedProjectTask = {
  kind: "project_task"
  id: string
  title: string
  status: "open" | "in_progress" | "done" | "archived"
  progress: { total: number; completed: number; inProgress: number; pending: number; cancelled: number }
  sessionCount: number
  descriptionPath: string
  prdExcerpt?: string
  time: { created: number; updated: number; archived?: number }
}

export type PresentedScheduledTask = {
  kind: "scheduled_task"
  id: string
  title: string
  status: string
  schedule:
    | { kind: "at"; at: number; timezone?: string }
    | { kind: "every"; interval: number }
    | { kind: "cron"; expression: string; timezone?: string }
  enabled: boolean
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: string
  agent: string
  model?: { providerID: string; modelID: string; variant?: string }
  promptExcerpt?: string
  time: { created: number; updated: number }
}

export type PresentedTask = PresentedProjectTask | PresentedScheduledTask

export interface PresentedTaskCardProps {
  sessionID: string
  status?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  error?: string
}

const PROJECT_STATUSES = new Set(["open", "in_progress", "done", "archived"])
const SCHEDULED_STATUSES = new Set(["pending", "retrying", "running", "ok", "error", "skipped", "missed", "disabled"])

const PROJECT_STATUS_KEYS: Record<PresentedProjectTask["status"], UiI18nKey> = {
  open: "ui.presentedTask.status.open",
  in_progress: "ui.presentedTask.status.inProgress",
  done: "ui.presentedTask.status.done",
  archived: "ui.presentedTask.status.archived",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/**
 * Parse the card payload out of tool part metadata. Returns undefined when it is
 * missing or malformed (older messages, or a task deleted before the metadata
 * was written) so the caller can fall back to the generic tool row.
 */
export function readPresentedTask(metadata: Record<string, unknown> | undefined): PresentedTask | undefined {
  const value = isRecord(metadata?.presentedTask) ? metadata.presentedTask : undefined
  if (!value) return undefined
  if (typeof value.id !== "string" || !value.id) return undefined
  const title = optionalText(value.title) ?? value.id
  const time = isRecord(value.time) ? value.time : {}

  if (value.kind === "project_task" && PROJECT_STATUSES.has(String(value.status))) {
    const progress = isRecord(value.progress) ? value.progress : {}
    return {
      kind: "project_task",
      id: value.id,
      title,
      status: value.status as PresentedProjectTask["status"],
      progress: {
        total: numberOr(progress.total, 0),
        completed: numberOr(progress.completed, 0),
        inProgress: numberOr(progress.inProgress, 0),
        pending: numberOr(progress.pending, 0),
        cancelled: numberOr(progress.cancelled, 0),
      },
      sessionCount: numberOr(value.sessionCount, 0),
      descriptionPath: optionalText(value.descriptionPath) ?? "",
      prdExcerpt: optionalText(value.prdExcerpt),
      time: { created: numberOr(time.created, 0), updated: numberOr(time.updated, 0) },
    }
  }

  if (value.kind === "scheduled_task" && SCHEDULED_STATUSES.has(String(value.status))) {
    const schedule = isRecord(value.schedule) ? value.schedule : undefined
    if (!schedule) return undefined
    if (schedule.kind !== "at" && schedule.kind !== "every" && schedule.kind !== "cron") return undefined
    const model = isRecord(value.model) ? value.model : undefined
    return {
      kind: "scheduled_task",
      id: value.id,
      title,
      status: String(value.status),
      schedule: schedule as PresentedScheduledTask["schedule"],
      enabled: value.enabled !== false,
      nextRunAt: typeof value.nextRunAt === "number" ? value.nextRunAt : undefined,
      lastRunAt: typeof value.lastRunAt === "number" ? value.lastRunAt : undefined,
      lastStatus: optionalText(value.lastStatus),
      agent: optionalText(value.agent) ?? "",
      model: model
        ? {
            providerID: optionalText(model.providerID) ?? "",
            modelID: optionalText(model.modelID) ?? "",
            variant: optionalText(model.variant),
          }
        : undefined,
      promptExcerpt: optionalText(value.promptExcerpt),
      time: { created: numberOr(time.created, 0), updated: numberOr(time.updated, 0) },
    }
  }

  return undefined
}

export function presentedTaskTone(task: PresentedTask | undefined) {
  if (!task) return "neutral"
  if (task.kind === "project_task") {
    if (task.status === "done") return "success"
    if (task.status === "in_progress") return "active"
    if (task.status === "archived") return "muted"
    return "neutral"
  }
  if (task.status === "ok") return "success"
  if (task.status === "error" || task.status === "missed") return "danger"
  if (task.status === "running" || task.status === "retrying") return "active"
  if (task.status === "disabled" || task.status === "skipped") return "muted"
  return "neutral"
}

export function presentedTaskProgressPercent(progress: PresentedProjectTask["progress"]) {
  if (progress.total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((progress.completed + progress.cancelled) / progress.total) * 100)))
}

export function formatPresentedTaskDate(value: number | undefined, locale: string) {
  if (!value) return undefined
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

export function formatPresentedTaskSchedule(
  schedule: PresentedScheduledTask["schedule"],
  t: (key: UiI18nKey, params?: Record<string, string | number>) => string,
) {
  if (schedule.kind === "every")
    return t("ui.presentedTask.schedule.every", { count: Math.round(schedule.interval / 60_000) })
  if (schedule.kind === "at") return t("ui.presentedTask.schedule.at")
  return `${schedule.expression}${schedule.timezone ? ` · ${schedule.timezone}` : ""}`
}

export function presentedTaskStatusLabel(
  task: PresentedTask,
  t: (key: UiI18nKey, params?: Record<string, string | number>) => string,
) {
  if (task.kind === "project_task") return t(PROJECT_STATUS_KEYS[task.status])
  const key = `ui.presentedTask.status.${task.status}` as UiI18nKey
  return SCHEDULED_STATUSES.has(task.status) ? t(key) : task.status
}

export function PresentedTaskCard(props: PresentedTaskCardProps): JSX.Element {
  const data = useData()
  const i18n = useI18n()
  const task = createMemo(() => readPresentedTask(props.metadata))
  const project = createMemo(() => (task()?.kind === "project_task" ? (task() as PresentedProjectTask) : undefined))
  const scheduled = createMemo(() =>
    task()?.kind === "scheduled_task" ? (task() as PresentedScheduledTask) : undefined,
  )
  const failed = () => props.status === "error" || !!props.error

  const open = () => {
    const value = task()
    if (!value) return
    console.debug(`[presented-task] open session=${props.sessionID} kind=${value.kind} task=${value.id}`)
    data.openTask?.({ sessionID: props.sessionID, kind: value.kind, taskID: value.id })
  }

  const date = (value: number | undefined) => formatPresentedTaskDate(value, i18n.locale())

  return (
    <Show when={failed() ? undefined : task()}>
      {(value) => (
        <article
          class="presented-task-card"
          data-component="presented-task-card"
          data-task-kind={value().kind}
          data-task-status={value().status}
          data-task-tone={presentedTaskTone(value())}
          data-task-id={value().id}
        >
          <Show when={!!data.openTask}>
            <button
              type="button"
              class="presented-task-card__open"
              aria-label={`${i18n.t("ui.presentedTask.open")} ${value().title}`}
              onClick={open}
            />
          </Show>
          <header class="presented-task-card__header">
            <div class="presented-task-card__heading-row">
              <Icon
                name={value().kind === "project_task" ? "checklist" : "clock"}
                size="normal"
                class="presented-task-card__icon"
              />
              <div class="presented-task-card__heading">
                <span class="presented-task-card__kind">
                  {i18n.t(
                    value().kind === "project_task"
                      ? "ui.presentedTask.kind.project"
                      : "ui.presentedTask.kind.scheduled",
                  )}
                </span>
                <strong class="presented-task-card__title" title={value().title}>
                  {value().title}
                </strong>
              </div>
            </div>
            <span class="presented-task-card__status">{presentedTaskStatusLabel(value(), i18n.t)}</span>
          </header>

          <Show when={project()}>
            {(item) => (
              <>
                <Show when={item().prdExcerpt}>
                  <pre class="presented-task-card__excerpt">{item().prdExcerpt}</pre>
                </Show>
                <Show when={item().descriptionPath}>
                  <footer class="presented-task-card__footer">
                    <span class="presented-task-card__path" title={item().descriptionPath}>
                      {item().descriptionPath}
                    </span>
                  </footer>
                </Show>
                <div class="presented-task-card__metrics">
                  <div
                    class="presented-task-card__bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={item().progress.total}
                    aria-valuenow={item().progress.completed + item().progress.cancelled}
                    aria-label={i18n.t("ui.presentedTask.progress")}
                  >
                    <span style={{ width: `${presentedTaskProgressPercent(item().progress)}%` }} />
                  </div>
                  <span class="presented-task-card__metric">
                    {i18n.t("ui.presentedTask.completed", {
                      completed: item().progress.completed + item().progress.cancelled,
                      total: item().progress.total,
                    })}
                  </span>
                  <Show when={item().progress.inProgress > 0}>
                    <span class="presented-task-card__metric">
                      {i18n.t("ui.presentedTask.inProgress", { count: item().progress.inProgress })}
                    </span>
                  </Show>
                  <span class="presented-task-card__metric">
                    {i18n.t(
                      item().sessionCount === 1 ? "ui.presentedTask.sessions.one" : "ui.presentedTask.sessions.other",
                      {
                        count: item().sessionCount,
                      },
                    )}
                  </span>
                </div>
              </>
            )}
          </Show>

          <Show when={scheduled()}>
            {(item) => (
              <>
                <Show when={item().promptExcerpt}>
                  <pre class="presented-task-card__excerpt">{item().promptExcerpt}</pre>
                </Show>
                <footer class="presented-task-card__footer">
                  <Show when={item().agent}>
                    <span class="presented-task-card__path">{item().agent}</span>
                  </Show>
                  <Show when={item().model?.modelID}>
                    <span class="presented-task-card__path">
                      {`${item().model!.providerID}/${item().model!.modelID}`}
                    </span>
                  </Show>
                  <Show when={!item().enabled}>
                    <span class="presented-task-card__path">{i18n.t("ui.presentedTask.status.disabled")}</span>
                  </Show>
                </footer>
                <div class="presented-task-card__metrics">
                  <span class="presented-task-card__metric">
                    {formatPresentedTaskSchedule(item().schedule, i18n.t)}
                  </span>
                  <Show when={item().enabled && item().nextRunAt}>
                    <span class="presented-task-card__metric">
                      {`${i18n.t("ui.presentedTask.nextRun")} ${date(item().nextRunAt)}`}
                    </span>
                  </Show>
                  <Show when={item().lastRunAt}>
                    <span class="presented-task-card__metric">
                      {`${i18n.t("ui.presentedTask.lastRun")} ${date(item().lastRunAt)}`}
                    </span>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </article>
      )}
    </Show>
  )
}
