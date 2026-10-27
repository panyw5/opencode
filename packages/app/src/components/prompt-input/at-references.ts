export const atCategories = ["all", "external", "session", "projectTask", "scheduledTask"] as const
export type AtCategory = (typeof atCategories)[number]

export function cycleAtCategory(category: AtCategory, reverse = false): AtCategory {
  const index = atCategories.indexOf(category)
  return atCategories[(index + (reverse ? -1 : 1) + atCategories.length) % atCategories.length]
}

export type AtReference = {
  [K in "session" | "projectTask" | "scheduledTask"]: { type: K; id: string; name: string; display: string }
}["session" | "projectTask" | "scheduledTask"]

export function inAtCategory(type: string, category: AtCategory) {
  return category === "all" || (category === "external" ? type === "consult" : type === category)
}

export function atReferenceText(item: AtReference) {
  return `@${item.type} ${JSON.stringify(item.name)} (ID: ${item.id}) `
}

export function projectSessions<T extends { projectID: string }>(sessions: T[], projectID: string) {
  return sessions.filter((session) => session.projectID === projectID)
}
