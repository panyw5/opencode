import { createEffect, on, type Accessor } from "solid-js"

export function createEditorSync<T>(input: {
  editor: Accessor<HTMLElement | undefined>
  current: Accessor<T>
  sync: (current: T) => void
}) {
  createEffect(
    on(
      () => [input.editor(), input.current()] as const,
      ([editor, current]) => {
        if (!editor) {
          console.debug("[prompt-editor-sync] deferred reason=editor-unmounted")
          return
        }
        console.debug("[prompt-editor-sync] syncing mounted=true")
        input.sync(current)
      },
    ),
  )
}

export function shouldRender(input: { composing: boolean; mirror: boolean; normalized: boolean; equal: boolean }) {
  if (input.composing) return false
  if (input.mirror) return !input.normalized
  if (input.normalized && input.equal) return false
  return true
}
