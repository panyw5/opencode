import { onCleanup, onMount } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import type { ContentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"
import { composerBoundary, composerOwnsTarget } from "./composer-boundary"

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

type PromptAttachmentsInput = {
  prompt: { current: () => Prompt; cursor: () => number | undefined; set: (prompt: Prompt, cursor?: number) => void }
  scope: () => string
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = input.prompt
  const language = useLanguage()
  const platform = usePlatform()

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const add = async (file: File, toast = true) => {
    const editor = input.editor()
    const scope = input.scope()
    const current = () => !!editor?.isConnected && editor === input.editor() && input.scope() === scope
    console.debug(
      `[prompt-isolation] attachment read start composer=${composerBoundary(editor)?.dataset.promptComposer} scope=${scope}`,
    )
    const mime = await attachmentMime(file)
    if (!current()) {
      console.debug("[prompt-isolation] attachment ignored changed scope or detached editor")
      return false
    }
    if (!mime) {
      if (toast) warn()
      return false
    }

    if (!editor) return false

    const url = await dataUrl(file, mime)
    if (!current()) {
      console.debug("[prompt-isolation] attachment read discarded changed scope or detached editor")
      return false
    }
    if (!url) return false

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      mime,
      dataUrl: url,
    }
    const cursor = prompt.cursor() ?? getCursorPosition(editor)
    prompt.set([...prompt.current(), attachment], cursor)
    console.debug(
      `[prompt-isolation] attachment added composer=${composerBoundary(editor)?.dataset.promptComposer} scope=${scope}`,
    )
    return true
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true) => {
    let found = false
    const editor = input.editor()
    const scope = input.scope()

    for (const file of files) {
      if (!editor?.isConnected || editor !== input.editor() || input.scope() !== scope) {
        console.debug("[prompt-isolation] attachment batch cancelled changed scope or detached editor")
        return found
      }
      const ok = await add(file, false)
      if (ok) found = true
    }

    if (!found && files.length > 0 && toast) warn()
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const editor = input.editor()
    const scope = input.scope()
    if (!composerOwnsTarget(editor, event.target)) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (!editor?.isConnected || input.editor() !== editor || input.scope() !== scope) {
        console.debug("[prompt-isolation] clipboard read discarded changed scope or detached editor")
        return
      }
      if (file) {
        await addAttachment(file)
        return
      }
    }

    if (!plainText) return

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const selection = window.getSelection()
    const ownsSelection = !!selection?.rangeCount && !!editor?.contains(selection.getRangeAt(0).startContainer)
    const inserted =
      ownsSelection && typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  // HTML5 drag events — only used for intra-page dragging (text/@mention)
  // OS file/folder drops are handled via Tauri native events on desktop
  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (foreignComposer(event.target)) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      // On desktop, OS file drops are intercepted by Tauri native handler
      // so this only fires for intra-page file drags
      if (platform.platform !== "desktop") {
        input.setDraggingType("image")
      }
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (foreignComposer(event.target)) return
    if (!composerOwnsTarget(input.editor(), event.relatedTarget)) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (foreignComposer(event.target)) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    // On desktop, OS file drops go through Tauri native events, not HTML5
    if (platform.platform === "desktop") return

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await addAttachments(Array.from(dropped))
  }

  // Handle file drops forwarded from layout.tsx via Tauri native drag events (desktop only)
  const handleNativeFileDrop = (event: Event) => {
    if (input.isDialogActive()) return
    const detail = (event as CustomEvent<{ paths: string[]; composerID?: string; scope?: string }>).detail
    if (!detail?.paths?.length) return
    const own = composerBoundary(input.editor())
    if (!own || own.dataset.promptComposer !== detail.composerID || input.scope() !== detail.scope) return
    console.debug(
      `[prompt-isolation] native drop accepted composer=${detail.composerID} scope=${detail.scope} files=${detail.paths.length}`,
    )

    input.focusEditor()
    for (const filePath of detail.paths) {
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
    }
  }

  const foreignComposer = (target: EventTarget | null) => {
    return !composerOwnsTarget(input.editor(), target)
  }

  onMount(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", handleGlobalDrop)

    // Desktop-only: listen for Tauri native file drop events (forwarded from layout)
    if (platform.platform === "desktop") {
      window.addEventListener("opencode:file-drop", handleNativeFileDrop)
    }
  })

  onCleanup(() => {
    document.removeEventListener("dragover", handleGlobalDragOver)
    document.removeEventListener("dragleave", handleGlobalDragLeave)
    document.removeEventListener("drop", handleGlobalDrop)

    if (platform.platform === "desktop") {
      window.removeEventListener("opencode:file-drop", handleNativeFileDrop)
    }
  })

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
  }
}
