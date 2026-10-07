export function composerBoundary(target: EventTarget | null | undefined) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-prompt-composer]") : undefined
}

export function composerOwnsTarget(editor: HTMLElement | undefined, target: EventTarget | null) {
  const own = composerBoundary(editor)
  return !!own && own === composerBoundary(target)
}

export function mayFocusComposer(editor: HTMLElement | undefined) {
  const element = document.activeElement
  const active = composerBoundary(element)
  if (
    !active &&
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
      element.closest("[data-prevent-autofocus]"))
  )
    return false
  return !!editor?.isConnected && (!active || active === composerBoundary(editor))
}

export function resolveDropComposer(position?: { x: number; y: number }) {
  const hit = position
    ? document.elementsFromPoint(position.x, position.y).map(composerBoundary).find(Boolean)
    : undefined
  return hit
}

export function isMainComposerCommand(id: string | undefined) {
  return (
    !!id &&
    (/^(?:prompt\.|input\.|model\.|agent\.|session\.)/.test(id) ||
      id.startsWith("file.attach") ||
      id === "mcp.toggle" ||
      id === "skill.list")
  )
}
