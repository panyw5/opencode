import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import type { Agent, Command } from "@opencode-ai/sdk/v2/client"
import type { ContentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createPromptAttachments } from "../prompt-input/attachments"
import { createPromptPair } from "../prompt-input/autocomplete-pair"
import {
  createTextFragment,
  getCursorPosition,
  serialize,
  setCursorPosition,
  setRangeEdge,
} from "../prompt-input/editor-dom"
import { PromptImageAttachments } from "../prompt-input/image-attachments"
import { PromptPopover, type AtOption, type SlashCommand } from "../prompt-input/slash-popover"
import {
  filterAgentsForConsultMentions,
  loadReadyConsultMentions,
  type ReadyConsultMention,
} from "../prompt-input/consult-mentions"
import { mainDomain } from "@/pages/layout/extra-agents"

import { parseQuickEditor, quickPromptText } from "./editor-model"
import { createInputUndoEntry, createInputUndoState, recordInputUndo, stepInputUndo } from "../prompt-input/input-undo"

export function QuickAssistantEditor(props: {
  prompt: Prompt
  directory: string
  agents: Agent[]
  commands: Command[]
  history: Prompt[]
  setRef: (node: HTMLDivElement) => void
  onChange: (prompt: Prompt) => void
  onSend: () => void
  onClose: () => void
}) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [state, setState] = createStore({
    popover: null as "at" | "slash" | null,
    cursor: 0,
    history: -1,
    composing: false,
    consults: [] as ReadyConsultMention[],
    channels: [] as Array<{ channelName: string; botName?: string }>,
  })
  let editor!: HTMLDivElement
  let menu: HTMLDivElement | undefined
  let draft: Prompt = []
  let undo = createInputUndoState(createInputUndoEntry(props.prompt))
  let lastEdit = 0
  let changedPrompt: string | undefined
  const change = (prompt: Prompt) => {
    const time = Date.now()
    undo = recordInputUndo({
      state: undo,
      prev: createInputUndoEntry(props.prompt, state.cursor),
      next: createInputUndoEntry(prompt, state.cursor),
      time,
      last: lastEdit,
    })
    lastEdit = time
    changedPrompt = JSON.stringify(prompt)
    props.onChange(prompt)
  }
  const images = createMemo(() => props.prompt.filter((part): part is ImageAttachmentPart => part.type === "image"))
  createEffect(() => {
    let cancelled = false
    const refresh = () =>
      void loadReadyConsultMentions(platform.cliAgents, platform.gptPro).then((items) => {
        if (!cancelled) setState("consults", items)
      })
    refresh()
    window.addEventListener("gpt-pro:changed", refresh)
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      cancelled = true
      window.removeEventListener("gpt-pro:changed", refresh)
      window.removeEventListener("focus", refresh)
    })
  })
  createEffect(() => {
    const directory = props.directory
    if (!directory) return
    let cancelled = false
    console.debug("[quick-assistant:input] channels load", { directory })
    void sdk
      .forDomain(mainDomain)
      .createClient({ directory, throwOnError: true })
      .im.channels({ directory })
      .then((result) => {
        if (!cancelled)
          setState(
            "channels",
            (result.data ?? []).map((item) => ({
              channelName: item.channelName,
              botName: item.recipient?.name || item.platform,
            })),
          )
        console.debug("[quick-assistant:input] channels loaded", { count: result.data?.length ?? 0 })
      })
      .catch((error) => {
        if (!cancelled) setState("channels", [])
        console.error("[quick-assistant:input] channels failed", error)
      })
    onCleanup(() => {
      cancelled = true
    })
  })
  const search = async (query: string) => {
    const directory = props.directory
    if (!directory) return []
    console.debug("[quick-assistant:input] file search", { directory, query })
    return sdk
      .createClient({ directory, throwOnError: true })
      .find.files({ query, dirs: "true" })
      .then((result) => {
        console.debug("[quick-assistant:input] file search complete", { count: result.data?.length ?? 0 })
        return result.data ?? []
      })
      .catch((error) => {
        console.error("[quick-assistant:input] file search failed", error)
        return []
      })
  }

  const closeMenu = () => setState("popover", null)
  const sync = () => {
    const next = [...parseQuickEditor(editor), ...images()]
    setState("cursor", getCursorPosition(editor))
    change(next)
  }
  const focus = () => {
    editor.focus()
    setCursorPosition(editor, state.cursor)
  }
  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false
    if (!editor.contains(window.getSelection()?.anchorNode ?? null)) focus()
    const selection = window.getSelection()
    if (!selection?.rangeCount) return false
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return false
    let node: Node
    if (part.type === "text") {
      node = createTextFragment(part.content)
    } else {
      const cursor = getCursorPosition(editor)
      const match = serialize(editor)
        .slice(0, cursor)
        .match(/@(\S*)$/)
      if (match) {
        setRangeEdge(editor, range, "start", cursor - match[0].length)
        setRangeEdge(editor, range, "end", cursor)
      }
      const pill = document.createElement("span")
      pill.dataset.type = part.type
      if (part.type === "file") pill.dataset.path = part.path
      if (part.type === "agent") pill.dataset.name = part.name
      if (part.type === "im") {
        pill.dataset.content = part.content
        if (part.channelName) pill.dataset.channelName = part.channelName
        if (part.botName) pill.dataset.botName = part.botName
      }
      pill.contentEditable = "false"
      pill.className = "rounded-md bg-surface-raised-base px-1 text-syntax-property"
      pill.textContent = part.content
      const fragment = document.createDocumentFragment()
      fragment.append(pill, document.createTextNode(" "))
      node = fragment
      console.debug("[quick-assistant:input] mention inserted", { type: part.type })
    }
    const last = node.lastChild
    range.deleteContents()
    range.insertNode(node)
    if (last instanceof HTMLElement && last.tagName === "BR") {
      const placeholder = document.createTextNode("\u200B")
      last.after(placeholder)
      range.setStart(placeholder, 1)
    } else if (last) range.setStartAfter(last)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    sync()
    closeMenu()
    return true
  }
  const atKey = (item: AtOption | undefined) =>
    !item
      ? ""
      : item.type === "file"
        ? `file:${item.path}`
        : item.type === "im"
          ? `im:${item.channelName ?? "all"}`
          : item.type === "consult"
            ? `consult:${item.id}`
            : `agent:${item.name}`
  const selectAt = (item: AtOption | undefined) => {
    if (item?.type === "file") addPart({ type: "file", path: item.path, content: `@${item.path}`, start: 0, end: 0 })
    if (item?.type === "agent" || item?.type === "consult")
      addPart({ type: "agent", name: item.name, content: `@${item.name}`, start: 0, end: 0 })
    if (item?.type === "im")
      addPart({
        type: "im",
        content: `@${item.display}`,
        channelName: item.channelName,
        botName: item.botName,
        start: 0,
        end: 0,
      })
  }
  const selectSlash = (item: SlashCommand | undefined) => {
    if (!item) return
    replace([{ type: "text", content: `/${item.trigger} `, start: 0, end: item.trigger.length + 2 }])
    console.debug("[quick-assistant:input] command selected", { command: item.trigger })
    closeMenu()
  }
  const at = useFilteredList<AtOption>({
    items: async (query) => [
      ...state.consults.map((item) => ({ ...item, type: "consult" as const })),
      ...(state.channels.length
        ? state.channels.map((item) => ({
            ...item,
            type: "im" as const,
            display: `${item.channelName}${item.botName ? ` · ${item.botName}` : ""}`,
          }))
        : [{ type: "im" as const, display: language.t("prompt.at.im") }]),
      ...filterAgentsForConsultMentions(props.agents.filter((agent) => !agent.hidden && agent.mode !== "primary")).map(
        (agent) => ({ type: "agent" as const, name: agent.name, display: agent.name }),
      ),
      ...(await search(query)).map((path) => ({ type: "file" as const, path, display: path })),
    ],
    key: atKey,
    filterKeys: ["display", "name"],
    onSelect: selectAt,
  })
  const slash = useFilteredList<SlashCommand>({
    items: () =>
      props.commands.map((cmd) => ({
        id: cmd.name,
        trigger: cmd.name,
        title: cmd.name,
        description: cmd.description,
        source: cmd.source,
        type: "custom" as const,
      })),
    key: (item) => item?.id,
    filterKeys: ["trigger", "title"],
    onSelect: selectSlash,
  })
  const refresh = () => {
    const text = serialize(editor)
    const cursor = getCursorPosition(editor)
    setState("cursor", cursor)
    const match = text.slice(0, cursor).match(/@(\S*)$/)
    if (match) {
      at.onInput(match[1])
      setState("popover", "at")
      return
    }
    const command = text.match(/^\/(\S*)$/)
    if (command) {
      slash.onInput(command[1])
      setState("popover", "slash")
      return
    }
    closeMenu()
  }
  const replace = (prompt: Prompt) => {
    setState("cursor", quickPromptText(prompt).length)
    change(prompt)
    queueMicrotask(focus)
  }
  const attachments = createPromptAttachments({
    prompt: { current: () => props.prompt, cursor: () => state.cursor, set: change },
    editor: () => editor,
    isDialogActive: () => !!dialog.active,
    setDraggingType: () => {},
    focusEditor: focus,
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })
  const pair = createPromptPair({ editor: () => editor, addPart })
  createEffect(
    on(
      () => JSON.stringify(props.prompt),
      () => {
        const prompt = props.prompt
        const key = JSON.stringify(prompt)
        console.debug(
          `[quick-assistant:input] draft sync origin=${key === changedPrompt ? "editor" : "external"} text=${quickPromptText(prompt).length} dom=${serialize(editor).length}`,
        )
        if (key !== changedPrompt) {
          undo = createInputUndoState(createInputUndoEntry(prompt))
          lastEdit = 0
        }
        if (
          !editor ||
          JSON.stringify(parseQuickEditor(editor)) === JSON.stringify(prompt.filter((part) => part.type !== "image"))
        )
          return
        editor.replaceChildren()
        for (const part of prompt) {
          if (part.type === "image") continue
          if (part.type === "text") editor.append(createTextFragment(part.content))
          if (part.type === "file" || part.type === "agent" || part.type === "im") {
            const pill = document.createElement("span")
            pill.dataset.type = part.type
            if (part.type === "file") pill.dataset.path = part.path
            if (part.type === "agent") pill.dataset.name = part.name
            if (part.type === "im") {
              pill.dataset.content = part.content
              if (part.channelName) pill.dataset.channelName = part.channelName
              if (part.botName) pill.dataset.botName = part.botName
            }
            pill.contentEditable = "false"
            pill.className = "rounded-md bg-surface-raised-base px-1 text-syntax-property"
            pill.textContent = part.content
            editor.append(pill)
          }
        }
        if (document.activeElement === editor) setCursorPosition(editor, state.cursor)
      },
    ),
  )
  createEffect(() => {
    state.popover
    at.active()
    slash.active()
    queueMicrotask(() => menu?.querySelector("[data-prompt-popover-active]")?.scrollIntoView({ block: "nearest" }))
  })
  onCleanup(() => console.debug("[quick-assistant:input] editor unmounted"))

  return (
    <div data-component="quick-assistant-input" class="relative z-10">
      <PromptPopover
        popover={state.popover}
        setPopoverRef={(node) => {
          menu = node
        }}
        atFlat={at.flat()}
        atActive={at.active() ?? undefined}
        atKey={atKey}
        setAtActive={at.setActive}
        onAtSelect={selectAt}
        slashFlat={slash.flat()}
        slashActive={slash.active() ?? undefined}
        setSlashActive={slash.setActive}
        onSlashSelect={selectSlash}
        commandKeybind={() => undefined}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <PromptImageAttachments
        attachments={images()}
        onRemove={attachments.removeAttachment}
        onOpen={(item) => dialog.show(() => <ImagePreview src={item.dataUrl} alt={item.filename} />)}
        removeLabel={language.t("prompt.attachment.remove")}
      />
      <div class="relative">
        <div
          ref={(node) => {
            editor = node
            props.setRef(node)
          }}
          contentEditable={true}
          role="textbox"
          aria-multiline="true"
          aria-label={language.t("prompt.editor.title")}
          data-placeholder="Ask about the current OpenCode session or a quick task..."
          class="w-full min-h-[84px] max-h-64 cursor-text overflow-y-auto bg-transparent px-4 pt-3.5 pb-1 text-14-regular text-text-strong outline-none whitespace-pre-wrap break-words empty:before:pointer-events-none empty:before:content-[attr(data-placeholder)] empty:before:text-text-weaker"
          style={{ "line-height": "26px" }}
          onPaste={attachments.handlePaste}
          onInput={() => {
            console.debug(`[quick-assistant:input] input text=${serialize(editor).length}`)
            sync()
            setState("history", -1)
            refresh()
          }}
          onClick={refresh}
          onMouseEnter={(event) => {
            const node = event.currentTarget
            console.debug("[quick-assistant:input] hover", {
              editable: node.isContentEditable,
              cursor: getComputedStyle(node).cursor,
              placeholderPointerEvents: getComputedStyle(node, "::before").pointerEvents,
              hitEditor: document.elementFromPoint(event.clientX, event.clientY) === node,
            })
          }}
          onBlur={() => {
            setState("composing", false)
            closeMenu()
          }}
          onCompositionStart={() => setState("composing", true)}
          onCompositionEnd={() => {
            setState("composing", false)
            sync()
            refresh()
          }}
          onKeyDown={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation()
            if (state.composing || event.isComposing || event.keyCode === 229) return
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
            ) {
              event.stopPropagation()
              event.preventDefault()
              const next = stepInputUndo(undo, event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo")
              if (!next) return
              undo = next.state
              changedPrompt = JSON.stringify(next.entry.prompt)
              setState("cursor", next.entry.cursor)
              props.onChange(next.entry.prompt)
              closeMenu()
              queueMicrotask(focus)
              console.debug("[quick-assistant:input] undo/redo", { index: undo.index })
              return
            }
            if (state.popover) {
              if (event.key === "Escape") {
                event.preventDefault()
                closeMenu()
                return
              }
              if (
                ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key) ||
                (event.ctrlKey && ["n", "p"].includes(event.key))
              ) {
                event.stopPropagation()
                event.preventDefault()
                const list = state.popover === "at" ? at : slash
                if (event.key === "Tab") list.onKeyDown(new KeyboardEvent("keydown", { key: "Enter" }))
                else list.onKeyDown(event)
                return
              }
            }
            if (pair.handlePairKeyDown(event)) return
            if (event.key === "Escape") {
              event.preventDefault()
              props.onClose()
              return
            }
            if (
              (event.key === "ArrowUp" && getCursorPosition(editor) === 0) ||
              (event.key === "ArrowDown" &&
                state.history >= 0 &&
                getCursorPosition(editor) === serialize(editor).length)
            ) {
              const next =
                event.key === "ArrowUp" ? Math.min(state.history + 1, props.history.length - 1) : state.history - 1
              if (next === state.history) return
              event.preventDefault()
              if (state.history < 0) draft = props.prompt.slice()
              setState("history", next)
              replace(next < 0 ? draft : props.history[next])
              return
            }
            if (event.key === "Enter") {
              event.stopPropagation()
              event.preventDefault()
              if (event.shiftKey) addPart({ type: "text", content: "\n", start: 0, end: 0 })
              else props.onSend()
            }
          }}
        />
      </div>
    </div>
  )
}
