import { workspaceKey } from "@/pages/layout/helpers"

export function filterActiveProjects<T extends { worktree: string }>(projects: T[], active: Array<{ worktree: string }>) {
  const keys = new Set(active.map((project) => workspaceKey(project.worktree)))
  return projects.filter((project) => keys.has(workspaceKey(project.worktree)))
}

export function filterTasksForActiveProjects<T extends { projectID: string }>(
  tasks: T[],
  projects: Array<{ id: string }>,
) {
  const ids = new Set(projects.map((project) => project.id))
  return tasks.filter((task) => ids.has(task.projectID))
}
