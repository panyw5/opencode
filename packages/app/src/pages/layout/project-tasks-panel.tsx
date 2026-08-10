import type { ProjectTask, ProjectTaskDetail, ProjectTaskStatus } from "@opencode-ai/sdk/v2/client"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogPromptEditor } from "@/components/dialog-prompt-editor"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { errorMessage } from "./helpers"
import {
  Empty,
  ErrorCard,
  TaskCardActionButton,
  TaskCardShell,
  TaskPanelShell,
  labelStatus,
  progressKindForStatus,
} from "./task-panel-shared"

const progressText = (task: Pick<ProjectTask, "progress">) => {
  const { completed, total, inProgress } = task.progress
  if (total === 0) return "0 todos"
  return `${completed}/${total}${inProgress ? ` · ${inProgress} active` : ""}`
}

type NewProjectTaskDraft = {
  name: string
  content: string
}

const newProjectTaskDraftKey = (directory: string) =>
  `opencode.project-task.new-draft:${checksum(directory) ?? "default"}`

function readNewProjectTaskDraft(directory: string): NewProjectTaskDraft {
  if (typeof localStorage === "undefined") return { name: "", content: "" }
  try {
    const raw = localStorage.getItem(newProjectTaskDraftKey(directory))
    if (!raw) return { name: "", content: "" }
    const parsed = JSON.parse(raw) as Partial<NewProjectTaskDraft>
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
    }
  } catch {
    return { name: "", content: "" }
  }
}

function writeNewProjectTaskDraft(directory: string, draft: NewProjectTaskDraft) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(newProjectTaskDraftKey(directory), JSON.stringify(draft))
  } catch {
    /* ignore */
  }
}

function removeNewProjectTaskDraft(directory: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(newProjectTaskDraftKey(directory))
  } catch {
    /* ignore */
  }
}

function NewProjectTaskDialog(props: {
  directory: string
  onCreate: (name: string, content: string) => Promise<void>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
}): JSX.Element {
  const language = useLanguage()
  const initialDraft = readNewProjectTaskDraft(props.directory)
  const [name, setName] = createSignal(initialDraft.name)
  const [content, setContent] = createSignal(initialDraft.content)
  const [nameError, setNameError] = createSignal<string | undefined>()

  const persistDraft = (next: Partial<NewProjectTaskDraft>) => {
    writeNewProjectTaskDraft(props.directory, {
      name: next.name ?? name(),
      content: next.content ?? content(),
    })
  }

  const save = async (body: string) => {
    const title = name().trim()
    if (!title) {
      const message = language.t("projectTask.error.titleRequired")
      setNameError(message)
      throw new Error(message)
    }
    setNameError(undefined)
    await props.onCreate(title, body)
    removeNewProjectTaskDraft(props.directory)
  }

  return (
    <DialogPromptEditor
      text={initialDraft.content}
      placeholder={language.t("projectTask.field.descriptionPlaceholder")}
      title={language.t("projectTask.create")}
      description={language.t("projectTask.subtitle")}
      saveOnClose={false}
      saveLabel={language.t("projectTask.create")}
      searchFilesAndDirectories={props.searchFilesAndDirectories}
      onTextChange={(value) => {
        setContent(value)
        persistDraft({ content: value })
      }}
      onDiscard={() => removeNewProjectTaskDraft(props.directory)}
      save={save}
      before={
        <label class="flex shrink-0 flex-col gap-2">
          <span class="text-12-medium text-text-base">{language.t("projectTask.field.title")}</span>
          <input
            value={name()}
            autofocus
            spellcheck={false}
            class="h-10 rounded-lg border border-border-weak-base bg-background-base px-3 text-14-regular text-text-strong outline-none transition-colors placeholder:text-text-weak focus:border-border-focus disabled:cursor-not-allowed disabled:opacity-60"
            classList={{ "border-border-critical-base": !!nameError() }}
            placeholder={language.t("projectTask.field.titlePlaceholder")}
            onInput={(event) => {
              const value = event.currentTarget.value
              setName(value)
              persistDraft({ name: value })
              if (nameError()) setNameError(undefined)
            }}
          />
          <Show when={nameError()}>
            {(message) => <span class="text-12-regular text-text-danger-base">{message()}</span>}
          </Show>
        </label>
      }
    />
  )
}

