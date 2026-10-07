import { ErrorBoundary, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle, FileScrollControl, FileScrollHandle } from "@opencode-ai/ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { fileViewerTarget, resolveFileViewers } from "@opencode-ai/ui/file-viewer-registry"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/ui/line-comment-annotations"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { getSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { fileContentCacheKey } from "@/pages/session/file-cache-key"
import { openInBrowserTab } from "@/pages/session/browser-panel"
import { OpenInApp } from "@/components/open-in-app"

const DEFAULT_VIEWER = "default"

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
  const server = useServer()
  const sdk = useSDK()
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
  const fullPath = createMemo(() => {
    const p = path()
    if (!p) return
    return `${sdk.directory.replace(/[\\/]+$/, "")}/${p}`
  })
  const html = createMemo(() => /\.html?$/i.test(path() ?? ""))
  // Hand the file to the embedded browser panel: it renders the page natively
  // (the preview here shows source). Opening the panel first matters — tab
  // visibility follows opened() + active(), and the side panel docks are
  // mutually exclusive, so the preview unmounts as the browser takes over.
  const openInEmbeddedBrowser = () => {
    const target = fullPath()
    if (!target) return
    console.debug(`[file-preview] open-in-browser path=${target}`)
    view().browser.open()
    openInBrowserTab(target)
  }
  const openWithAction = <OpenInApp path={fullPath()} logPrefix="file-preview" />

  // Replace-mode viewers (registered by extensions) can take over the whole tab.
  // The default viewer is always available through the "Open with" menu.
  const [viewer, setViewer] = createStore({ choice: undefined as string | undefined })
  const viewerCandidates = createMemo(() => {
    const p = path()
    if (!p) return []
    const mime = state()?.content?.mimeType
    return resolveFileViewers(fileViewerTarget(p, mime)).filter((entry) => entry.mode === "replace")
  })
  const activeViewer = createMemo(() => {
    const list = viewerCandidates()
    const choice = viewer.choice
    if (choice === DEFAULT_VIEWER) return
    return list.find((entry) => entry.id === choice) ?? list[0]
  })
  const selectViewer = (id: string) => {
    console.debug(`[file-preview] select viewer path=${path() ?? ""} viewer=${id}`)
    setViewer("choice", id)
  }
  const fileViewer = createMemo(() => {
    const p = path() ?? ""
    return {
      ...fileViewerTarget(p, state()?.content?.mimeType),
      absolutePath: fullPath() ?? p,
      directory: sdk.directory,
    }
  })
  const readBytes = async () => {
    const p = path()
    const connection = server.current
    if (!p || !connection) throw new Error("File path is unavailable")
    const url = new URL("/file/raw", connection.http.url)
    url.searchParams.set("directory", sdk.directory)
    url.searchParams.set("path", p)
    const headers = new Headers()
    if (connection.http.password) {
      headers.set(
        "authorization",
        `Basic ${authTokenFromCredentials({
          username: connection.http.username,
          password: connection.http.password,
        })}`,
      )
    }
    const response = await (platform.fetch ?? fetch)(url, { headers })
    if (!response.ok) throw new Error(`Failed to read raw file ${p} (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }
  const readText = async () => new TextDecoder().decode(await readBytes())
  const showSource = () => selectViewer(DEFAULT_VIEWER)
  const viewerMenu = () => (
    <Show when={viewerCandidates().length > 0}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="layout-right"
          variant="secondary"
          class="pointer-events-auto h-8 w-8 rounded-md"
          aria-label={language.t("session.fileTab.viewer.openWith")}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-radio-item]]:pl-1">
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="!px-1 !py-1">
                {language.t("session.fileTab.viewer.openWith")}
              </DropdownMenu.GroupLabel>
              <DropdownMenu.RadioGroup class="mt-1" value={activeViewer()?.id ?? DEFAULT_VIEWER}>
                <DropdownMenu.RadioItem value={DEFAULT_VIEWER} onSelect={() => selectViewer(DEFAULT_VIEWER)}>
                  <DropdownMenu.ItemLabel>{language.t("session.fileTab.viewer.default")}</DropdownMenu.ItemLabel>
                  <DropdownMenu.ItemIndicator>
                    <Icon name="check-small" size="small" class="text-icon-weak" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
                <For each={viewerCandidates()}>
                  {(entry) => (
                    <DropdownMenu.RadioItem value={entry.id} onSelect={() => selectViewer(entry.id)}>
                      <DropdownMenu.ItemLabel>{entry.title}</DropdownMenu.ItemLabel>
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
  const fileActions = (
    <>
      {viewerMenu()}
      <Show when={html()}>
        <Tooltip value={language.t("panel.browser.openFile")} placement="bottom">
          <IconButton
            icon="globe"
            variant="ghost"
            class="h-8 w-8 rounded-md"
            onClick={openInEmbeddedBrowser}
            aria-label={language.t("panel.browser.openFile")}
          />
        </Tooltip>
      </Show>
      {openWithAction}
    </>
  )
  const [copyState, setCopyState] = createStore({ kind: "" as "path" | "content" | "" })
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  const markCopied = (kind: "path" | "content") => {
    setCopyState("kind", kind)
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCopyState("kind", ""), 1_200)
  }
  const copyPath = () => {
    const target = fullPath()
    if (!target) return

    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[file-preview] copy path path=${target}`)
    if (!clipboard?.writeText) {
      console.debug(`[file-preview] clipboard unavailable path=${target}`)
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }

    void clipboard.writeText(target).then(
      () => {
        console.debug(`[file-preview] copied path path=${target}`)
        markCopied("path")
      },
      (err: unknown) => {
        console.debug(`[file-preview] copy path failed path=${target} err=${err instanceof Error ? err.message : String(err)}`)
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
    console.debug(`[file-preview] copy content path=${target}`)
    if (!clipboard?.writeText) {
      console.debug(`[file-preview] clipboard unavailable path=${target}`)
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }

    // The sidecar's preview text is trimmed; local desktop copies must preserve the original whitespace.
    const source = server.isLocal() && platform.readLocalFile ? platform.readLocalFile(fullPath()!) : Promise.resolve(text)
    void source.then((value) => {
      if (value === null) throw new Error("Unable to read original file")
      console.debug(`[file-preview] copy content resolved path=${target} chars=${value.length}`)
      return clipboard.writeText(value)
    }).then(
      () => {
        console.debug(`[file-preview] copied content path=${target}`)
        markCopied("content")
      },
      (err: unknown) => {
        console.debug(
          `[file-preview] copy content failed path=${target} err=${err instanceof Error ? err.message : String(err)}`,
        )
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }
  onCleanup(() => {
    if (copiedTimer) clearTimeout(copiedTimer)
  })
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

    // While a selection jump is pending (see view-cache selectionSeq), the
    // viewport belongs to that jump; restoring the persisted position here
    // would fight it. The jump settles by writing its own viewport position
    // back into the persisted store, after which restore becomes a no-op.
    const p = path()
    if (!p || file.selectionPending(p)) return

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

  // Scroll-intent arbitration (single source of truth: view-cache sequences).
  //
  // - `setSelectedLines(path, range)` bumps `selectionSeq` → a jump is pending.
  // - This effect asks the viewer handle to scroll the selection into view once
  //   the content is loaded and the handle is registered (the handle retries
  //   internally until the target lines are rendered).
  // - On completion the settled viewport position is written back into the
  //   persisted scroll store, so any later restore is a no-op.
  // - `restoreScroll` skips while a jump is pending; there are no timers and
  //   the two writers can never run against the viewport at the same time.
  const [scrollHandle, setScrollHandle] = createSignal<FileScrollHandle | null>(null)
  const scrollControl: FileScrollControl = {
    register: setScrollHandle,
  }

  createEffect(() => {
    const p = path()
    if (!p) return
    const seq = file.selectionSeq(p)
    if (!file.selectionPending(p)) return
    const range = selectedLines()
    const handle = scrollHandle()
    if (!range || !handle) return
    if (!state()?.loaded) return

    handle.scrollToSelection(() => {
      file.settleSelection(p, seq)
      const el = scroll
      if (!el) return
      const inner = getCodeScroll()[0]
      view().setScroll(props.tab, { x: inner?.scrollLeft ?? el.scrollLeft, y: el.scrollTop })
    })
  })

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
    <Show
      when={activeViewer()}
      fallback={
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
            scrollControl={scrollControl}
            class="select-text"
            actionsMount={actionsMount}
            media={{
              mode: "auto",
              path: path(),
              current: state()?.content,
              onLoad: queueRestore,
              viewer: {
                file: fileViewer(),
                readBytes,
                readText,
              },
            }}
            copyPath={copyPath}
            copyContent={state()?.content?.type === "text" ? copyContent : undefined}
            copyPathCopied={copyState.kind === "path"}
            copyContentCopied={copyState.kind === "content"}
            openWith={fileActions}
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
      }
    >
      {(entry) => (
        <div
          class="oc-extension-root relative flex min-h-full flex-col"
          data-file-viewer={entry().id}
          data-extension={entry().owner === "builtin" ? undefined : entry().owner}
        >
          <div class="flex justify-end gap-2 border-b border-border-weak-base px-3 py-2">
            {viewerMenu()}
            <OpenInApp path={fullPath()} logPrefix="file-preview" />
          </div>
          <ErrorBoundary
            fallback={(error) => {
              const message = error instanceof Error ? error.message : String(error)
              console.error(`[file-viewer] render failed id=${entry().id} path=${path() ?? ""} error=${message}`)
              return (
                <div class="flex flex-col items-start gap-3 px-6 py-4 text-text-weak">
                  <div>{message}</div>
                  <button type="button" class="text-text-strong underline" onClick={showSource}>
                    {language.t("session.fileTab.viewer.default")}
                  </button>
                </div>
              )
            }}
          >
            <Dynamic
              component={entry().component}
              file={fileViewer()}
              text={() => source}
              readBytes={readBytes}
              readText={readText}
              showSource={showSource}
            />
          </ErrorBoundary>
        </div>
      )}
    </Show>
  )

  return (
    <Tabs.Content value={props.tab} class="relative h-full">
      <div
        ref={setActionsMount}
        data-slot="file-preview-actions-layer"
        class="pointer-events-none absolute inset-0 z-20"
      />
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
