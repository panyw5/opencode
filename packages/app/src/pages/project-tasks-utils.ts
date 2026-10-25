import type { RecentProjectTask, ProjectTaskStatus } from "@opencode-ai/sdk/v2/client"
import { filterTasks } from "./layout/task-search"

export type ProjectTaskFilter = "active" | "all" | ProjectTaskStatus

export function filterManagedProjectTasks(
  tasks: RecentProjectTask[],
  input: { projectID: string; status: ProjectTaskFilter; query: string; sort: "recent" | "created" },
) {
  const scoped = tasks.filter(
    (task) =>
      (input.projectID === "all" || task.projectID === input.projectID) &&
      (input.status === "all" ||
        (input.status === "active" ? task.status !== "archived" : task.status === input.status)),
  )
  return filterTasks(scoped, input.query, ["title", "projectName", "directory", "id"])
    .slice()
    .sort(
      (a, b) =>
        (input.sort === "recent" ? b.recentAt - a.recentAt : 0) ||
        b.time.created - a.time.created ||
        a.id.localeCompare(b.id),
    )
}