function projectTaskStatusLabel(status: ProjectTaskStatus, t: ReturnType<typeof useLanguage>["t"]): string {
  if (status === "open") return t("projectTask.status.open")
  if (status === "in_progress") return t("projectTask.status.inProgress")
  if (status === "done") return t("projectTask.status.done")
  if (status === "archived") return t("projectTask.status.archived")
  return labelStatus(status)
}

function ProjectTaskCard(props: {
  task: ProjectTask
  onOpen: (task: ProjectTask) => void
  onArchive: (task: ProjectTask) => void | Promise<void>
  onSetInProgress: (task: ProjectTask) => void | Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const [pending, setPending] = createSignal<"status" | "archive" | undefined>()
  const canAct = createMemo(() => pending() === undefined)
  const progressKind = createMemo(() =>
    progressKindForStatus(props.task.status, {
      completedAt: props.task.time.archived != null ? String(props.task.time.archived) : null,
    }),
  )
  // Last-row chips: task status (lifecycle) + session-todo progress + session count.
  // Status and todo progress are intentionally separate (multi-session work).
  const meta = createMemo(() => {
    const items: string[] = [
      projectTaskStatusLabel(props.task.status, language.t),
      progressText(props.task),
    ]
    if (props.task.sessionCount > 0) {
      items.push(language.t("projectTask.sessions.count", { count: props.task.sessionCount }))
    }
    return items
  })
  // "In progress" is only meaningful for open tasks — hide when already in_progress/done/archived.
  const canSetInProgress = createMemo(
    () => props.task.status === "open" && canAct(),
  )

  return (
    <TaskCardShell
      data-component="project-task-item"
      title={props.task.title}
      subtitle={props.task.description.trim() || undefined}
      progressKind={progressKind()}
      meta={meta()}
      onOpen={() => props.onOpen(props.task)}
      actions={
        <>
          <Show when={canSetInProgress() || pending() === "status"}>
            <TaskCardActionButton
              disabled={!canSetInProgress()}
              onClick={() => {
                setPending("status")
                Promise.resolve(props.onSetInProgress(props.task)).finally(() => setPending(undefined))
              }}
            >
              {pending() === "status"
                ? language.t("common.loading")
                : language.t("projectTask.status.inProgress")}
            </TaskCardActionButton>
          </Show>
          <TaskCardActionButton
            danger
            disabled={!canAct() || props.task.status === "archived"}
            onClick={() => {
              setPending("archive")
              Promise.resolve(props.onArchive(props.task)).finally(() => setPending(undefined))
            }}
          >
            {pending() === "archive" ? language.t("common.loading") : language.t("projectTask.archive")}
          </TaskCardActionButton>
        </>
      }
    />
  )
}

function ProjectTaskDetailDialog(props: {
  task: ProjectTask
  directory: string
  client: ReturnType<ReturnType<typeof useGlobalSDK>["createClient"]>
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const dialogKey = createMemo(() => props.task.id)
  const [maximized, setMaximized] = createSignal(false)
  const [titleCopied, setTitleCopied] = createSignal(false)
  let titleCopiedTimer: ReturnType<typeof setTimeout> | undefined
  const [state, setState] = createStore({
    detail: undefined as ProjectTaskDetail | undefined,
    loading: true,
    pending: false,
    error: "",
    mode: "preview" as "preview" | "edit",
    draft: props.task.description,
    dirty: false,
    saved: props.task.description,
  })

  const detail = createMemo(() => state.detail)
  const title = createMemo(() => detail()?.title ?? props.task.title)
  const status = createMemo(() => detail()?.status ?? props.task.status)
  // Prefer flex fill over fixed vh math: dialog-content only had max-height, so
  // calc(90vh - Npx) children either overflowed or collapsed to the textarea default (2 rows).
  const dialogContainerStyle = createMemo(() =>
    maximized()
      ? {
          width: "90vw",
          "max-width": "90vw",
          height: "95vh",
          "max-height": "95vh",
        }
      : {
          width: "min(calc(100vw - 32px), 960px)",
          height: "min(calc(100vh - 32px), 85vh)",
          "max-height": "min(calc(100vh - 32px), 85vh)",
        },
  )

  async function load() {
    setState({ loading: true, error: "" })
    try {
      const result = await props.client.projectTask.detail({ taskID: props.task.id })
      if (result.data) {
        setState({
          detail: result.data,
          draft: result.data.description,
          saved: result.data.description,
          dirty: false,
        })
      }
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("loading", false)
    }
  }

  async function archive() {
    if (!window.confirm(language.t("projectTask.archive.confirm", { title: props.task.title }))) return
    setState({ pending: true, error: "" })
    try {
      await props.client.projectTask.archive({ taskID: props.task.id })
      await props.onChanged()
      dialog.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      setState("pending", false)
    }
  }

  async function saveDescription(options?: { preview?: boolean }) {
    if (!state.dirty && state.draft === state.saved) {
      if (options?.preview) setState("mode", "preview")
      return true
    }
    setState({ pending: true, error: "" })
    try {
      const result = await props.client.projectTask.update({
        taskID: props.task.id,
        projectTaskUpdateInput: { description: state.draft },
      })
      if (result.data) {
        setState("detail", {
          ...(state.detail ?? result.data),
          ...result.data,
          sessions: state.detail?.sessions ?? [],
        })
      }
      setState({ dirty: false, saved: state.draft, mode: options?.preview ? "preview" : state.mode })
      await props.onChanged()
      return true
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setState("pending", false)
    }
  }

  async function setStatus(next: ProjectTaskStatus) {
    setState({ pending: true, error: "" })
    try {
      const result = await props.client.projectTask.update({
        taskID: props.task.id,
        projectTaskUpdateInput: { status: next },
      })
      if (result.data && state.detail) {
        setState("detail", { ...state.detail, ...result.data, sessions: state.detail.sessions })
      } else if (result.data) {
        setState("detail", { ...result.data, sessions: [] })
      }
      await props.onChanged()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", false)
    }
  }

  function openSession(sessionID: string) {
    dialog.close()
    navigate(`/${base64Encode(props.directory)}/session/${sessionID}`)
  }

  const copyTitle = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(title()).then(() => {
      setTitleCopied(true)
      if (titleCopiedTimer) clearTimeout(titleCopiedTimer)
      titleCopiedTimer = setTimeout(() => setTitleCopied(false), 1200)
    })
  }

  const enterEdit = () => {
    setState({
      mode: "edit",
      draft: detail()?.description ?? props.task.description,
      dirty: false,
    })
  }

  const saveAndPreview = async () => {
    const ok = await saveDescription({ preview: true })
    if (ok) setState("mode", "preview")
  }

  const closeDialog = async () => {
    if (state.mode === "edit" && state.dirty) {
      const ok = await saveDescription()
      if (!ok) return
    }
    dialog.close()
  }

  onMount(() => void load())
  onCleanup(() => {
    if (titleCopiedTimer) clearTimeout(titleCopiedTimer)
  })

  return (
    <>
      {/* Attribute-only selector: task IDs can contain CSS-special chars that break value matchers. */}
      <style
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={`
          [data-component="dialog"][data-project-task-dialog] [data-slot="dialog-container"] {
            display: flex;
            flex-direction: column;
          }
          [data-component="dialog"][data-project-task-dialog] [data-slot="dialog-content"] {
            height: 100% !important;
            max-height: 100% !important;
            overflow: hidden !important;
          }
          [data-component="dialog"][data-project-task-dialog] [data-slot="dialog-body"] {
            min-height: 0;
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
          }
        `}
      />
      <Dialog
        title={
          <div class="flex min-w-0 items-center gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 truncate">{title()}</span>
                <Tooltip
                  placement="bottom"
                  value={titleCopied() ? language.t("session.share.copy.copied") : language.t("trellis.tasks.copyTitle")}
                >
                  <IconButton
                    icon={titleCopied() ? "check" : "copy"}
                    variant="ghost"
                    size="large"
                    aria-label={
                      titleCopied()
                        ? language.t("session.share.copy.copied")
                        : language.t("trellis.tasks.copyTitle")
                    }
                    onClick={copyTitle}
                  />
                </Tooltip>
              </div>
              <div class="mt-0.5 truncate text-12-regular text-text-weak">
                {labelStatus(status())} · {progressText(detail() ?? props.task)}
              </div>
            </div>
          </div>
        }
        size="x-large"
        transition
        containerStyle={dialogContainerStyle()}
        data-project-task-dialog={dialogKey()}
        data-maximized={maximized() ? "" : undefined}
        action={
          <div class="flex items-center gap-2">
            <div
              role="group"
              class="flex items-center rounded-lg border border-border-weak-base bg-background-stronger p-0.5"
            >
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "bg-background-base text-text-strong shadow-sm": state.mode === "preview",
                  "text-text-base hover:text-text-strong": state.mode !== "preview",
                }}
                onClick={() => void saveAndPreview()}
              >
                <Icon name="eye" size="small" />
                {language.t("trellis.tasks.preview")}
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "bg-background-base text-text-strong shadow-sm": state.mode === "edit",
                  "text-text-base hover:text-text-strong": state.mode !== "edit",
                }}
                onClick={enterEdit}
              >
                <Icon name="edit" size="small" />
                {language.t("trellis.tasks.edit")}
              </button>
            </div>
            <Tooltip placement="bottom" value={language.t("projectTask.archive")}>
              <IconButton
                icon="archive"
                variant="ghost"
                size="large"
                disabled={state.pending}
                aria-label={language.t("projectTask.archive")}
                onClick={() => void archive()}
              />
            </Tooltip>
            <Tooltip
              placement="bottom"
              value={maximized() ? language.t("trellis.tasks.restore") : language.t("trellis.tasks.maximize")}
            >
              <IconButton
                icon={maximized() ? "collapse" : "expand"}
                variant="ghost"
                size="large"
                aria-label={maximized() ? language.t("trellis.tasks.restore") : language.t("trellis.tasks.maximize")}
                onClick={() => setMaximized((v) => !v)}
              />
            </Tooltip>
            <Tooltip placement="bottom" value={language.t("trellis.tasks.close")}>
              <IconButton
                icon="close"
                variant="ghost"
                size="large"
                aria-label={language.t("trellis.tasks.close")}
                onClick={() => void closeDialog()}
              />
            </Tooltip>
          </div>
        }
      >
        <div data-component="project-task-detail" class="flex h-full min-h-0 flex-1 flex-col gap-3 p-4">
          <Show when={state.error}>{(err) => <ErrorCard err={err()} />}</Show>

          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <For each={["open", "in_progress", "done"] as ProjectTaskStatus[]}>
              {(value) => (
                <button
                  type="button"
                  class="rounded-full border px-3 py-1 text-12-medium transition-colors"
                  classList={{
                    "border-border-brand-base bg-surface-interactive-selected/40 text-text-strong": status() === value,
                    "border-border-weak-base bg-background-base text-text-base hover:bg-surface-base-hover":
                      status() !== value,
                  }}
                  disabled={state.pending || state.loading}
                  onClick={() => void setStatus(value)}
                >
                  {labelStatus(value)}
                </button>
              )}
            </For>
            <span class="ml-auto text-12-regular text-text-weak">
              {language.t("projectTask.sessions.count", {
                count: detail()?.sessionCount ?? props.task.sessionCount,
              })}
            </span>
          </div>

          <div
            class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base shadow-xs-border-base"
            classList={{ "border-border-focus": state.mode === "edit" }}
          >
            <Show when={state.loading}>
              <div class="flex flex-1 items-center justify-center gap-2 text-12-regular text-text-weak">
                <Spinner />
                {language.t("projectTask.loading")}
              </div>
            </Show>
            <Show when={!state.loading}>
              <Show
                when={state.mode === "preview"}
                fallback={
                  <textarea
                    value={state.draft}
                    autofocus
                    spellcheck={false}
                    placeholder={language.t("projectTask.field.descriptionPlaceholder")}
                    class="box-border h-full min-h-0 w-full flex-1 resize-none bg-transparent px-5 py-4 text-14-regular text-text-strong outline-none"
                    onInput={(event) => {
                      const next = event.currentTarget.value
                      setState({ draft: next, dirty: next !== state.saved })
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault()
                        void saveDescription()
                      }
                      if (event.key === "Escape") {
                        event.preventDefault()
                        void saveAndPreview()
                      }
                    }}
                  />
                }
              >
                <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" style={{ transform: "translateZ(0)" }}>
                  <Show
                    when={(detail()?.description ?? props.task.description).trim()}
                    fallback={<Empty text={language.t("projectTask.noDescription")} />}
                  >
                    <Markdown text={detail()?.description ?? props.task.description} />
                  </Show>
                </div>
              </Show>
            </Show>
          </div>

          <Show when={state.mode === "edit"}>
            <div class="flex shrink-0 items-center justify-between gap-3">
              <div class="flex items-center gap-2 text-11-regular text-text-weak">
                <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">⌘</span>
                <span>+</span>
                <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">
                  {language.t("common.key.enter")}
                </span>
                <span>{language.t("trellis.tasks.save")}</span>
                <span class="mx-1 text-text-subtle">·</span>
                <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">Esc</span>
                <span>{language.t("trellis.tasks.saveAndPreview")}</span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-md border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base-hover disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={state.pending}
                  onClick={() => void saveAndPreview()}
                >
                  {language.t("trellis.tasks.preview")}
                </button>
                <button
                  type="button"
                  class="rounded-md bg-surface-interactive-base px-4 py-1.5 text-12-medium text-text-on-interactive transition-colors hover:bg-surface-interactive-base-hover disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={state.pending || !state.dirty}
                  onClick={() => void saveDescription()}
                >
                  {state.pending ? language.t("trellis.tasks.saving") : language.t("trellis.tasks.save")}
                </button>
              </div>
            </div>
          </Show>

          <Show when={state.mode === "preview" ? detail() : undefined}>
            {(task) => (
              <section class="flex max-h-[28vh] min-h-0 shrink-0 flex-col gap-2 overflow-hidden">
                <div class="text-12-medium text-text-base">
                  {language.t("projectTask.sessions.title")} ({task().sessionCount})
                </div>
                <Show
                  when={task().sessions.length > 0}
                  fallback={
                    <div class="text-12-regular text-text-weaker">{language.t("projectTask.sessions.empty")}</div>
                  }
                >
                  <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    <For each={task().sessions}>
                      {(session) => (
                        <div class="rounded-xl border border-border-weak-base bg-background-stronger px-3 py-2">
                          <button
                            type="button"
                            class="flex w-full items-center justify-between gap-2 text-left"
                            onClick={() => openSession(session.sessionID)}
                          >
                            <div class="min-w-0">
                              <div class="truncate text-13-medium text-text-strong">{session.title}</div>
                              <div class="text-11-regular text-text-weak">
                                {progressText(session)} · {session.todos.length} todos
                              </div>
                            </div>
                            <Icon name="arrow-right" size="small" class="text-icon-weak" />
                          </button>
                          <Show when={session.todos.length > 0}>
                            <ul class="mt-2 flex flex-col gap-1 border-t border-border-weaker-base pt-2">
                              <For each={session.todos}>
                                {(todo) => (
                                  <li class="flex items-start gap-2 text-12-regular text-text-base">
                                    <span
                                      class="mt-1 size-1.5 shrink-0 rounded-full"
                                      classList={{
                                        "bg-icon-success-base": todo.status === "completed",
                                        "bg-icon-brand-base": todo.status === "in_progress",
                                        "bg-icon-weak": todo.status === "pending",
                                        "bg-icon-critical-base": todo.status === "cancelled",
                                      }}
                                    />
                                    <span class="min-w-0 flex-1">{todo.content}</span>
                                    <span class="shrink-0 text-11-regular text-text-weaker">
                                      {labelStatus(todo.status)}
                                    </span>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </Show>
        </div>
      </Dialog>
    </>
  )
}

export function ProjectTasksPanel(props: {
  directory: Accessor<string>
  width: Accessor<number>
  mobile?: boolean
  onBack: () => void
}): JSX.Element {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const dir = createMemo(() => props.directory())
  const client = createMemo(() =>
    globalSDK.createClient({ directory: dir().replace(/\\/g, "/"), throwOnError: true }),
  )
  const [state, setState] = createStore({ tasks: [] as ProjectTask[], loading: true, error: "" })
  let request = 0

  async function load(options?: { silent?: boolean }) {
    const current = ++request
    if (!dir()) {
      setState({ tasks: [], loading: false, error: "" })
      return
    }
    if (!options?.silent) setState({ loading: true, error: "" })
    try {
      const result = await client().projectTask.list({})
      if (current !== request) return
      setState({ tasks: result.data ?? [], error: "" })
    } catch (error) {
      if (current !== request) return
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      if (current !== request) return
      setState("loading", false)
    }
  }

  function open(task: ProjectTask) {
    dialog.show(() => (
      <ProjectTaskDetailDialog
        task={task}
        directory={dir()}
        client={client()}
        onChanged={() => load({ silent: true })}
      />
    ))
  }

  async function archive(task: ProjectTask) {
    if (!window.confirm(language.t("projectTask.archive.confirm", { title: task.title }))) return
    try {
      await client().projectTask.archive({ taskID: task.id })
      await load({ silent: true })
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }

  async function setInProgress(task: ProjectTask) {
    try {
      await client().projectTask.update({
        taskID: task.id,
        projectTaskUpdateInput: { status: "in_progress" },
      })
      await load({ silent: true })
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }

  const createTask = async (name: string, content: string) => {
    await client().projectTask.create({
      projectTaskCreateInput: {
        title: name,
        description: content,
        status: "open",
      },
    })
    await load({ silent: true })
  }

  const newTask = () => {
    const root = dir()
    if (!root) return
    const searchFilesAndDirectories = async (query: string) => {
      const result = await client().find.files({ query, dirs: "true" })
      return result.data ?? []
    }
    dialog.show(() => (
      <NewProjectTaskDialog
        directory={root}
        onCreate={createTask}
        searchFilesAndDirectories={searchFilesAndDirectories}
      />
    ))
  }

  createEffect(() => {
    dir()
    void load()
  })

  const stop = globalSDK.listenAll((event) => {
    if (!event.details.type.startsWith("project-task.")) return
    void load({ silent: true })
  })
  onCleanup(stop)

  const tasks = createMemo(() =>
    state.tasks.slice().sort((a, b) => {
      const rank = (status: ProjectTaskStatus) => {
        if (status === "in_progress") return 0
        if (status === "open") return 1
        if (status === "done") return 2
        return 3
      }
      return rank(a.status) - rank(b.status) || b.time.updated - a.time.updated
    }),
  )

  return (
    <TaskPanelShell
      data-panel="project-tasks"
      mobile={props.mobile}
      width={props.width}
      title={language.t("projectTask.title")}
      backLabel={language.t("projectTask.back")}
      onBack={props.onBack}
      newLabel={language.t("projectTask.create")}
      onNew={newTask}
      newDisabled={!dir()}
      refreshLabel={language.t("projectTask.refresh")}
      onRefresh={() => void load()}
      refreshDisabled={!dir() || state.loading}
    >
      <Show when={dir()} fallback={<Empty text={language.t("projectTask.empty")} />}>
        <Show when={!state.loading} fallback={<Empty text={language.t("projectTask.loading")} />}>
          <Show when={!state.error} fallback={<ErrorCard err={state.error} />}>
            <Show when={tasks().length > 0} fallback={<Empty text={language.t("projectTask.empty")} />}>
              <div class="flex flex-col gap-2">
                <For each={tasks()}>
                  {(task) => (
                    <ProjectTaskCard
                      task={task}
                      onOpen={open}
                      onArchive={archive}
                      onSetInProgress={setInProgress}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </TaskPanelShell>
  )
}
