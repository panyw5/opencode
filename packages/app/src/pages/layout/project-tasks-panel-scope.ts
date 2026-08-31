export type ProjectTaskPanelScope = { projectID: string; directory: string }

export const sameProjectTaskPanelScope = (a: ProjectTaskPanelScope, b: ProjectTaskPanelScope) =>
  a.projectID === b.projectID && a.directory === b.directory

export const projectTaskEventMatchesScope = (
  input: { directory: string; projectID?: string },
  scope: ProjectTaskPanelScope,
) =>
  input.projectID
    ? input.projectID === scope.projectID
    : input.directory.replaceAll("\\", "/").replace(/\/+$/, "") === scope.directory
