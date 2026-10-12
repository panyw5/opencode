const contentSelector = '[data-component="markdown"], [data-component="bash-output"], [data-component="tool-output"]'

export function readSessionSelection(
  selection: Pick<Selection, "rangeCount" | "isCollapsed" | "getRangeAt"> | null,
  root: HTMLElement | undefined,
) {
  if (!root || !selection || !selection.rangeCount || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  const allowed = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    return !!element?.closest(contentSelector) && !element.closest('button, input, textarea, [contenteditable="true"]')
  }
  if (!allowed(range.startContainer) || !allowed(range.endContainer)) return
  const length = range.toString().trim().length
  if (!length) return
  return { range: range.cloneRange(), length }
}

export function createSelectionFrameScheduler(
  update: () => void,
  options: { request: (callback: FrameRequestCallback) => number; cancel: (frame: number) => void },
) {
  let frame: number | undefined
  return {
    schedule() {
      if (frame !== undefined) return
      frame = options.request(() => {
        frame = undefined
        update()
      })
    },
    cancel() {
      if (frame === undefined) return
      options.cancel(frame)
      frame = undefined
    },
  }
}
