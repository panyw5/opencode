export const PRESENT_TASK_OPEN_EVENT = "opencode:present-task-open"

export type PresentedTaskOpenRequest = {
  sessionID: string
  kind: "project_task" | "scheduled_task"
  taskID: string
}

/**
 * Asks the layout to open the sidebar panel owning a presented task. Emitted by
 * the chat task card, which lives in the ui package and cannot reach layout
 * state directly (same indirection as the presentation source event).
 */
export function openPresentedTask(input: PresentedTaskOpenRequest) {
  window.dispatchEvent(new CustomEvent<PresentedTaskOpenRequest>(PRESENT_TASK_OPEN_EVENT, { detail: input }))
}
