import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { Spinner } from "@opencode-ai/ui/spinner"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { fileContentCacheKey } from "@/pages/session/file-cache-key"
import { apps, editor, getOpenPlan, type OpenApp, type OS } from "@/components/session/open-app"
import { Persist, persisted } from "@/utils/persist"

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const dirname = (target: string) => {
  const idx = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))
  if (idx < 0) return ""
  return target.slice(0, idx)
}

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

export function FileTabContent(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const platform = usePlatform()
  const sdk = useSDK()
  const server = useServer()
  const fileComponent = useFileComponent()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let scroll: HTMLDivElement | undefined
  const [actionsMount, setActionsMount] = createSignal<HTMLDivElement>()
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  let codeScroll: HTMLElement[] = []
  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const md = createMemo(() => /\.(md|markdown|mdx)$/i.test(path() ?? ""))
  const pdf = createMemo(() => /\.pdf$/i.test(path() ?? ""))
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => fileContentCacheKey(path() ?? "", contents()))
  const os = createMemo(() => detectOS(platform))
  const fullPath = createMemo(() => {
    const p = path()
    if (!p) return
    return `${sdk.directory.replace(/[\\/]+$/, "")}/${p}`
  })
  const fileManager = createMemo(() => {
    if (os() === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
    if (os() === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
    return { label: "session.header.open.fileManager", icon: "finder" as const }
  })
  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })
  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })
  const appList = createMemo(() => apps(os()))
  const openOptions = createMemo(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...appList()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })
  const currentOpenApp = createMemo(() => {
    if (prefs.app === "finder") {
      return { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon } as const
    }

    const app = appList().find((item) => item.id === prefs.app)
    if (!app) return
    return { ...app, label: language.t(app.label) } as const
  })
  const currentOpenOption = createMemo(
    () =>
      openOptions().find((option) => option.id === prefs.app) ??
      currentOpenApp() ??
      openOptions()[0] ??
      ({ id: "finder", label: language.t(fileManager().label), icon: fileManager().icon } as const),
  )
  const canOpenWith = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const openingWith = createMemo(() => openRequest.app !== undefined)

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const next = appList()

    setExists(Object.fromEntries(next.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      next.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const openWithApp = (app: OpenApp) => {
    if (openingWith() || !canOpenWith() || !platform.openPath) return
    if (!openOptions().some((option) => option.id === app)) return

    const target = fullPath()
    if (!target) return

    setPrefs("app", app)
    setOpenRequest("app", app)

    const plan = getOpenPlan(app, openOptions(), !!platform.openInEditor)
    const parent = dirname(target) || target
    const value = editor(app) ? target : parent
    const task =
      plan.kind === "editor" && platform.openInEditor
        ? platform.openInEditor(plan.editor, value)
        : platform.openPath(value, plan.kind === "path" ? plan.app : undefined)

    Promise.resolve(task)
      .catch((err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const openWithAction = (
    <Show when={canOpenWith()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={Button}
          variant="ghost"
          size="small"
          disabled={openingWith()}
          class="h-8 rounded-md px-2 gap-1.5 disabled:!cursor-default"
          aria-label={language.t("session.header.open.ariaLabel", { app: currentOpenOption().label })}
        >
          <div class="flex size-4 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-4">
            <Show when={openingWith()} fallback={<AppIcon id={currentOpenOption().icon} />}>
              <Spinner class="size-3.5" />
            </Show>
          </div>
          <span class="hidden sm:inline text-12-regular">{language.t("session.header.openIn")}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-radio-item]]:pl-1">
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="!px-1 !py-1">
                {language.t("session.header.openIn")}
              </DropdownMenu.GroupLabel>
              <DropdownMenu.RadioGroup class="mt-1" value={currentOpenOption().id}>
                <For each={openOptions()}>
                  {(option) => (
                    <DropdownMenu.RadioItem
                      value={option.id}
                      disabled={openingWith()}
                      onSelect={() => openWithApp(option.id)}
                    >
                      <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                        <AppIcon id={option.icon} />
                      </div>
                      <DropdownMenu.ItemLabel>{option.label}</DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemIndicator>
                        <Icon name="check-small" size="small" class="text-icon-weak" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
  const copyPath = () => {
    const target = fullPath()
    if (!target) return

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }

    void clipboard.writeText(target).then(
      () => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: target,
        })
      },
      (err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }
  const copyContent = () => {
    const target = path()
    const text = state()?.content?.type === "text" ? contents() : undefined
    if (!target || text === undefined) return

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }

    void clipboard.writeText(text).then(
      () => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: target,
        })
      },
      (err: unknown) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview =
      input.preview ??
      (() => {
        if (input.file === path()) return selectionPreview(contents(), selection)
        const source = file.get(input.file)?.content?.content
        if (!source) return undefined
        return selectionPreview(source, selection)
      })()

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview =
      input.file === path() ? selectionPreview(contents(), selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeFileTab() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  const getCodeScroll = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const queueScrollUpdate = (next: { x: number; y: number }) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      view().setScroll(props.tab, out)
    })
  }

  const handleCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    queueScrollUpdate({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const syncCodeScroll = () => {
    const next = getCodeScroll()
    if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    codeScroll = next

    for (const item of codeScroll) {
      item.addEventListener("scroll", handleCodeScroll)
    }
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll(props.tab)
    if (!s) return

    syncCodeScroll()

    if (codeScroll.length > 0) {
      for (const item of codeScroll) {
        if (item.scrollLeft !== s.x) item.scrollLeft = s.x
      }
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (codeScroll.length > 0) return
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restoreScroll()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (codeScroll.length === 0) syncCodeScroll()

    queueScrollUpdate({
      x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  const cancelCommenting = () => {
    const p = path()
    if (p) file.setSelectedLines(p, null)
    setNote("commenting", null)
  }

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    queueRestore()
  })

  onCleanup(() => {
    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  const renderFile = (source: string) => (
    <div class={`relative flex flex-col overflow-hidden ${pdf() ? "h-full" : "min-h-full"}`}>
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection={!md()}
        enableHoverUtility={!md()}
        selectedLines={activeSelection()}
        commentedLines={md() ? [] : commentedLines()}
        onRendered={() => {
          queueRestore()
        }}
        annotations={md() ? [] : commentsUi.annotations()}
        renderAnnotation={md() ? undefined : commentsUi.renderAnnotation}
        renderHoverUtility={md() ? undefined : commentsUi.renderHoverUtility}
        onLineSelected={(range: SelectedLineRange | null) => {
          if (md()) return
          commentsUi.onLineSelected(range)
        }}
        onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          if (md()) return
          commentsUi.onLineSelectionEnd(range)
        }}
        search={search}
        class="select-text"
        actionsMount={actionsMount}
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: queueRestore,
        }}
        copyPath={copyPath}
        copyContent={state()?.content?.type === "text" ? copyContent : undefined}
        openWith={openWithAction}
        openFolder={
          platform.openInFinder
            ? () => {
                const target = fullPath()
                if (target) void platform.openInFinder?.(target)
              }
            : undefined
        }
      />
    </div>
  )

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <div ref={setActionsMount} data-slot="file-preview-actions-layer" class="pointer-events-none absolute inset-0 z-20" />
      <Show
        when={pdf() && state()?.loaded}
        fallback={
          <ScrollView
            class="h-full"
            viewportRef={(el: HTMLDivElement) => {
              scroll = el
              restoreScroll()
            }}
            onScroll={handleScroll as any}
          >
            <Switch>
              <Match when={state()?.loaded}>{renderFile(contents())}</Match>
              <Match when={state()?.loading}>
                <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
              </Match>
              <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
            </Switch>
          </ScrollView>
        }
      >
        {renderFile(contents())}
      </Show>
    </Tabs.Content>
  )
}
