export function scrollQuickEditorCaretIntoView(editor: HTMLDivElement) {
  const selection = editor.ownerDocument.getSelection()
  if (
    editor.ownerDocument.activeElement !== editor ||
    !selection?.rangeCount ||
    !selection.isCollapsed ||
    !editor.contains(selection.anchorNode)
  )
    return

  const caret = selection.getRangeAt(0).getBoundingClientRect()
  if (!caret.height) return
  const bounds = editor.getBoundingClientRect()
  const top = bounds.top + editor.clientTop + 4
  const bottom = bounds.top + editor.clientTop + editor.clientHeight - 4
  const delta = caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0
  if (!delta) return

  const previous = editor.scrollTop
  editor.scrollTop += delta
  console.debug(
    `[quick-assistant:input] caret scroll from=${previous} to=${editor.scrollTop} height=${editor.clientHeight} content=${editor.scrollHeight} caretTop=${caret.top} caretBottom=${caret.bottom}`,
  )
}
