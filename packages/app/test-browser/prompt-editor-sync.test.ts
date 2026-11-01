import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createEditorSync } from "../src/components/prompt-input/sync"

describe("prompt editor mount lifecycle", () => {
  test("defers DOM reads when reading mode starts without an editor, then restores the latest draft", () => {
    const [state, setState] = createStore<{ editor?: HTMLElement; draft: string }>({ draft: "initial draft" })
    const updates: string[] = []
    const dispose = createRoot((dispose) => {
      createEditorSync({
        editor: () => state.editor,
        current: () => state.draft,
        sync: (draft) => {
          // This DOM read reproduces the original crash if sync runs too early.
          updates.push(`${state.editor!.childNodes.length}:${draft}`)
          state.editor!.textContent = draft
        },
      })
      return dispose
    })
    try {
      expect(updates).toEqual([])
      setState("draft", "loaded while reading")
      expect(updates).toEqual([])
      const editor = document.createElement("div")
      setState("editor", editor)
      expect(editor.textContent).toBe("loaded while reading")
      expect(updates).toEqual(["0:loaded while reading"])
    } finally {
      dispose()
    }
  })

  test("replays unchanged drafts on remount and never writes to the detached editor", () => {
    const first = document.createElement("div")
    const [state, setState] = createStore<{ editor?: HTMLElement; draft: string }>({ editor: first, draft: "draft" })
    const dispose = createRoot((dispose) => {
      createEditorSync({
        editor: () => state.editor,
        current: () => state.draft,
        sync: (draft) => (state.editor!.textContent = draft),
      })
      return dispose
    })
    try {
      expect(first.textContent).toBe("draft")
      setState("editor", undefined)
      setState("draft", "updated while hidden")
      expect(first.textContent).toBe("draft")
      const second = document.createElement("div")
      setState("editor", second)
      expect(second.textContent).toBe("updated while hidden")
      setState("editor", undefined)
      const third = document.createElement("div")
      setState("editor", third)
      expect(third.textContent).toBe("updated while hidden")
    } finally {
      dispose()
    }
  })
})
