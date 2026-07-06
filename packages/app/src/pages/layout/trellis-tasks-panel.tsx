import { createEffect, createResource, createMemo, createSignal, For, Show, onCleanup, type Accessor, type JSX } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Markdown } from "@opencode-ai/ui/markdown"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import { useLanguage } from "@/context/language"
import { usePlatform, type TrellisTask } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogPromptEditor } from "@/components/dialog-prompt-editor"
import { resolveAtMenuLeft } from "@/components/at-menu-position"
import { paint } from "@/components/prompt-input/expand"
import { type AtOption } from "@/components/prompt-input/slash-popover"
import { at, mention } from "@/components/dialog-prompt-editor-input"
import { monoFontFamily, useSettings } from "@/context/settings"
import { errorMessage } from "./helpers"
import {
  applyPrdDocumentPairEdit,
  commitPrdDocumentSave,
  createPrdDocumentState,
} from "./trellis-prd-document"

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

const PRD_AUTOSAVE_DELAY = 700

type NewTrellisTaskDraft = {
  name: string
  content: string
}

const newTrellisTaskDraftKey = (directory: string) =>
  `opencode.trellis.new-task-draft:${checksum(directory) ?? "default"}`

function readNewTrellisTaskDraft(directory: string): NewTrellisTaskDraft {
  if (typeof localStorage === "undefined") return { name: "", content: "" }
  try {
    const raw = localStorage.getItem(newTrellisTaskDraftKey(directory))
    if (!raw) return { name: "", content: "" }
    const parsed = JSON.parse(raw) as Partial<NewTrellisTaskDraft>
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
    }
  } catch {
    return { name: "", content: "" }
  }
}

function writeNewTrellisTaskDraft(directory: string, draft: NewTrellisTaskDraft) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(newTrellisTaskDraftKey(directory), JSON.stringify(draft))
  } catch {
  }
}

function removeNewTrellisTaskDraft(directory: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.removeItem(newTrellisTaskDraftKey(directory))
  } catch {
  }
}

