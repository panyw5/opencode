import type { IconName } from "@opencode-ai/ui/icon"
import { workspaceKey } from "@/pages/layout/helpers"

/**
 * Panels that occupy the sidebar slot and can be minimized to the rail.
 * Keep this in sync with the `sidebarPanel` store union in `pages/layout.tsx`.
 */
export type SidebarPanelKind = "scheduled" | "projectTasks"

/** The project scope a minimized panel must reopen with. */
export type StashedSidebarPanel = {
  kind: SidebarPanelKind
  projectID: string
  directory: string
}

/**
 * One parked item on the rail stash: a minimized sidebar panel or an editor
 * dialog put down mid-edit. `restore` reopens it (editing state included);
 * `id` makes re-stashing the same thing move it to the head, never duplicate.
 * Entries live in memory only — a restart starts with an empty rail.
 */
export type StashedRailEntry = {
  id: string
  label: string
  icon: IconName
  restore: () => void
}

/** Stash an entry: newest first, one entry per id. */
export function stashRailEntry(list: StashedRailEntry[], entry: StashedRailEntry) {
  return [entry, ...list.filter((item) => item.id !== entry.id)]
}

/** Drop an entry by id — used when it is explicitly dismissed or superseded. */
export function unstashRailEntry(list: StashedRailEntry[], id: string) {
  return list.filter((item) => item.id !== id)
}

/** Minimized sidebar panels dedup by kind + worktree, so trailing slashes collapse. */
export const panelStashId = (kind: SidebarPanelKind, directory: string) =>
  `panel:${kind}:${workspaceKey(directory)}`

/** Scheduled task editors dedup by task ("new" = the create dialog) + worktree. */
export const scheduledEditorStashId = (taskID: string | undefined, directory: string) =>
  `dialog:scheduled-task:${taskID ?? "new"}:${workspaceKey(directory)}`

/** Project task detail dialogs dedup by task + worktree. */
export const projectTaskEditorStashId = (taskID: string, directory: string) =>
  `dialog:project-task:${taskID}:${workspaceKey(directory)}`
