export type SessionTabGroup<T> = {
  tab: T
  children: Array<{
    tab: T
    depth: number
  }>
}

export function groupSessionTabs<T>(
  tabs: readonly T[],
  keyOf: (tab: T) => string,
  parentKeyOf: (tab: T) => string | undefined,
): SessionTabGroup<T>[] {
  const byKey = new Map(tabs.map((tab) => [keyOf(tab), tab] as const))

  const resolved = tabs.map((tab) => {
    const origin = keyOf(tab)
    const seen = new Set([origin])
    let current = tab
    let depth = 0

    while (true) {
      const parentKey = parentKeyOf(current)
      if (!parentKey) return { tab, root: keyOf(current), depth }

      const parent = byKey.get(parentKey)
      if (!parent) return { tab, root: keyOf(current), depth }
      if (seen.has(parentKey)) return { tab, root: origin, depth: 0 }

      seen.add(parentKey)
      current = parent
      depth += 1
    }
  })

  const groups = new Map<string, SessionTabGroup<T>>()
  for (const item of resolved) {
    if (item.depth !== 0) continue
    groups.set(item.root, { tab: item.tab, children: [] })
  }

  const children = new Map<string, T[]>()
  for (const item of resolved) {
    if (item.depth === 0) continue
    const parentKey = parentKeyOf(item.tab)
    if (!parentKey) continue
    const list = children.get(parentKey)
    if (list) {
      list.push(item.tab)
      continue
    }
    children.set(parentKey, [item.tab])
  }

  for (const [root, group] of groups) {
    const append = (parent: string, depth: number) => {
      for (const tab of children.get(parent) ?? []) {
        group.children.push({ tab, depth })
        append(keyOf(tab), depth + 1)
      }
    }
    append(root, 1)
  }

  return resolved.flatMap((item) => {
    if (item.depth !== 0) return []
    const group = groups.get(item.root)
    return group ? [group] : []
  })
}

export function reorderSessionTabGroups<T>(
  groups: readonly SessionTabGroup<T>[],
  from: string,
  to: string,
  keyOf: (tab: T) => string,
): SessionTabGroup<T>[] {
  const fromIndex = groups.findIndex((group) => keyOf(group.tab) === from)
  const toIndex = groups.findIndex((group) => keyOf(group.tab) === to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return [...groups]

  const next = [...groups]
  next.splice(toIndex, 0, next.splice(fromIndex, 1)[0])
  return next
}
