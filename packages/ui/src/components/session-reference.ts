export type SessionReference = {
  type: "session"
  sessionID: string
  directory: string
  title: string
  summary: string
  updatedAt: number
}

export function readSessionReference(metadata: Record<string, unknown> | undefined): SessionReference | undefined {
  const value = metadata?.sessionReference
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (item.type !== "session" || typeof item.sessionID !== "string" || !/^ses_[\w-]+$/.test(item.sessionID)) return
  if (typeof item.directory !== "string" || !item.directory) return
  if (typeof item.title !== "string" || typeof item.summary !== "string") return
  if (typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt) || Math.abs(item.updatedAt) > 8.64e15)
    return
  return item as SessionReference
}
