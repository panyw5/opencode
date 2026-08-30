import { workspaceKey } from "@/pages/layout/helpers"

export type ScheduledTaskPanelScope = { projectID: string; directory: string }

export const sameScheduledTaskPanelScope = (a: ScheduledTaskPanelScope, b: ScheduledTaskPanelScope) =>
  a.projectID === b.projectID && a.directory === b.directory

export const scheduledTaskEventMatchesScope = (eventDirectory: string, scope: ScheduledTaskPanelScope) =>
  workspaceKey(eventDirectory) === scope.directory
