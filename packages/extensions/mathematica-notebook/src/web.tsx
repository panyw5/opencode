import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Virtualizer } from "virtua/solid"
import { defineWebExtension, type ExtensionContext, type FileViewerProps } from "@opencode-ai/extension-kit/web"
import type { Output } from "./kernel"
import { canHighlightWolfram, tokenizeWolfram } from "./highlight"
import {
  applyOutline,
  cellText,
  createEditorResizeQueue,
  createReloadGate,
  draftEdits,
  isFoldable,
  isLargeText,
  listStartMargin,
  pinnedCellPositions,
  textPreview,
  viewerContent,
  VIRTUAL_BUFFER_PX,
  visibleCells,
  type EditorResizeQueue,
  type ViewerCell,
  type ViewerContent,
  type ViewerDocument,
} from "./viewer"
import "./web.css"
import { RichCell } from "./box-view"
import { namedCharacters } from "./named-chars"
import { PrettyCode } from "./pretty-view"
import { createPreviewScheduler } from "./preview-scheduler"
import type { CellsResponse } from "./preview-protocol"

const ID = "local.mathematica-notebook"

function CodeTokens(props: { value: string }) {
  const tokens = createMemo(() => tokenizeWolfram(props.value))
  return <For each={tokens()}>{(token) => <span data-token={token.kind}>{token.text}</span>}</For>
}

function TextPreview(props: { value: string; characters?: number; onLoad(): void }) {
  const preview = createMemo(() => namedCharacters(textPreview(props.value)))
  return (
    <div class="oc-nb-preview">
      <p class="oc-nb-muted">
        Large content ({(props.characters ?? props.value.length).toLocaleString()} characters). Preview only.
      </p>
      <pre>{preview()}</pre>
      <button onClick={props.onLoad}>Load full content</button>
    </div>
  )
}

function DeferredText(props: { value: string; full: boolean; onLoad(): void; printed?: boolean }) {
  return (
    <Show
      when={!isLargeText(props.value) || props.full}
      fallback={<TextPreview value={props.value} onLoad={props.onLoad} />}
    >
      <pre classList={{ "oc-nb-printed": props.printed }}>
        <CodeTokens value={namedCharacters(props.value)} />
      </pre>
    </Show>
  )
}

