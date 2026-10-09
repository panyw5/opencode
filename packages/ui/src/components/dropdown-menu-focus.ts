export function keepDialogFocus(event: Event, root: ParentNode = document) {
  const dialog = root.querySelector<HTMLElement>('[data-slot="dialog-content"][data-expanded]')
  if (!dialog) return
  // Menu exit animations finish after the next dialog may have opened. Returning
  // focus to the old trigger would dismiss that dialog through onFocusOutside.
  event.preventDefault()
  const document = dialog.ownerDocument
  const window = document.defaultView
  const focused = document.activeElement
  // Kobalte DropdownMenu focuses its trigger even when this event is prevented.
  // Guard that synchronous focusin before the dialog's outside-focus listener.
  const guard = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-slot="dropdown-menu-trigger"]')) return
    event.stopImmediatePropagation()
  }
  window?.addEventListener("focusin", guard, true)
  queueMicrotask(() => {
    window?.removeEventListener("focusin", guard, true)
    if (dialog.isConnected && focused instanceof HTMLElement && dialog.contains(focused))
      focused.focus({ preventScroll: true })
  })
  console.debug("[dropdown-menu] close autofocus skipped reason=active-dialog")
}
