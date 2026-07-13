export function compareByProviderOrder(order: readonly string[], a: string, b: string): number {
  const aIndex = order.indexOf(a)
  const bIndex = order.indexOf(b)
  const aKnown = aIndex >= 0
  const bKnown = bIndex >= 0
  if (aKnown && bKnown) return aIndex - bIndex
  if (aKnown && !bKnown) return -1
  if (!aKnown && bKnown) return 1
  return a.localeCompare(b)
}

export function compareProviderGroups(
  order: readonly string[],
  a: string,
  b: string,
  fallback: readonly string[],
): number {
  if (order.length > 0) return compareByProviderOrder(order, a, b)

  const aIndex = fallback.indexOf(a)
  const bIndex = fallback.indexOf(b)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0
  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.localeCompare(b)
}
