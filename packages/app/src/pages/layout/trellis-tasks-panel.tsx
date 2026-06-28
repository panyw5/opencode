import { createEffect, createResource, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Markdown } from "@opencode-ai/ui/markdown"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import { usePlatform, type TrellisTask } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogPromptEditor } from "@/components/dialog-prompt-editor"
import { paint } from "@/components/prompt-input/expand"
import { monoFontFamily, useSettings } from "@/context/settings"
import { errorMessage } from "./helpers"

const labelStatus = (status: string) =>
  status
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown"

const meta = (task: TrellisTask) =>
  [task.priority, task.assignee, task.package].filter((item): item is string => !!item)

const rank = (task: TrellisTask) => {
  if (task.current) return 0
  if (task.status === "in_progress" || task.status === "implementing") return 1
  if (task.status === "planning") return 2
  if (task.status === "review") return 3
  if (task.completedAt || task.status === "done" || task.status === "completed") return 5
  return 4
}

const progressIcon = (task: TrellisTask): IconName => {
  if (task.completedAt || task.status === "done" || task.status === "completed") return "progress-complete"
  if (task.status === "review") return "progress-three-quarter"
  if (task.status === "in_progress" || task.status === "implementing") return "progress-half"
  if (task.status === "planning") return "progress-quarter"
  return "progress-empty"
}

const progressColor = (task: TrellisTask): string => {
  if (task.completedAt || task.status === "done" || task.status === "completed") return "text-icon-success-base"
  if (task.status === "review") return "text-icon-warning-base"
  if (task.status === "in_progress" || task.status === "implementing") return "text-icon-brand-base"
  if (task.status === "planning") return "text-icon-info-base"
  return "text-icon-base"
}

