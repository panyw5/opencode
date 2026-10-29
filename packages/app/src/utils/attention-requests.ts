export function createAttentionRequestTracker(limit = 500) {
  const seen = new Set<string>()
  return (directory: string, type: "permission.asked" | "question.asked", id: string) => {
    const key = JSON.stringify([directory, type, id])
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > limit) seen.delete(seen.values().next().value!)
    return true
  }
}