function CellEditor(props: {
  label: string
  value: string
  disabled: boolean
  highlight?: boolean
  pretty?: boolean
  wrap: boolean
  resize: EditorResizeQueue
  onComposition(active: boolean): void
  onInput(value: string): void
}) {
  let field!: HTMLTextAreaElement
  let mirror: HTMLPreElement | undefined
  const [composing, setComposing] = createSignal(false)
  // Fresh empty cells open directly in edit mode; populated cells render pretty.
  const [editing, setEditing] = createSignal(!!props.pretty && props.value.trim() === "")
  const highlighted = createMemo(() => !!props.highlight && !composing() && canHighlightWolfram(props.value))
  const prettyOn = () => !!props.pretty && !editing()
  // The virtualizer may move the focused cell's DOM node when a height change
  // remeasures the list; Chrome blurs the textarea on that move (relatedTarget
  // stays null). A real user blur follows a pointerdown outside the editor, a
  // relatedTarget switch (Tab), or an explicit Escape — everything else is
  // transient and focus must be restored once the node settles.
  let outsidePointerDown = 0
  let exitOnce = false
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  const blurEditor = (event: FocusEvent) => {
    if (exitOnce) {
      exitOnce = false
      setEditing(false)
      return
    }
    if (event.relatedTarget) {
      setEditing(false)
      return
    }
    if (Date.now() - outsidePointerDown < 500) {
      setEditing(false)
      return
    }
    if (restoreTimer !== undefined) clearTimeout(restoreTimer)
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined
      if (
        !field.isConnected ||
        props.disabled ||
        (document.activeElement !== document.body && document.activeElement !== document.documentElement)
      )
        return
      field.focus({ preventScroll: true })
    }, 0)
  }
  const syncScroll = () => {
    if (!mirror || !field) return
    mirror.scrollTop = field.scrollTop
    mirror.scrollLeft = field.scrollLeft
  }
  const resize = () => {
    if (prettyOn()) return
    props.resize.schedule({ field, syncScroll })
  }
  createEffect(() => {
    props.value
    highlighted()
    if (prettyOn()) {
      // The pretty view owns the height; release the managed textarea size.
      props.resize.remove(field)
      field.style.height = ""
      syncScroll()
      return
    }
    resize()
  })
  onMount(() => {
    let width = -1
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width
      if (next === width) return
      width = next
      resize()
    })
    observer.observe(field)
    const trackPointer = (event: PointerEvent) => {
      outsidePointerDown = field.contains(event.target as Node) ? 0 : Date.now()
    }
    document.addEventListener("pointerdown", trackPointer, true)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("pointerdown", trackPointer, true)
      if (restoreTimer !== undefined) clearTimeout(restoreTimer)
    })
  })
  onCleanup(() => props.resize.remove(field))
  return (
    <div
      class="oc-nb-editor"
      classList={{ "is-code": props.highlight, "is-highlighted": highlighted(), "has-pretty": prettyOn() }}
    >
      <Show when={highlighted()}>
        <pre ref={mirror} class="oc-nb-highlight" aria-hidden="true">
          <CodeTokens value={props.value} />
          {"​"}
        </pre>
      </Show>
      <Show when={prettyOn()}>
        <PrettyCode value={props.value} />
      </Show>
      <textarea
        ref={field}
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        rows={1}
        wrap={props.wrap ? "soft" : "off"}
        spellcheck={props.highlight ? false : undefined}
        autocapitalize={props.highlight ? "off" : undefined}
        autocorrect={props.highlight ? "off" : undefined}
        onScroll={syncScroll}
        onFocus={() => setEditing(true)}
        onBlur={blurEditor}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            exitOnce = true
            field.blur()
          }
        }}
        onCompositionStart={() => {
          props.onComposition(true)
          setComposing(true)
        }}
        onCompositionEnd={() => {
          // Capture the committed value before releasing the composition pin.
          props.onInput(field.value)
          setComposing(false)
          props.onComposition(false)
          resize()
        }}
        onInput={(event) => {
          props.onInput(event.currentTarget.value)
          resize()
        }}
      />
    </div>
  )
}

