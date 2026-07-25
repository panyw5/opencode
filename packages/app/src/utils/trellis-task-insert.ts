export const TRELLIS_TASK_INSERT_EVENT = "opencode:trellis-task-insert"

export function requestTrellisTaskInsert(title: string) {
  const text = title.trim()
  if (!text || typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<{ text: string }>(TRELLIS_TASK_INSERT_EVENT, {
      detail: { text },
    }),
  )
}
