import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

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

const controller = (id: string) => {
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