function NewTrellisTaskDialog(props: {
  onCreate: (name: string, content: string) => Promise<void>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
}): JSX.Element {
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [nameError, setNameError] = createSignal<string | undefined>()

  const save = async (content: string) => {
    const title = name().trim()
    if (!title) {
      const message = language.t("trellis.tasks.new.nameRequired")
      setNameError(message)
      throw new Error(message)
    }
    setNameError(undefined)
    await props.onCreate(title, content)
  }

  return (
    <DialogPromptEditor
      text=""
      placeholder={language.t("trellis.tasks.new.prdPlaceholder")}
      title={language.t("trellis.tasks.new.title")}
      description={language.t("trellis.tasks.new.description")}
      saveOnClose={false}
      saveLabel={language.t("trellis.tasks.new.save")}
      searchFilesAndDirectories={props.searchFilesAndDirectories}
      save={save}
      before={
        <label class="flex shrink-0 flex-col gap-2">
          <span class="text-12-medium text-text-base">{language.t("trellis.tasks.new.nameLabel")}</span>
          <input
            value={name()}
            autofocus
            spellcheck={false}
            class="h-10 rounded-lg border border-border-weak-base bg-background-base px-3 text-14-regular text-text-strong outline-none transition-colors placeholder:text-text-weak focus:border-border-focus disabled:cursor-not-allowed disabled:opacity-60"
            classList={{ "border-border-critical-base": !!nameError() }}
            placeholder={language.t("trellis.tasks.new.namePlaceholder")}
            onInput={(event) => {
              setName(event.currentTarget.value)
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

function TaskCard(props: {
  task: TrellisTask
  onOpen: (path: string) => void | Promise<void>
  onSetCurrent: (task: TrellisTask) => void | Promise<void>
  onArchive: (task: TrellisTask) => void | Promise<void>
}): JSX.Element {
  const language = useLanguage()
  const [pending, setPending] = createSignal<"current" | "archive" | undefined>()
  const done = createMemo(
    () => props.task.completedAt || props.task.status === "done" || props.task.status === "completed",
  )
  const items = createMemo(() => meta(props.task))
  const folderName = createMemo(() => getFilename(props.task.path))
  const icon = createMemo(() => progressIcon(props.task))
  const iconColor = createMemo(() => progressColor(props.task))
  const canAct = createMemo(() => pending() === undefined)

  const onKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    void props.onOpen(props.task.path)
  }

  const setCurrent: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.stopPropagation()
    setPending("current")
    Promise.resolve(props.onSetCurrent(props.task)).finally(() => {
      setPending(undefined)
    })
  }

  const archive: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    event.stopPropagation()
    setPending("archive")
    Promise.resolve(props.onArchive(props.task)).finally(() => {
      setPending(undefined)
    })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class="group/task w-full rounded-xl border border-border-weak-base bg-background-stronger px-3 py-3 text-left transition-colors hover:bg-surface-base-hover"
      classList={{ "border-border-brand-base bg-surface-interactive-selected/40": props.task.current }}
      onClick={() => props.onOpen(props.task.path)}
      onKeyDown={onKeyDown}
    >
      <div class="flex items-start gap-3">
        <div
          class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border-weak-base bg-background-base"
          classList={{ [iconColor()]: true, "text-icon-brand-base": props.task.current }}
        >
          <Icon name={icon()} size="small" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="min-w-0 truncate text-14-medium text-text-strong">{folderName()}</div>
            <span class="shrink-0 rounded-full bg-surface-base/20 px-2 py-0.5 text-11-medium text-text-base">
              {props.task.worktreeName}
            </span>
            <Show when={props.task.current}>
              <span class="shrink-0 rounded-full bg-surface-info-base px-2 py-0.5 text-11-medium text-text-strong">
                {language.t("trellis.tasks.current")}
              </span>
            </Show>
          </div>
          <div class="mt-1 truncate text-12-regular text-text-base">{props.task.title}</div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-12-regular">
            <span class="rounded-md bg-surface-base/20 px-1.5 py-0.5 text-text-strong">
              {labelStatus(props.task.status)}
            </span>
            <For each={items()}>
              {(item) => <span class="rounded-md bg-surface-base/20 px-1.5 py-0.5 text-text-base">{item}</span>}
            </For>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              class="rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-medium text-text-base transition-colors hover:bg-surface-base-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={props.task.current || !canAct()}
              onClick={setCurrent}
            >
              {pending() === "current" ? language.t("common.loading") : language.t("trellis.tasks.setCurrent")}
            </button>
            <button
              type="button"
              class="rounded-md border px-2 py-1 text-12-medium transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                "background-color": "color-mix(in srgb, var(--surface-critical-base) 68%, var(--background-base))",
                "border-color": "color-mix(in srgb, var(--surface-critical-base) 72%, var(--background-base))",
                color: "var(--text-on-critical-base)",
              }}
              disabled={!canAct()}
              onClick={archive}
            >
              {pending() === "archive" ? language.t("common.loading") : language.t("trellis.tasks.archive")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PrdPreviewDialog(props: {
  name: string
  prdAbsPath: string
  initialContent: string | undefined
}): JSX.Element {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()
  const canWrite = createMemo(() => typeof platform.writeConfigFile === "function")
  const [mode, setMode] = createSignal<"preview" | "edit">("preview")
  const [draft, setDraft] = createSignal(props.initialContent ?? "")
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | undefined>()
  const [maximized, setMaximized] = createSignal(false)
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const html = createMemo(() => paint(draft()))
  const prdEditor = {
    box: undefined as HTMLTextAreaElement | undefined,
    back: undefined as HTMLDivElement | undefined,
  }
  const syncPrdScroll = () => {
    if (!prdEditor.box || !prdEditor.back) return
    prdEditor.back.scrollTop = prdEditor.box.scrollTop
    prdEditor.back.scrollLeft = prdEditor.box.scrollLeft
  }

  const editorH = createMemo(() => (maximized() ? "calc(95vh - 130px)" : "calc(90vh - 130px)"))

  const enterEdit = () => {
    if (!canWrite()) return
    setSaveError(undefined)
    setMode("edit")
  }

  const cancelEdit = () => {
    setDraft(props.initialContent ?? "")
    setDirty(false)
    setSaveError(undefined)
    setMode("preview")
  }

  const save = async () => {
    if (!canWrite() || saving()) return
    const writeConfigFile = platform.writeConfigFile!
    setSaving(true)
    setSaveError(undefined)
    try {
      await writeConfigFile(props.prdAbsPath, draft())
      setDirty(false)
      setMode("preview")
    } catch (err) {
      setSaveError(errorMessage(err, language.t("trellis.tasks.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  const onInput: JSX.EventHandlerUnion<HTMLTextAreaElement, Event> = (event) => {
    setDraft(event.currentTarget.value)
    setDirty(true)
    setSaveError(undefined)
  }

  const onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "Enter") {
      event.preventDefault()
      if (dirty() && !saving()) void save()
      return
    }
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      cancelEdit()
    }
  }

  return (
    <>
      <style
        data-prd-dialog-scope={props.name}
        innerHTML={`
          [data-component="dialog"][data-prd-dialog="${props.name}"] [data-slot="dialog-container"] {
            height: 90vh !important;
            max-height: 90vh !important;
          }
          [data-component="dialog"][data-prd-dialog="${props.name}"][data-maximized] [data-slot="dialog-container"] {
            width: 90vw !important;
            max-width: 90vw !important;
            height: 95vh !important;
            max-height: 95vh !important;
          }
        `}
      />
      <Dialog
        title={props.name}
        size="x-large"
        data-prd-dialog={props.name}
        data-maximized={maximized() ? "" : undefined}
        action={
        <div class="flex items-center gap-2">
          <Show when={canWrite() && typeof props.initialContent === "string"}>
            <div
              role="group"
              class="flex items-center rounded-lg border border-border-weak-base bg-background-stronger p-0.5"
            >
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "bg-background-base text-text-strong shadow-sm": mode() === "preview",
                  "text-text-base hover:text-text-strong": mode() !== "preview",
                }}
                onClick={() => setMode("preview")}
              >
                <Icon name="eye" size="small" />
                {language.t("trellis.tasks.preview")}
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-12-medium transition-colors"
                classList={{
                  "bg-background-base text-text-strong shadow-sm": mode() === "edit",
                  "text-text-base hover:text-text-strong": mode() !== "edit",
                }}
                onClick={enterEdit}
              >
                <Icon name="edit" size="small" />
                {language.t("trellis.tasks.edit")}
              </button>
            </div>
          </Show>
          <Show when={platform.openPath}>
            <Tooltip placement="bottom" value={language.t("trellis.tasks.openFolder")}>
              <IconButton
                icon="folder"
                variant="ghost"
                size="small"
                aria-label={language.t("trellis.tasks.openFolder")}
                onClick={() => void platform.openPath!(props.prdAbsPath.replace(/\/prd\.md$/i, ""))}
              />
            </Tooltip>
          </Show>
          <Tooltip
            placement="bottom"
            value={
              maximized()
                ? language.t("trellis.tasks.restore")
                : language.t("trellis.tasks.maximize")
            }
          >
            <IconButton
              icon={maximized() ? "collapse" : "expand"}
              variant="ghost"
              size="small"
              aria-label={
                maximized()
                  ? language.t("trellis.tasks.restore")
                  : language.t("trellis.tasks.maximize")
              }
              onClick={() => setMaximized((v) => !v)}
            />
          </Tooltip>
          <Tooltip placement="bottom" value={language.t("trellis.tasks.close")}>
            <IconButton
              icon="close"
              variant="ghost"
              size="small"
              aria-label={language.t("trellis.tasks.close")}
              onClick={() => dialog.close()}
            />
          </Tooltip>
        </div>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col p-4">
        <Show when={saveError()}>{(err) => <ErrorCard err={err()} />}</Show>
        <div
          class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-weak-base bg-surface-raised-base shadow-xs-border-base"
          classList={{ "border-border-focus": mode() === "edit" }}
          style={{ height: mode() === "edit" ? editorH() : maximized() ? "calc(95vh - 90px)" : "calc(90vh - 90px)" }}
        >
          <Show
            when={mode() === "preview"}
            fallback={
              <div
                class="relative min-h-0 w-full overflow-hidden"
                style={{ height: editorH() }}
              >
                <div
                  ref={(el) => {
                    prdEditor.back = el
                  }}
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-0 overflow-auto px-4 py-3 text-14-mono text-text-strong whitespace-pre-wrap break-words"
                  style={{ "font-family": font() }}
                >
                  <div class="min-h-full w-full" innerHTML={html()} />
                </div>
                <textarea
                  ref={(el) => {
                    prdEditor.box = el
                  }}
                  value={draft()}
                  autofocus
                  spellcheck={false}
                  placeholder={language.t("trellis.tasks.new.prdPlaceholder")}
                  class="absolute inset-0 resize-none overflow-auto px-4 py-3 text-14-mono whitespace-pre-wrap bg-transparent focus:outline-none"
                  style={{
                    color: "transparent",
                    "-webkit-text-fill-color": "transparent",
                    "caret-color": "var(--text-strong)",
                    "font-family": font(),
                    height: editorH(),
                  }}
                  onInput={onInput}
                  onScroll={syncPrdScroll}
                  onKeyDown={onKeyDown}
                />
              </div>
            }
          >
            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <Show
                when={typeof props.initialContent === "string"}
                fallback={<Empty text={language.t("trellis.tasks.noPrd")} />}
              >
                <Markdown text={props.initialContent as string} />
              </Show>
            </div>
          </Show>
        </div>
        <Show when={mode() === "edit"}>
          <div class="mt-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-11-regular text-text-weak">
              <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">
                {platform.os === "macos" ? "⌘" : language.t("common.key.ctrl")}
              </span>
              <span>+</span>
              <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">
                {language.t("common.key.enter")}
              </span>
              <span>{language.t("trellis.tasks.save")}</span>
              <span class="mx-1 text-text-subtle">·</span>
              <span class="rounded-md border border-border-weak-base bg-background-base px-1.5 py-0.5">Esc</span>
              <span>{language.t("trellis.tasks.cancel")}</span>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded-md border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base-hover disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving() || !dirty()}
                onClick={cancelEdit}
              >
                {language.t("trellis.tasks.cancel")}
              </button>
              <button
                type="button"
                class="rounded-md bg-surface-interactive-base px-4 py-1.5 text-12-medium text-text-on-interactive transition-colors hover:bg-surface-interactive-base-hover disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving() || !dirty()}
                onClick={() => void save()}
              >
                {saving() ? language.t("trellis.tasks.saving") : language.t("trellis.tasks.save")}
              </button>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
    </>
  )
}

export function TrellisTasksPanel(props: {
  directory: Accessor<string>
  width: Accessor<number>
  mobile?: boolean
  onBack: () => void
}): JSX.Element {
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const dir = createMemo(() => props.directory())
  const [actionError, setActionError] = createSignal<string | undefined>()
  const [data, { refetch }] = createResource(dir, async (root) => {
    if (!root) return undefined
    if (!platform.listTrellisTasks) return undefined
    console.debug(`[trellis] loading tasks for ${root}`)
    return platform.listTrellisTasks(root)
  })

  createEffect(() => {
    const err = data.error
    if (!err) return
    console.debug(`[trellis] failed to load tasks: ${errorMessage(err, "unknown")}`)
  })

  const tasks = createMemo(() =>
    (data()?.tasks ?? []).slice().sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)),
  )
  const skipped = createMemo(() => data()?.skipped ?? 0)

  const setCurrent = async (task: TrellisTask) => {
    if (!platform.setTrellisCurrentTask) return
    setActionError(undefined)
    try {
      await platform.setTrellisCurrentTask(task.path)
      await refetch()
    } catch (err) {
      const message = errorMessage(err, language.t("common.requestFailed"))
      setActionError(message)
      console.debug(`[trellis] failed to set current task: ${message}`)
    }
  }

  const archive = async (task: TrellisTask) => {
    if (!platform.archiveTrellisTask) return
    setActionError(undefined)
    try {
      await platform.archiveTrellisTask(task.path)
      await refetch()
    } catch (err) {
      const message = errorMessage(err, language.t("common.requestFailed"))
      setActionError(message)
      console.debug(`[trellis] failed to archive task: ${message}`)
    }
  }

  const createTask = async (name: string, content: string) => {
    if (!platform.createTrellisTask) throw new Error(language.t("trellis.tasks.desktopOnly"))
    setActionError(undefined)
    await platform.createTrellisTask(dir(), name, content)
    await refetch()
  }

  const newTask = () => {
    if (!platform.createTrellisTask) return
    const searchFilesAndDirectories = async (query: string) => {
      const client = sdk.createClient({ directory: dir(), throwOnError: true })
      const result = await client.find.files({ query, dirs: "true" })
      return result.data ?? []
    }
    dialog.show(() => <NewTrellisTaskDialog onCreate={createTask} searchFilesAndDirectories={searchFilesAndDirectories} />)
  }

  const open = async (path: string) => {
    const name = getFilename(path)
    const prdAbsPath = path.endsWith("/") ? path + "prd.md" : path + "/prd.md"
    let content: string | undefined
    if (platform.readConfigFile) {
      try {
        content = (await platform.readConfigFile(prdAbsPath)) ?? undefined
      } catch {
      }
    }
    if (typeof content !== "string") {
      try {
        const root = dir().replace(/\/+$/, "")
        const canonRoot = root.replace(/\\/g, "/")
        const canonAbs = prdAbsPath.replace(/\\/g, "/")
        let prdPath = prdAbsPath
        if (canonAbs.startsWith(canonRoot)) {
          prdPath = prdAbsPath.slice(root.length)
          if (prdPath.startsWith("/") || prdPath.startsWith("\\")) prdPath = prdPath.slice(1)
        }
        const client = sdk.createClient({ directory: dir(), throwOnError: true })
        const res = await client.file.read({ path: prdPath })
        content = res.data?.content
      } catch {
      }
    }
    dialog.show(() => (
      <PrdPreviewDialog name={name} prdAbsPath={prdAbsPath} initialContent={content} />
    ))
  }

  return (
    <div
      data-component="sidebar-panel"
      class="flex h-full min-h-0 min-w-0 flex-col rounded-tl-[12px] border-l border-t border-border-weaker-base bg-background-base px-3"
      style={{ width: props.mobile ? undefined : `${props.width()}px` }}
    >
      <div class="shrink-0 px-1 py-3">
        <div class="flex items-start justify-between gap-2 py-1 pl-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Tooltip placement="bottom" value={language.t("trellis.tasks.back")}>
                <IconButton
                  icon="arrow-left"
                  variant="ghost"
                  size="small"
                  class="-ml-1 rounded-md"
                  aria-label={language.t("trellis.tasks.back")}
                  onClick={props.onBack}
                />
              </Tooltip>
              <div class="text-14-medium text-text-strong">{language.t("trellis.tasks.title")}</div>
            </div>
            <div class="mt-1 truncate text-12-regular text-text-base">
              {dir() || language.t("trellis.tasks.noProject")}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Tooltip placement="bottom" value={language.t("trellis.tasks.new.button")}>
              <IconButton
                icon="plus"
                variant="ghost"
                size="large"
                class="rounded-lg"
                disabled={!dir() || !platform.createTrellisTask}
                aria-label={language.t("trellis.tasks.new.button")}
                onClick={newTask}
              />
            </Tooltip>
            <Tooltip placement="bottom" value={language.t("trellis.tasks.refresh")}>
              <IconButton
                icon="refresh"
                variant="ghost"
                size="large"
                class="rounded-lg"
                disabled={!dir() || !platform.listTrellisTasks || data.loading}
                aria-label={language.t("trellis.tasks.refresh")}
                onClick={() => void refetch()}
              />
            </Tooltip>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-1 pb-4">
        <Show when={platform.listTrellisTasks} fallback={<Empty text={language.t("trellis.tasks.desktopOnly")} />}>
          <Show when={dir()} fallback={<Empty text={language.t("trellis.tasks.noProject")} />}>
            <Show when={!data.loading} fallback={<Empty text={language.t("trellis.tasks.loading")} />}>
              <Show
                when={!data.error}
                fallback={<ErrorCard err={errorMessage(data.error, language.t("common.requestFailed"))} />}
              >
                <Show when={tasks().length > 0} fallback={<Empty text={language.t("trellis.tasks.empty")} />}>
                  <div class="flex flex-col gap-2">
                    <Show when={actionError()}>
                      {(err) => <ErrorCard err={err()} />}
                    </Show>
                    <For each={tasks()}>
                      {(task) => <TaskCard task={task} onOpen={open} onSetCurrent={setCurrent} onArchive={archive} />}
                    </For>
                  </div>
                </Show>
                <Show when={skipped() > 0}>
                  <div class="mt-2 rounded-lg border border-border-warning-base bg-surface-warning-base px-3 py-2 text-12-regular text-text-strong">
                    {language.t("trellis.tasks.skipped", { count: skipped() })}
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function Empty(props: { text: string }): JSX.Element {
  return <div class="px-4 py-10 text-center text-14-regular text-text-base">{props.text}</div>
}

function ErrorCard(props: { err: string }): JSX.Element {
  return (
    <div class="rounded-xl border border-border-critical-base bg-surface-critical-base px-3 py-3 text-13-regular text-text-strong">
      {props.err}
    </div>
  )
}