function NewTrellisTaskDialog(props: {
  directory: string
  onCreate: (name: string, content: string) => Promise<void>
  searchFilesAndDirectories: (query: string) => Promise<string[]>
}): JSX.Element {
  const language = useLanguage()
  const initialDraft = readNewTrellisTaskDraft(props.directory)
  const [name, setName] = createSignal(initialDraft.name)
  const [content, setContent] = createSignal(initialDraft.content)
  const [nameError, setNameError] = createSignal<string | undefined>()

  const persistDraft = (next: Partial<NewTrellisTaskDraft>) => {
    const draft = {
      name: next.name ?? name(),
      content: next.content ?? content(),
    }
    writeNewTrellisTaskDraft(props.directory, draft)
  }

  const save = async (content: string) => {
    const title = name().trim()
    if (!title) {
      const message = language.t("trellis.tasks.new.nameRequired")
      setNameError(message)
      throw new Error(message)
    }
    setNameError(undefined)
    await props.onCreate(title, content)
    removeNewTrellisTaskDraft(props.directory)
  }

  return (
    <DialogPromptEditor
      text={initialDraft.content}
      placeholder={language.t("trellis.tasks.new.prdPlaceholder")}
      title={language.t("trellis.tasks.new.title")}
      description={language.t("trellis.tasks.new.description")}
      saveOnClose={false}
      saveLabel={language.t("trellis.tasks.new.save")}
      searchFilesAndDirectories={props.searchFilesAndDirectories}
      onTextChange={(value) => {
        setContent(value)
        persistDraft({ content: value })
      }}
      onDiscard={() => removeNewTrellisTaskDraft(props.directory)}
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

function TaskCard(props: {
  task: TrellisTask
  onOpen: (task: TrellisTask) => void | Promise<void>
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
    void props.onOpen(props.task)
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
      onClick={() => props.onOpen(props.task)}
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
          <div class="mt-2 flex flex-wrap items-center gap-2">
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
  taskTitle: string
  prdAbsPath: string
  initialContent: string | undefined
  searchFilesAndDirectories?: (query: string) => Promise<string[]>
}): JSX.Element {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()
  const canWrite = createMemo(() => typeof platform.writeConfigFile === "function")
  const initialDocument = createPrdDocumentState(props.initialContent)
  const [mode, setMode] = createSignal<"preview" | "edit">("preview")
  const [savedContent, setSavedContent] = createSignal(initialDocument.savedContent)
  const [draft, setDraft] = createSignal(initialDocument.draft)
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | undefined>()
  const [maximized, setMaximized] = createSignal(false)
  const [titleCopied, setTitleCopied] = createSignal(false)
  const [popover, setPopover] = createSignal<"at" | null>(null)
  let titleCopiedTimer: ReturnType<typeof setTimeout> | undefined
  const [menu, setMenu] = createSignal({
    top: 12,
    left: 12,
    max: 320,
  })
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingWrites = 0
  let disposed = false
  let writeQueue = Promise.resolve()
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const html = createMemo(() => paint(draft()))
  const prdEditor = {
    box: undefined as HTMLTextAreaElement | undefined,
    back: undefined as HTMLDivElement | undefined,
    menu: undefined as HTMLDivElement | undefined,
  }
  const syncPrdScroll = () => {
    if (!prdEditor.box || !prdEditor.back) return
    prdEditor.back.scrollTop = prdEditor.box.scrollTop
    prdEditor.back.scrollLeft = prdEditor.box.scrollLeft
  }
  const atKey = (item: AtOption | undefined) => {
    if (!item) return ""
    return item.type === "agent" ? `agent:${item.name}` : `file:${item.path}`
  }
  const handleAtSelect = (item: AtOption | undefined) => {
    if (!item || item.type !== "file" || !prdEditor.box) return
    const pos = prdEditor.box.selectionStart ?? draft().length
    const match = at(draft(), pos)
    if (!match) return
    const next = mention(draft(), match.start, match.end, item.path)
    updateDraft(next.text)
    setPopover(null)
    requestAnimationFrame(() => {
      if (!prdEditor.box) return
      prdEditor.box.focus()
      prdEditor.box.setSelectionRange(next.start, next.end)
      syncPrdScroll()
    })
  }
  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const paths = props.searchFilesAndDirectories ? await props.searchFilesAndDirectories(query).catch(() => []) : []
      return paths.map((path) => ({
        type: "file" as const,
        path,
        display: path,
      }))
    },
    key: atKey,
    filterKeys: ["display"],
    onSelect: handleAtSelect,
  })
  const shown = createMemo(() => atFlat().slice(0, 6))

  const editorH = createMemo(() => (maximized() ? "calc(95vh - 130px)" : "calc(90vh - 130px)"))
  const title = createMemo(() => props.taskTitle.trim() || props.name)

  const copyTitle = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(title()).then(() => {
      setTitleCopied(true)
      if (titleCopiedTimer) clearTimeout(titleCopiedTimer)
      titleCopiedTimer = setTimeout(() => setTitleCopied(false), 1200)
    })
  }

  onCleanup(() => {
    if (titleCopiedTimer) clearTimeout(titleCopiedTimer)
  })

  const clearAutosave = () => {
    if (!autosaveTimer) return
    clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }

  const persistContent = async (content: string, options: { preview?: boolean; silent?: boolean } = {}) => {
    if (!canWrite()) return false
    clearAutosave()
    const writeConfigFile = platform.writeConfigFile!
    const updateUi = !options.silent && !disposed
    if (updateUi) {
      pendingWrites += 1
      setSaving(true)
      setSaveError(undefined)
    }
    const queued = writeQueue.catch(() => undefined).then(() => writeConfigFile(props.prdAbsPath, content))
    writeQueue = queued.catch(() => undefined)
    try {
      await queued
      if (!options.silent && !disposed) {
        const next = commitPrdDocumentSave({ savedContent: savedContent(), draft: content })
        setSavedContent(next.savedContent)
        if (draft() === content) {
          setDraft(next.draft)
          setDirty(false)
        }
        if (options.preview) setMode("preview")
      }
      return true
    } catch (err) {
      if (!options.silent && !disposed) {
        setSaveError(errorMessage(err, language.t("trellis.tasks.saveFailed")))
      }
      return false
    } finally {
      if (updateUi) {
        pendingWrites = Math.max(0, pendingWrites - 1)
        if (pendingWrites === 0) setSaving(false)
      }
    }
  }

  const scheduleAutosave = () => {
    if (!canWrite()) return
    clearAutosave()
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined
      void persistContent(draft())
    }, PRD_AUTOSAVE_DELAY)
  }

  const updateDraft = (next: string) => {
    setDraft(next)
    const nextDirty = next !== savedContent()
    setDirty(nextDirty)
    setSaveError(undefined)
    if (nextDirty) scheduleAutosave()
    else clearAutosave()
  }

  const saveAndPreview = async () => {
    if (!dirty() && draft() === savedContent()) {
      setSaveError(undefined)
      setMode("preview")
      return true
    }
    return persistContent(draft(), { preview: true })
  }

  const closeDialog = async () => {
    if (mode() === "edit" && (dirty() || draft() !== savedContent())) {
      const saved = await persistContent(draft())
      if (!saved) return
    }
    dialog.close()
  }

  onCleanup(() => {
    clearAutosave()
    const latestDraft = draft()
    const latestSaved = savedContent()
    disposed = true
    if (latestDraft !== latestSaved) void persistContent(latestDraft, { silent: true })
  })

  const placeAtMenu = () => {
    if (!prdEditor.box) return
    const box = prdEditor.box
    const style = window.getComputedStyle(box)
    const mirror = document.createElement("div")
    const before = draft().slice(0, box.selectionStart ?? 0)
    const value = before.length > 0 ? before : " "

    mirror.style.position = "absolute"
    mirror.style.visibility = "hidden"
    mirror.style.pointerEvents = "none"
    mirror.style.whiteSpace = "pre-wrap"
    mirror.style.wordBreak = "break-word"
    mirror.style.overflowWrap = "break-word"
    mirror.style.font = style.font
    mirror.style.fontFamily = style.fontFamily
    mirror.style.fontSize = style.fontSize
    mirror.style.fontWeight = style.fontWeight
    mirror.style.lineHeight = style.lineHeight
    mirror.style.letterSpacing = style.letterSpacing
    mirror.style.padding = style.padding
    mirror.style.border = style.border
    mirror.style.boxSizing = style.boxSizing
    mirror.style.width = `${box.clientWidth}px`
    mirror.style.maxWidth = `${box.clientWidth}px`
    mirror.textContent = value

    const mark = document.createElement("span")
    mark.textContent = "\u200b"
    mirror.append(mark)
    box.parentElement?.append(mirror)

    const top = mark.offsetTop - box.scrollTop
    const left = mark.offsetLeft - box.scrollLeft
    mirror.remove()

    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 20
    const padX = Number.parseFloat(style.paddingLeft) || 0
    const padY = Number.parseFloat(style.paddingTop) || 0
    const menuH = prdEditor.menu?.offsetHeight ?? Math.min(320, Math.max(40, atFlat().length * 34 + 16))
    const below = box.clientHeight - (top + padY + line)
    const nextTop = below >= Math.min(menuH, 180) ? top + padY + line + 6 : Math.max(8, top + padY - menuH - 6)
    const menuW = Math.min(prdEditor.menu?.offsetWidth ?? 280, Math.max(120, box.clientWidth - 16))
    const nextLeft = resolveAtMenuLeft({
      anchorLeft: left + padX,
      boxWidth: box.clientWidth,
      menuWidth: menuW,
    })
    const nextMax = Math.max(120, Math.min(320, box.clientHeight - nextTop - 8))

    setMenu({
      top: nextTop,
      left: nextLeft,
      max: nextMax,
    })
  }

  const refreshAtMenu = () => {
    if (!prdEditor.box || !props.searchFilesAndDirectories) return
    const match = at(draft(), prdEditor.box.selectionStart ?? 0)
    if (!match) {
      setPopover(null)
      return
    }
    atOnInput(match.query)
    setPopover("at")
    requestAnimationFrame(placeAtMenu)
  }

  const revealAtActive = () => {
    const root = prdEditor.menu
    if (!root) return
    const key = atActive()
    if (!key) return
    const node = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
    node?.scrollIntoView({ block: "nearest" })
  }

  const enterEdit = () => {
    if (!canWrite()) return
    setSaveError(undefined)
    setMode("edit")
  }

  const save = async () => {
    if (!canWrite() || saving()) return
    await saveAndPreview()
  }

  const onInput: JSX.EventHandlerUnion<HTMLTextAreaElement, Event> = (event) => {
    updateDraft(event.currentTarget.value)
    requestAnimationFrame(refreshAtMenu)
  }

  const onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "Enter") {
      event.preventDefault()
      if (!saving()) void save()
      return
    }
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      void saveAndPreview()
      return
    }

    const next = applyPrdDocumentPairEdit({
      text: draft(),
      start: event.currentTarget.selectionStart ?? 0,
      end: event.currentTarget.selectionEnd ?? 0,
      key: event.key,
    })
    if (next) {
      event.preventDefault()
      updateDraft(next.text)
      setPopover(null)
      requestAnimationFrame(() => {
        if (!prdEditor.box) return
        prdEditor.box.setSelectionRange(next.start, next.end)
        syncPrdScroll()
        refreshAtMenu()
      })
    }
  }

  createEffect(() => {
    if (popover() !== "at") return
    atFlat()
    requestAnimationFrame(placeAtMenu)
  })

  createEffect(() => {
    if (popover() !== "at") return
    atActive()
    requestAnimationFrame(revealAtActive)
  })

  createEffect(() => {
    const onResize = () => {
      if (popover() !== "at") return
      placeAtMenu()
    }
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

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
        title={
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
                  titleCopied() ? language.t("session.share.copy.copied") : language.t("trellis.tasks.copyTitle")
                }
                onClick={copyTitle}
              />
            </Tooltip>
          </div>
        }
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
                onClick={() => void saveAndPreview()}
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
                size="large"
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
              size="large"
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
              size="large"
              aria-label={language.t("trellis.tasks.close")}
              onClick={() => void closeDialog()}
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
                    prdEditor.menu = el
                  }}
                  class="absolute z-20 min-h-10 w-[min(560px,calc(100%-16px))] overflow-auto no-scrollbar rounded-[12px] border border-white/10 p-2 shadow-[var(--shadow-lg-border-base)]"
                  classList={{ hidden: popover() !== "at" }}
                  style={{
                    top: `${menu().top}px`,
                    left: `${menu().left}px`,
                    "max-height": `${menu().max}px`,
                    "background-color":
                      platform.platform === "desktop"
                        ? platform.os === "windows"
                          ? "light-dark(#ffffff, var(--surface-raised-stronger-non-alpha))"
                          : "light-dark(#ffffff, rgb(12 12 14 / 0.34))"
                        : "rgb(12 12 14 / 0.34)",
                    "backdrop-filter":
                      platform.platform === "desktop" && platform.os === "windows"
                        ? "none"
                        : "blur(40px) saturate(150%)",
                    "-webkit-backdrop-filter":
                      platform.platform === "desktop" && platform.os === "windows"
                        ? "none"
                        : "blur(40px) saturate(150%)",
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  <div classList={{ hidden: atFlat().length > 0 }} class="px-2 py-1 text-text-weak">
                    {language.t("prompt.popover.emptyResults")}
                  </div>
                  <For each={shown()}>
                    {(item) => {
                      if (item.type !== "file") return null
                      const key = atKey(item)
                      const dir = item.path.endsWith("/") ? item.path : getDirectory(item.path)
                      const file = item.path.endsWith("/") ? "" : getFilename(item.path)
                      return (
                        <button
                          data-key={key}
                          class="flex w-full items-center gap-x-2 rounded-md px-2 py-0.5"
                          classList={{ "bg-surface-raised-base-active": atActive() === key }}
                          onClick={() => handleAtSelect(item)}
                          onMouseEnter={() => setAtActive(key)}
                        >
                          <FileIcon
                            node={{ path: item.path, type: item.path.endsWith("/") ? "directory" : "file" }}
                            class="size-4 shrink-0"
                          />
                          <div class="min-w-0 flex items-center text-14-regular">
                            <span class="min-w-0 truncate whitespace-nowrap text-text-weak">{dir}</span>
                            <span class="whitespace-nowrap text-text-strong">{file}</span>
                          </div>
                        </button>
                      )
                    }}
                  </For>
                </div>
                <div
                  ref={(el) => {
                    prdEditor.back = el
                  }}
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-0 overflow-auto px-4 pt-3 pb-[22px] text-14-mono text-text-strong whitespace-pre-wrap break-words"
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
                  class="absolute inset-0 resize-none overflow-auto px-4 pt-3 pb-[22px] text-14-mono whitespace-pre-wrap bg-transparent focus:outline-none"
                  style={{
                    color: "transparent",
                    "-webkit-text-fill-color": "transparent",
                    "caret-color": "var(--text-strong)",
                    "font-family": font(),
                    height: editorH(),
                  }}
                  onInput={onInput}
                  onScroll={() => {
                    syncPrdScroll()
                    if (popover() === "at") requestAnimationFrame(placeAtMenu)
                  }}
                  onClick={refreshAtMenu}
                  onKeyUp={refreshAtMenu}
                  onKeyDown={(event) => {
                    if (popover()) {
                      if (event.key === "Tab") {
                        const item = atFlat().find((entry) => atKey(entry) === atActive()) ?? atFlat()[0]
                        if (item) handleAtSelect(item)
                        event.preventDefault()
                        return
                      }

                      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
                      const ctrl =
                        event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey &&
                        !event.shiftKey &&
                        (event.key === "n" || event.key === "p")
                      if (nav || ctrl) {
                        atOnKeyDown(event)
                        event.preventDefault()
                        return
                      }

                      if (event.key === "Escape") {
                        setPopover(null)
                        event.preventDefault()
                        return
                      }
                    }
                    onKeyDown(event)
                    requestAnimationFrame(refreshAtMenu)
                  }}
                  onBlur={() => {
                    window.setTimeout(() => setPopover(null), 120)
                  }}
                  onFocus={refreshAtMenu}
                />
              </div>
            }
          >
            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <Show
                when={typeof props.initialContent === "string"}
                fallback={<Empty text={language.t("trellis.tasks.noPrd")} />}
              >
                <Markdown text={savedContent()} />
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
              <span>{language.t("trellis.tasks.saveAndPreview")}</span>
              <span class="mx-1 text-text-subtle">·</span>
              <span>
                {saving()
                  ? language.t("trellis.tasks.autosaving")
                  : dirty()
                    ? language.t("trellis.tasks.autosavePending")
                    : language.t("trellis.tasks.autosaved")}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded-md border border-border-weak-base bg-background-base px-3 py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base-hover disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving()}
                onClick={() => void saveAndPreview()}
              >
                {language.t("trellis.tasks.preview")}
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
    dialog.show(() => (
      <NewTrellisTaskDialog directory={dir()} onCreate={createTask} searchFilesAndDirectories={searchFilesAndDirectories} />
    ))
  }

  const open = async (task: TrellisTask) => {
    const path = task.path
    const name = getFilename(path)
    const prdAbsPath = path.endsWith("/") ? path + "prd.md" : path + "/prd.md"
    const searchFilesAndDirectories = async (query: string) => {
      const client = sdk.createClient({ directory: dir(), throwOnError: true })
      const result = await client.find.files({ query, dirs: "true" })
      return result.data ?? []
    }
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
      <PrdPreviewDialog
        name={name}
        taskTitle={task.title}
        prdAbsPath={prdAbsPath}
        initialContent={content}
        searchFilesAndDirectories={searchFilesAndDirectories}
      />
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
