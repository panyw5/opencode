export function parseRetentionDays(text: string): number | undefined {
  const value = text.trim()
  if (!value) return undefined
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1 || days > 3650) return undefined
  return days
}

function equalValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Rebase one UI edit over writes that completed while it was queued. */
export function rebaseChannelMap(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  latest: Record<string, unknown>,
) {
  const result = { ...latest }
  for (const name of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const before = base[name]
    const desired = next[name]
    if (before === undefined && desired !== undefined) {
      result[name] = desired
      continue
    }
    if (before !== undefined && desired === undefined) {
      delete result[name]
      continue
    }
    if (!before || !desired || typeof before !== "object" || typeof desired !== "object") {
      if (!equalValue(before, desired)) result[name] = desired
      continue
    }
    const merged = { ...(result[name] && typeof result[name] === "object" ? result[name] : {}) } as Record<string, unknown>
    for (const field of new Set([...Object.keys(before), ...Object.keys(desired)])) {
      const oldValue = (before as Record<string, unknown>)[field]
      const newValue = (desired as Record<string, unknown>)[field]
      if (equalValue(oldValue, newValue)) continue
      if (Object.prototype.hasOwnProperty.call(desired, field)) merged[field] = newValue
      else delete merged[field]
    }
    result[name] = merged
  }
  return result
}
