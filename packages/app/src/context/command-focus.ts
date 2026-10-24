export type CommandKeybindScope = "session"

const selector = "[data-command-scope]"
const interactive =
  "input,textarea,select,button,a[href],summary,[contenteditable],[tabindex],[data-prompt-composer],[data-prevent-autofocus]"

function boundary(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null
}

export function keybindScopeMatches(
  scope: CommandKeybindScope | undefined,
  target: EventTarget | null,
  active: Element | null = document.activeElement,
) {
  if (!scope) return true
  const root = boundary(target)
  return !!(
    root?.isConnected &&
    root.dataset.commandScope === scope &&
    root === boundary(active) &&
    !root.closest('[hidden],[inert],[aria-hidden="true"]')
  )
}

export function focusCommandScope(root: HTMLElement, target: EventTarget | null) {
  if (!(target instanceof Element) || boundary(target) !== root) return false
  const control = target.closest(interactive)
  if (control && control !== root) return false
  if (document.activeElement !== root) {
    root.focus({ preventScroll: true })
    console.debug(
      `[command-focus] pointer scope=${root.dataset.commandScope ?? "none"} focused=${document.activeElement === root}`,
    )
  }
  return document.activeElement === root
}
