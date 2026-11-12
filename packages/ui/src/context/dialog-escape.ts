export function nestedDialogEscape(target: EventTarget | null) {
  return (
    target instanceof Element && !!target.closest('[role="dialog"]:not([data-slot="dialog-content"]), [role="menu"]')
  )
}