export function NotebookViewer(props: FileViewerProps & { context: ExtensionContext }) {
  const [document, setDocument] = createSignal<ViewerContent>()
  const [folded, setFolded] = createSignal<Record<number, boolean>>({})
  const [drafts, setDrafts] = createSignal<Record<number, string>>({})
  const [outputs, setOutputs] = createSignal<Record<number, Output>>({})
  const [details, setDetails] = createSignal<Record<string, boolean>>({})
  const [full, setFull] = createSignal<Record<string, boolean>>({})
  const [focused, setFocused] = createSignal<number>()
  const [composing, setComposing] = createSignal<number>()
  const [busy, setBusy] = createSignal(false)
  const [running, setRunning] = createSignal<number>()
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  const [fontScale, setFontScale] = createSignal(1)
  const [lineSpacing, setLineSpacing] = createSignal(1)
  const [wordWrap, setWordWrap] = createSignal(true)
  const [formatOpen, setFormatOpen] = createSignal(false)
  const [startMargin, setStartMargin] = createSignal(0)
  // Raw box source loaded for editing cells whose content is not safe text.
  const [rawSources, setRawSources] = createSignal<Record<number, string>>({})
  let scroller!: HTMLElement
  let toolbar!: HTMLElement
  let messages!: HTMLDivElement
  let paper!: HTMLDivElement
  let listAnchor!: HTMLDivElement
  let alive = true
  const textLoads = new Map<number, AbortController>()
  let runController: AbortController | undefined
  let runBatch = false
  const reloadGate = createReloadGate()
  const resize = createEditorResizeQueue((message) => props.context.log.debug(message))
  const setFont = (value: number) => {
    const next = Math.min(2.2, Math.max(0.7, Math.round(value * 100) / 100))
    setFontScale(next)
    try {
      localStorage.setItem("oc-nb-font-scale", String(next))
    } catch {}
  }
  const setSpacing = (value: number) => {
    const next = Math.min(1.5, Math.max(0.8, Math.round(value * 100) / 100))
    setLineSpacing(next)
    try {
      localStorage.setItem("oc-nb-line-height", String(next))
    } catch {}
  }
  const setWrap = (value: boolean) => {
    setWordWrap(value)
    try {
      localStorage.setItem("oc-nb-wrap", value ? "1" : "0")
    } catch {}
  }
  let formatRef: HTMLDivElement | undefined
  onMount(() => {
    try {
      const stored = Number(localStorage.getItem("oc-nb-font-scale"))
      if (stored >= 0.7 && stored <= 2.2) setFontScale(stored)
      const spacing = Number(localStorage.getItem("oc-nb-line-height"))
      if (spacing >= 0.8 && spacing <= 1.5) setLineSpacing(spacing)
      const wrap = localStorage.getItem("oc-nb-wrap")
      if (wrap === "0" || wrap === "1") setWordWrap(wrap === "1")
    } catch {}
    const dismiss = (event: PointerEvent) => {
      if (formatRef && !formatRef.contains(event.target as Node)) setFormatOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFormatOpen(false)
    }
    globalThis.document.addEventListener("pointerdown", dismiss, true)
    globalThis.document.addEventListener("keydown", escape)
    onCleanup(() => {
      globalThis.document.removeEventListener("pointerdown", dismiss, true)
      globalThis.document.removeEventListener("keydown", escape)
    })
  })
  // Outline folds only change display; drafts, outputs and evaluation always
  // address the full cell list by index.
  const cells = createMemo(() => applyOutline(document()?.cells ?? []))
  const visible = createMemo(() => visibleCells(cells(), folded()))
  const keepMounted = createMemo(() => pinnedCellPositions(visible(), focused(), composing()))
  const foldKey = (path: string) => `oc-nb-fold:${path}`
  const storedFolds = (path: string, revision: string) => {
    try {
      const stored = JSON.parse(localStorage.getItem(foldKey(path)) ?? "null")
      if (stored && stored.revision === revision && stored.folds && typeof stored.folds === "object")
        return stored.folds as Record<number, boolean>
    } catch {}
  }
  const persistFolds = (folds: Record<number, boolean>) => {
    const revision = document()?.revision
    try {
      if (revision) localStorage.setItem(foldKey(props.file.absolutePath), JSON.stringify({ revision, folds }))
    } catch {}
  }
  const toggleFold = (cell: ViewerCell) => {
    const next = { ...folded(), [cell.index]: !folded()[cell.index] }
    setFolded(next)
    persistFolds(next)
    const shown = visibleCells(cells(), next)
    props.context.log.debug(
      `notebook fold index=${cell.index} collapsed=${!!next[cell.index]} visible=${shown.length}/${cells().length}`,
    )
    if (next[cell.index] && focused() !== undefined && !shown.some((item) => item.index === focused())) {
      setFocused(undefined)
      ;(globalThis.document.activeElement as HTMLElement | null)?.blur()
    }
  }
  const loadFull = async (key: string) => {
    const index = key.startsWith("cell:") ? Number(key.slice(5)) : -1
    const current = document()
    const cell = current?.cells[index]
    if (cell?.deferred && current) {
      if (textLoads.has(index)) return
      if ((cell.characters ?? 0) > 1024 * 1024) {
        setNotice("This cell exceeds the 1 MiB inline editor limit. Use Source to edit the complete notebook.")
        return
      }
      const controller = new AbortController()
      textLoads.set(index, controller)
      try {
        let text = ""
        while (text.length < (cell.characters ?? 0)) {
          const response = await call<CellsResponse>(
            "notebook.cells",
            {
              revision: current.revision,
              indexes: [index],
              kind: "text",
              offset: text.length,
            },
            controller.signal,
          )
          const chunk = response.cells[0]?.text
          if (!chunk) throw Error("Incomplete notebook text response")
          text += chunk
          if (!alive || document()?.revision !== current.revision || document()?.path !== current.path) return
        }
        setDocument(
          (value) =>
            value && {
              ...value,
              cells: value.cells.map((item) => (item.index === index ? { ...item, text, deferred: false } : item)),
            },
        )
      } catch (error) {
        if (alive && !controller.signal.aborted) setError(String(error))
        return
      } finally {
        if (textLoads.get(index) === controller) textLoads.delete(index)
      }
    }
    setFull((prev) => ({ ...prev, [key]: true }))
  }
  const toggleDetails = (key: string, open: boolean) =>
    setDetails((prev) => (prev[key] === open ? prev : { ...prev, [key]: open }))
  const call = <T,>(method: string, data: object = {}, signal?: AbortSignal) =>
    props.context.rpc.call<T>(
      method,
      { path: props.file.absolutePath, ...data },
      {
        directory: props.file.directory,
        signal,
        timeoutMs: method === "notebook.open" || method === "notebook.cells" ? 20_000 : 3_660_000,
      },
    )
  const previews = createPreviewScheduler(
    (revision, indexes, signal) =>
      call<CellsResponse>("notebook.cells", { revision, indexes, kind: "preview" }, signal),
    (message) => props.context.log.debug(message),
  )
  const adopt = (next: ViewerDocument) => {
    reloadGate.invalidate()
    props.context.log.info(`notebook loaded path=${next.path} cells=${next.cells.length}`)
    const changed = document()?.revision !== next.revision || document()?.path !== next.path
    if (changed) previews.reset(next.revision)
    const previousPath = document()?.path
    batch(() => {
      // Do not retain next.outputs inside document as well as in the live outputs signal.
      setDocument(viewerContent(next))
      setOutputs(next.outputs)
      setDrafts({})
      setRawSources({})
      setDirty(false)
      setNotice("")
      setFocused(undefined)
      setComposing(undefined)
      if (changed) {
        setDetails({})
        setFull({})
        // Fold state comes from the file's serialized group flags, overlaid by
        // stored user folds for this revision, or by the live folds after a
        // save (same path, stable cell indexes).
        const base: Record<number, boolean> = {}
        for (const cell of next.cells) if (cell.closed) base[cell.index] = true
        setFolded({ ...base, ...(storedFolds(next.path, next.revision) ?? (previousPath === next.path ? folded() : {})) })
      }
    })
    props.setDirty?.(false)
  }
  const reload = async (discard = false) => {
    const request = reloadGate.begin()
    const started = performance.now()
    props.context.log.debug(`notebook reload path=${props.file.absolutePath}`)
    try {
      const next = await call<ViewerDocument>("notebook.open", {}, request.signal)
      props.context.log.debug(
        `notebook rpc completed cells=${next.cells.length} rpcMs=${Math.round(performance.now() - started)}`,
      )
      if (!alive || !request.current()) return
      const current = untrack(document)
      if (!discard && current?.revision === next.revision && current.path === next.path) {
        // Same revision: previews are still valid — only outputs can differ.
        setOutputs(next.outputs)
        setError("")
        props.context.log.debug(`notebook reload unchanged cells=${next.cells.length}`)
        return
      }
      // Never replace a draft when an external refresh races with typing.
      if (dirty()) {
        setNotice("File changed. Your draft is kept. Reload discards it; save checks for conflicts.")
        return
      }
      adopt(next)
      setError("")
    } catch (error) {
      if (alive && request.current()) {
        props.context.log.error(`notebook reload failed path=${props.file.absolutePath} error=${String(error)}`)
        setError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      request.finish()
    }
  }
  const action = async (fn: () => Promise<void>, propagate = false) => {
    if (busy()) {
      if (propagate) throw new Error("Notebook is busy")
      return
    }
    // An earlier refresh must not race a save or replace current evaluation state.
    reloadGate.invalidate()
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (error) {
      if (alive) setError(error instanceof Error ? error.message : String(error))
      if (propagate) throw error
    } finally {
      if (alive) {
        setBusy(false)
        setRunning(undefined)
      }
    }
  }
  const save = async (append?: { style: "Input" | "Text"; text: string }) => {
    const current = document()
    if (!current) throw new Error("Notebook has not loaded")
    const next = await call<ViewerDocument>("notebook.save", {
      view: true,
      preview: true,
      revision: current.revision,
      edits: draftEdits(drafts()).filter(({ index, text }) => {
        const cell = current.cells[index]
        return cell && text !== (cell.editable ? cell.text : (rawSources()[index] ?? cell.text))
      }),
      append,
    })
    if (alive) adopt(next)
  }
  const run = async (cell: ViewerCell) => {
    const current = document()
    if (!current) return
    setRunning(cell.index)
    const controller = new AbortController()
    runController = controller
    try {
      const output = await call<Output>(
        "notebook.run",
        {
          index: cell.index,
          revision: current.revision,
          code: cell.editable
            ? (drafts()[cell.index] ?? (cell.deferred ? undefined : cell.text))
            : drafts()[cell.index],
        },
        controller.signal,
      )
      if (alive && document()?.revision === current.revision) setOutputs((prev) => ({ ...prev, [cell.index]: output }))
      if (!output.ok) throw new Error("Cell evaluation failed. See its output.")
    } finally {
      if (alive) setRunning(undefined)
      if (runController === controller) runController = undefined
    }
  }
  const stop = async () => {
    runBatch = false
    runController?.abort()
    try {
      await call("kernel.stop")
      if (alive) setNotice("Kernel stopped. Variables have been reset.")
    } catch (error) {
      if (alive) setError(String(error))
    }
  }
  const edit = (cell: ViewerCell, value: string) => {
    const baseline = cell.editable ? cell.text : rawSources()[cell.index]
    setDrafts((prev) => {
      const next = { ...prev }
      if (baseline !== undefined && value === baseline) delete next[cell.index]
      else next[cell.index] = value
      return next
    })
    if (!cell.editable && drafts()[cell.index] === undefined)
      setRawSources((prev) => {
        const next = { ...prev }
        delete next[cell.index]
        return next
      })
    const changed = (document()?.cells ?? []).some((item) => {
      const draft = drafts()[item.index]
      return draft !== undefined && draft !== (item.editable ? item.text : (rawSources()[item.index] ?? item.text))
    })
    setDirty(changed)
    props.setDirty?.(changed)
  }
  // Box-marked cells have no safe plain text; editing loads the raw cell
  // content (e.g. BoxData[RowBox[...]]) which the server patches verbatim.
  const beginRawEdit = async (cell: ViewerCell) => {
    const current = document()
    if (!current || rawSources()[cell.index] !== undefined) return
    let text = ""
    let total = Infinity
    while (text.length < total) {
      const response = await call<CellsResponse>("notebook.cells", {
        revision: current.revision,
        indexes: [cell.index],
        kind: "source",
        offset: text.length,
      })
      const item = response.cells[0]
      if (!item?.text) return
      text += item.text
      total = item.total ?? text.length
    }
    if (!alive || document()?.revision !== current.revision) return
    // Seed the draft so the editor shows the raw source; dirty only once the
    // user actually changes it (edit() diffs against rawSources as baseline).
    batch(() => {
      setRawSources((prev) => ({ ...prev, [cell.index]: text }))
      setDrafts((prev) => ({ ...prev, [cell.index]: text }))
    })
  }
  createEffect(() => {
    props.revision?.()
    untrack(() => void reload())
  })
  const offSave = props.onSave?.(() => action(() => save(), true))
  const events = props.context.events.on(`${ID}/change`, (data) => {
    const event = data as { path: string; type: string; index: number; output: Output; revision: string }
    if (event.path !== (document()?.path ?? props.file.absolutePath)) return
    if (event.type === "output" && event.revision === document()?.revision)
      setOutputs((prev) => ({ ...prev, [event.index]: event.output }))
    if (event.type === "saved" && !busy()) void reload()
    if (event.type === "saved" && busy()) setNotice("Notebook saved externally. Reload before saving further edits.")
    if (event.type === "stopped") setNotice("Kernel stopped. Variables have been reset.")
  })
  onMount(() => {
    const releaseToolbar = props.setToolbar?.(toolbar)
    onCleanup(() => releaseToolbar?.())
    props.context.log.debug(`notebook toolbar mounted host=${!!props.setToolbar}`)
    let frame: number | undefined
    const measure = () => {
      frame = undefined
      if (!alive) return
      // The host surface uses min-height, not a fixed height. Stay out of flow so
      // notebook rows cannot expand its viewport, but preserve the host menu row.
      const surface = scroller.parentElement
      const menu = scroller.previousElementSibling
      if (surface && menu instanceof HTMLElement) {
        const top = Math.max(
          0,
          menu.getBoundingClientRect().bottom - surface.getBoundingClientRect().top - surface.clientTop,
        )
        scroller.style.setProperty("--oc-nb-surface-top", `${top}px`)
      }
      // Includes actual toolbar wrapping, messages, paper padding and container border.
      const next = listStartMargin(scroller, listAnchor)
      if (Math.abs(next - startMargin()) < 0.5) return
      setStartMargin(next)
      props.context.log.debug(`notebook virtual layout startMargin=${Math.round(next)} buffer=${VIRTUAL_BUFFER_PX}`)
    }
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    for (const element of [scroller, toolbar, messages, paper, scroller.previousElementSibling]) {
      if (element) observer.observe(element)
    }
    measure()
    onCleanup(() => {
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    })
  })
  onCleanup(() => {
    alive = false
    reloadGate.invalidate()
    runBatch = false
    runController?.abort()
    resize.dispose()
    previews.dispose()
    for (const controller of textLoads.values()) controller.abort()
    textLoads.clear()
    offSave?.()
    events.dispose()
    props.setDirty?.(false)
  })

  return (
    <section
      ref={scroller}
      class="oc-nb"
      data-notebook-path={props.file.absolutePath}
      aria-label="Mathematica Notebook"
      data-wrap={wordWrap() ? "on" : "off"}
      style={{ "--oc-nb-fs": String(fontScale()), "--oc-nb-lh": String(lineSpacing()) }}
    >
      <header ref={toolbar} class="oc-nb-toolbar" data-hosted={!!props.setToolbar} aria-label="Notebook actions">
        <div class="oc-nb-actions">
          <button
            disabled={busy() || !document()}
            onClick={() =>
              void action(async () => {
                runBatch = true
                try {
                  // Evaluation always reads original text/drafts, never the display preview or mounted DOM.
                  for (const cell of document()!.cells) {
                    if (!runBatch || !alive) break
                    if (cell.runnable) await run(cell)
                  }
                } finally {
                  runBatch = false
                }
              })
            }
          >
            Run all
          </button>
          <button disabled={!document()} onClick={() => void stop()}>
            Stop / reset
          </button>
          <button disabled={busy() || !dirty()} onClick={() => void action(() => save())}>
            Save{dirty() ? " *" : ""}
          </button>
          <button
            disabled={busy()}
            onClick={() => {
              const discard = dirty()
              setDirty(false)
              props.setDirty?.(false)
              void reload(discard)
            }}
          >
            {dirty() ? "Discard & reload" : "Reload"}
          </button>
        </div>
        <div class="oc-nb-side">
          <div class="oc-nb-format" ref={formatRef}>
            <button
              aria-label="Format"
              title="Format"
              aria-expanded={formatOpen()}
              data-action="format-menu"
              onClick={() => setFormatOpen((open) => !open)}
            >
              Aa
            </button>
            <Show when={formatOpen()}>
              <div class="oc-nb-format-menu" role="menu" aria-label="Format">
                <div class="oc-nb-format-row">
                  <span class="oc-nb-format-label">Font size</span>
                  <div class="oc-nb-fontgroup" role="group" aria-label="Font size">
                    <button
                      aria-label="Decrease font size"
                      title="Decrease font size"
                      onClick={() => setFont(fontScale() - 0.1)}
                    >
                      A−
                    </button>
                    <button class="oc-nb-fontvalue" title="Reset font size" onClick={() => setFont(1)}>
                      {Math.round(fontScale() * 100)}%
                    </button>
                    <button
                      aria-label="Increase font size"
                      title="Increase font size"
                      onClick={() => setFont(fontScale() + 0.1)}
                    >
                      A+
                    </button>
                  </div>
                </div>
                <div class="oc-nb-format-row">
                  <span class="oc-nb-format-label">Line spacing</span>
                  <div class="oc-nb-fontgroup" role="group" aria-label="Line spacing">
                    <button
                      aria-label="Decrease line spacing"
                      title="Decrease line spacing"
                      onClick={() => setSpacing(lineSpacing() - 0.05)}
                    >
                      −
                    </button>
                    <button
                      class="oc-nb-fontvalue"
                      title="Reset line spacing"
                      onClick={() => setSpacing(1)}
                    >
                      {Math.round(lineSpacing() * 100)}%
                    </button>
                    <button
                      aria-label="Increase line spacing"
                      title="Increase line spacing"
                      onClick={() => setSpacing(lineSpacing() + 0.05)}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div class="oc-nb-format-row">
                  <span class="oc-nb-format-label">Word wrap</span>
                  <button
                    type="button"
                    class="oc-nb-switch"
                    role="switch"
                    aria-checked={wordWrap()}
                    title="Word wrap"
                    data-action="toggle-wrap"
                    onClick={() => setWrap(!wordWrap())}
                  >
                    <span class="oc-nb-switch-knob" />
                  </button>
                </div>
              </div>
            </Show>
          </div>
          <button onClick={props.showSource}>Source</button>
        </div>
      </header>
      <div ref={messages} class="oc-nb-messages">
        <Show when={error()}>
          <div class="oc-nb-error" role="alert">
            {error()}
          </div>
        </Show>
        <Show when={notice()}>
          <div class="oc-nb-notice" role="status">
            {notice()}
          </div>
        </Show>
      </div>
      <div ref={paper} class="oc-nb-paper">
        <div ref={listAnchor} class="oc-nb-list">
          <Show
            when={document()}
            fallback={
              <p class="oc-nb-muted">
                {error() ? "Notebook could not be loaded. Reload to retry or open Source." : "Loading notebook..."}
              </p>
            }
          >
            <Virtualizer
              data={visible()}
              scrollRef={scroller}
              startMargin={startMargin()}
              bufferSize={VIRTUAL_BUFFER_PX}
              keepMounted={keepMounted()}
            >
              {(cell) => (
                <article
                  class="oc-nb-cell"
                  data-cell-index={cell.index}
                  data-style={cell.style}
                  onFocusIn={() => setFocused(cell.index)}
                  onFocusOut={(event) => {
                    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                    setFocused((current) => (current === cell.index ? undefined : current))
                  }}
                >
                  <aside
                    class="oc-nb-label"
                    onDblClick={(event) => {
                      if (!isFoldable(cell)) return
                      event.preventDefault()
                      toggleFold(cell)
                    }}
                  >
                    <span class="oc-nb-cell-label">
                      {cell.style === "Input" || cell.style === "Code" ? `In[${cell.index + 1}]:=` : cell.style}
                    </span>
                    <Show when={isFoldable(cell)}>
                      <button
                        class="oc-nb-fold"
                        aria-expanded={!folded()[cell.index]}
                        aria-label={`${folded()[cell.index] ? "Expand" : "Fold"} ${cell.style} group`}
                        title={folded()[cell.index] ? "Expand group" : "Fold group"}
                        onClick={() => toggleFold(cell)}
                      >
                        {folded()[cell.index] ? "▸" : "▾"}
                      </button>
                    </Show>
                    <Show when={cell.runnable}>
                      <button
                        class="oc-nb-run"
                        aria-label={`Run cell ${cell.index + 1}`}
                        aria-busy={running() === cell.index}
                        disabled={busy()}
                        onClick={() => void action(() => run(cell))}
                      >
                        {running() === cell.index ? "Running..." : "Run"}
                      </button>
                    </Show>
                  </aside>
                  <div class="oc-nb-content">
                    <Show
                      when={cell.editable || rawSources()[cell.index] !== undefined}
                      fallback={
                        <RichCell
                          index={cell.index}
                          revision={document()?.revision ?? ""}
                          scheduler={previews}
                          source={async (signal) => {
                            const response = await call<CellsResponse>(
                              "notebook.cells",
                              { revision: document()?.revision, indexes: [cell.index], kind: "source" },
                              signal,
                            )
                            const item = response.cells[0]
                            return { text: item?.text ?? "", total: item?.total ?? 0 }
                          }}
                          onEdit={
                            cell.style === "Input" || cell.style === "Code"
                              ? () => void beginRawEdit(cell)
                              : undefined
                          }
                        />
                      }
                    >
                      <Show
                        when={!cell.deferred && (!isLargeText(cell.text) || full()[`cell:${cell.index}`])}
                        fallback={
                          <TextPreview
                            value={cell.text}
                            characters={cell.characters}
                            onLoad={() => void loadFull(`cell:${cell.index}`)}
                          />
                        }
                      >
                        <CellEditor
                          label={`Cell ${cell.index + 1} (${cell.style})`}
                          disabled={busy()}
                          wrap={wordWrap()}
                          pretty={cell.editable && (cell.style === "Input" || cell.style === "Code")}
                          highlight={cell.style === "Input" || cell.style === "Code" || cell.style === "Output"}
                          value={cellText(cell, drafts())}
                          resize={resize}
                          onComposition={(active) =>
                            setComposing((current) =>
                              active ? cell.index : current === cell.index ? undefined : current,
                            )
                          }
                          onInput={(value) => edit(cell, value)}
                        />
                      </Show>
                    </Show>
                    <Show when={folded()[cell.index]}>
                      <button
                        class="oc-nb-folded"
                        aria-label={`Expand ${cell.style} group`}
                        title="Expand group"
                        onClick={() => toggleFold(cell)}
                      >
                        »
                      </button>
                    </Show>
                    <Show when={outputs()[cell.index]}>
                      {(output) => (
                        <div
                          class="oc-nb-output"
                          classList={{ "is-error": !output().ok }}
                          aria-label={`Output cell ${cell.index + 1}`}
                        >
                          <span class="oc-nb-out-label">Out[{cell.index + 1}]=</span>
                          <Show when={output().printed}>
                            <DeferredText
                              printed
                              value={output().printed}
                              full={!!full()[`printed:${cell.index}`]}
                              onLoad={() => loadFull(`printed:${cell.index}`)}
                            />
                          </Show>
                          <Show
                            when={output().image}
                            fallback={
                              <DeferredText
                                value={output().text || (output().printed ? "" : "Null")}
                                full={!!full()[`output:${cell.index}`]}
                                onLoad={() => loadFull(`output:${cell.index}`)}
                              />
                            }
                          >
                            <img
                              loading="lazy"
                              decoding="async"
                              alt={`Wolfram graphic from cell ${cell.index + 1}`}
                              src={`data:image/png;base64,${output().image}`}
                            />
                            <details
                              open={!!details()[`expression:${cell.index}`]}
                              onToggle={(event) => toggleDetails(`expression:${cell.index}`, event.currentTarget.open)}
                            >
                              <summary>Expression</summary>
                              <Show when={details()[`expression:${cell.index}`]}>
                                <DeferredText
                                  value={output().text}
                                  full={!!full()[`output:${cell.index}`]}
                                  onLoad={() => loadFull(`output:${cell.index}`)}
                                />
                              </Show>
                            </details>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </article>
              )}
            </Virtualizer>
            <div class="oc-nb-add">
              <button disabled={busy()} onClick={() => void action(() => save({ style: "Input", text: "" }))}>
                + Input cell
              </button>
              <button disabled={busy()} onClick={() => void action(() => save({ style: "Text", text: "" }))}>
                + Text cell
              </button>
            </div>
          </Show>
        </div>
        <footer class="oc-nb-footnote">
          Local Wolfram kernel · Shared with agent · Run results are temporary; Save writes cell edits only.
        </footer>
      </div>
    </section>
  )
}

export default defineWebExtension({
  id: ID,
  apiVersion: 1,
  activate(context) {
    context.log.info("activating Mathematica Notebook viewer")
    const viewer = context.fileViewers.register({
      id: "mathematica-notebook",
      component: (props) => <NotebookViewer {...props} context={context} />,
    })
    return () => viewer.dispose()
  },
})
