import { describe, expect, test } from "bun:test"
import { formatProjectTaskSystemContext } from "@/project-task/context"
import type { Detail } from "@/project-task/schema"
import { ProjectID } from "@/project/schema"
import { ProjectTaskID } from "@/project-task/schema"
import { SessionID } from "@/session/schema"

describe("formatProjectTaskSystemContext", () => {
  test("includes title, status, progress, and open todos", () => {
    const detail = {
      id: ProjectTaskID.make("ptask_test"),
      projectID: ProjectID.make("proj_test"),
      title: "Ship mount UI",
      description: "Mount + inject context",
      status: "in_progress",
      sessionCount: 1,
      progress: { total: 2, completed: 1, inProgress: 1, pending: 0, cancelled: 0 },
      time: { created: 1, updated: 2 },
      sessions: [
        {
          sessionID: SessionID.make("ses_a"),
          title: "Impl",
          directory: "/tmp",
          time: { created: 1, updated: 2 },
          progress: { total: 2, completed: 1, inProgress: 1, pending: 0, cancelled: 0 },
          todos: [
            { content: "done item", status: "completed", priority: "medium" },
            { content: "active item", status: "in_progress", priority: "high" },
          ],
        },
      ],
    } satisfies Detail

    const text = formatProjectTaskSystemContext(detail)
    expect(text).toContain("<project-task-context>")
    expect(text).toContain("Ship mount UI")
    expect(text).toContain("1/2 completed")
    expect(text).toContain("active item")
    expect(text).not.toContain("done item")
    expect(text).toContain("</project-task-context>")
  })
})
