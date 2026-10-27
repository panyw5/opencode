import { afterEach, describe, expect, mock, test } from "bun:test"
import type { ContentPart, Prompt } from "@/context/prompt"
import { sessionReferenceClipboard } from "./session-reference-clipboard"

mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
mock.module("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
const { createPromptAttachments } = await import("./attachments")
const nativeReader = globalThis.FileReader
const gates: Array<() => void> = []
const roots: HTMLElement[] = []
class GatedReader extends nativeReader {
  override readAsDataURL(file: Blob) {
    gates.push(() => super.readAsDataURL(file))
  }
}

const controller = (
  id: string,
  options?: Partial<Pick<Parameters<typeof createPromptAttachments>[0], "addPart" | "allowSessionReferences">>,
) => {
  const root = document.createElement("div")
  root.dataset.promptComposer = id
  const editor = document.createElement("div")
  editor.tabIndex = 0
  root.append(editor)
  document.body.append(root)
  roots.push(root)
  const state = { prompt: [{ type: "text", content: id, start: 0, end: id.length }] as Prompt, scope: id }
  const api = createPromptAttachments({
    prompt: {
      current: () => state.prompt,
      cursor: () => 0,
      set: (prompt) => {
        state.prompt = prompt
      },
    },
    scope: () => state.scope,
    editor: () => editor,
    isDialogActive: () => false,
    setDraggingType: () => {},
    focusEditor: () => editor.focus(),
    addPart: () => false,
    ...options,
  })
  return { state, api, editor, root }
}
const file = (name = "test.png") => new File(["fixture"], name, { type: "image/png" })
const started = async () => {
  for (let i = 0; i < 50; i++) {
    if (gates.length) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Attachment reader did not start")
}
afterEach(() => {
  globalThis.FileReader = nativeReader
  gates.splice(0)
  roots.splice(0).forEach((root) => root.remove())
})

describe("async attachment isolation", () => {
  test("finishing a paste after focus moves still writes only its original composer", async () => {
    globalThis.FileReader = GatedReader
    const main = controller("main")
    const quick = controller("quick")
    const pending = main.api.addAttachment(file())
    await started()
    quick.editor.focus()
    gates.shift()!()
    expect(await pending).toBe(true)
    expect(main.state.prompt).toHaveLength(2)
    expect(quick.state.prompt).toHaveLength(1)
    expect(document.activeElement).toBe(quick.editor)
  })

  test("an entire multi-file paste is cancelled if its original session changes", async () => {
    globalThis.FileReader = GatedReader
    const main = controller("main")
    const pending = main.api.addAttachments([file("first.png"), file("second.png")], false)
    await started()
    main.state.scope = "other-session"
    gates.shift()!()
    expect(await pending).toBe(false)
    expect(main.state.prompt).toHaveLength(1)
    expect(gates).toHaveLength(0)
  })

  test("closing the originating editor prevents late attachment writes", async () => {
    globalThis.FileReader = GatedReader
    const quick = controller("quick")
    const pending = quick.api.addAttachment(file())
    await started()
    quick.root.remove()
    gates.shift()!()
    expect(await pending).toBe(false)
    expect(quick.state.prompt).toHaveLength(1)
  })
})

describe("session reference paste", () => {
  const reference = {
    type: "session" as const,
    sessionID: "ses_source",
    directory: "/source",
    title: "Source",
    summary: "user: Context",
    updatedAt: 1700000000000,
  }
  const event = (editor: HTMLElement, text: string) => {
    const result = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperties(result, {
      target: { value: editor },
      clipboardData: { value: { items: [], getData: (type: string) => (type === "text/plain" ? text : "") } },
    })
    return result
  }

  test("turns copied references into structured capsules rather than pasting the encoded text", async () => {
    const inserted: ContentPart[] = []
    const main = controller("main", {
      addPart: (part) => {
        inserted.push(part)
        return true
      },
    })
    const paste = event(main.editor, sessionReferenceClipboard(reference))
    await main.api.handlePaste(paste)
    expect(paste.defaultPrevented).toBe(true)
    expect(inserted).toEqual([{ type: "session", reference, content: "@Source", start: 0, end: 7 }])
  })

  test("preserves ordinary paste and does not recognize references in shell mode", async () => {
    const inserted: ContentPart[] = []
    const main = controller("main", {
      allowSessionReferences: () => false,
      addPart: (part) => {
        inserted.push(part)
        return true
      },
    })
    const text = sessionReferenceClipboard(reference)
    await main.api.handlePaste(event(main.editor, text))
    await main.api.handlePaste(event(main.editor, "ordinary text"))
    expect(inserted.map((part) => part.type)).toEqual(["text", "text"])
    expect(inserted[0]).toMatchObject({ content: text })
    expect(inserted[1]).toMatchObject({ content: "ordinary text" })
  })

  test("does not paste a reference into another composer", async () => {
    const inserted: ContentPart[] = []
    const main = controller("main", {
      addPart: (part) => {
        inserted.push(part)
        return true
      },
    })
    const quick = controller("quick")
    await main.api.handlePaste(event(quick.editor, sessionReferenceClipboard(reference)))
    expect(inserted).toEqual([])
  })
})
