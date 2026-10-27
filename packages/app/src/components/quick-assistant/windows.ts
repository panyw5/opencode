export type AssistantWindow = {
  id: string
  number: number
  session?: string
  title?: string
  context: boolean
  variant?: string
}

export type AssistantWindows = {
  open: boolean
  maximized: boolean
  windows: AssistantWindow[]
  active?: string
  next: number
}

export function initialAssistantWindows(): AssistantWindows {
  return {
    open: false,
    maximized: false,
    windows: [{ id: "legacy", number: 1, context: false }],
    active: "legacy",
    next: 2,
  }
}

export function migrateAssistantWindows(value: unknown): AssistantWindows {
  const initial = initialAssistantWindows()
  if (!value || typeof value !== "object") return initial
  const saved = value as Partial<AssistantWindows> & {
    session?: Record<string, string | undefined>
    context?: boolean
    variant?: string
  }
  if (!Array.isArray(saved.windows)) {
    return {
      ...initial,
      open: !!saved.open,
      maximized: !!saved.maximized,
      windows: [
        { ...initial.windows[0], session: saved.session?.__quick__, context: !!saved.context, variant: saved.variant },
      ],
    }
  }
  const ids = new Set<string>()
  const windows = saved.windows.filter((item) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      ids.has(item.id)
    )
      return false
    ids.add(item.id)
    return true
  })
  return {
    open: !!saved.open && windows.length > 0,
    maximized: !!saved.maximized,
    windows,
    active: ids.has(saved.active ?? "") ? saved.active : windows[0]?.id,
    next: Math.max(Number.isSafeInteger(saved.next) ? saved.next! : 1, ...windows.map((item) => item.number + 1), 1),
  }
}

export function activeAfterClose(windows: AssistantWindow[], active: string | undefined, closing: string) {
  if (active !== closing) return active
  const index = windows.findIndex((item) => item.id === closing)
  return windows[index + 1]?.id ?? windows[index - 1]?.id
}

export function assistantWindowTitle(title: string | undefined, question = "") {
  const value = title?.trim()
  const placeholder = !value || value === "Quick Assistant" || /^New session - \d{4}-\d{2}-\d{2}T/.test(value)
  const text = (placeholder ? question : value).replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return text.length > 100 ? text.slice(0, 97) + "..." : text
}
