import { describe, expect, test } from "bun:test"
import {
  buildTaskContextSnapshot,
  decideProjectTaskInject,
  formatProjectTaskDeltaContext,
  formatProjectTaskFullContext,
  formatProjectTaskSystemContext,
  normalizeInjectState,
} from "@/project-task/context"
import type { Detail } from "@/project-task/schema"
import { ProjectID } from "@/project/schema"
import { ProjectTaskID } from "@/project-task/schema"
import { SessionID } from "@/session/schema"

function makeDetail(overrides?: Partial<Detail>): Detail {
  return {
    id: ProjectTaskID.make("ptask_test"),
    projectID: ProjectID.make("proj_test"),
    title: "Ship mount UI",
    description: "Mount + inject context",
    descriptionPath: ".opentasks/ptask_test/description.md",
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
    ...overrides,
  }
}

describe("formatProjectTaskFullContext", () => {
  test("includes title, status, progress, and open todos", () => {
    const text = formatProjectTaskFullContext(makeDetail())
    expect(text).toContain('mode="full"')
    expect(text).toContain("Ship mount UI")
    expect(text).toContain("1/2 completed")
    expect(text).toContain("active item")
    expect(text).not.toContain("done item")
    expect(text).toContain("</project-task-context>")
  })

  test("closes the linked-session list before the closing tag (markdown indent)", () => {
    const text = formatProjectTaskFullContext(makeDetail())
    // Without a blank line, Markdown treats "</project-task-context>" as a list-item
    // continuation and the UI shows it nested under the last session bullet.
    expect(text).toMatch(/\n\n<\/project-task-context>\s*$/)
    expect(text).not.toMatch(/todos\n<\/project-task-context>/)
  })

  test("legacy alias still returns full brief", () => {
    const text = formatProjectTaskSystemContext(makeDetail())
    expect(text).toContain('mode="full"')
  })
})

describe("decideProjectTaskInject", () => {
  test("first inject for a mounted task is FULL (mid-session mount)", () => {
    const detail = makeDetail()
    const decision = decideProjectTaskInject({ detail, state: null })
    expect(decision.mode).toBe("full")
    if (decision.mode !== "full") return
    expect(decision.text).toContain('mode="full"')
    expect(decision.next.fullInjectedTaskIDs).toContain(detail.id)
    expect(decision.next.snapshots[detail.id]?.title).toBe("Ship mount UI")
  })

  test("same task already FULL-injected with no changes → skip", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null })
    expect(first.mode).toBe("full")
    if (first.mode !== "full") return

    const second = decideProjectTaskInject({ detail, state: first.next, hasDurablePart: true })
    expect(second.mode).toBe("skip")
  })

  test("FULL bookkeeping without durable part re-sends FULL (abort recovery)", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null })
    expect(first.mode).toBe("full")
    if (first.mode !== "full") return

    const recovered = decideProjectTaskInject({
      detail,
      state: first.next,
      hasDurablePart: false,
    })
    expect(recovered.mode).toBe("full")
    if (recovered.mode !== "full") return
    expect(recovered.text).toContain('mode="full"')
  })

  test("todo progress change after FULL → DELTA", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null })
    if (first.mode !== "full") throw new Error("expected full")

    const updated = makeDetail({
      progress: { total: 2, completed: 2, inProgress: 0, pending: 0, cancelled: 0 },
      sessions: [
        {
          sessionID: SessionID.make("ses_a"),
          title: "Impl",
          directory: "/tmp",
          time: { created: 1, updated: 2 },
          progress: { total: 2, completed: 2, inProgress: 0, pending: 0, cancelled: 0 },
          todos: [
            { content: "done item", status: "completed", priority: "medium" },
            { content: "active item", status: "completed", priority: "high" },
          ],
        },
      ],
    })

    const second = decideProjectTaskInject({ detail: updated, state: first.next, hasDurablePart: true })
    expect(second.mode).toBe("delta")
    if (second.mode !== "delta") return
    expect(second.text).toContain('mode="delta"')
    expect(second.text).toContain("progress:")
    expect(second.text).toContain("active item")
    expect(second.next.fullInjectedTaskIDs).toContain(detail.id)
  })

  test("switching mounted task forces FULL for the new task ID", () => {
    const taskA = makeDetail({ id: ProjectTaskID.make("ptask_a"), title: "Task A" })
    const first = decideProjectTaskInject({ detail: taskA, state: null })
    if (first.mode !== "full") throw new Error("expected full")

    const taskB = makeDetail({ id: ProjectTaskID.make("ptask_b"), title: "Task B" })
    const switched = decideProjectTaskInject({ detail: taskB, state: first.next })
    expect(switched.mode).toBe("full")
    if (switched.mode !== "full") return
    expect(switched.text).toContain("Task B")
    expect(switched.next.fullInjectedTaskIDs).toEqual(expect.arrayContaining([taskA.id, taskB.id]))
  })

  test("switching back to a previously FULL-injected task does not re-FULL when unchanged", () => {
    const taskA = makeDetail({ id: ProjectTaskID.make("ptask_a"), title: "Task A" })
    const taskB = makeDetail({ id: ProjectTaskID.make("ptask_b"), title: "Task B" })

    const a1 = decideProjectTaskInject({ detail: taskA, state: null })
    if (a1.mode !== "full") throw new Error("expected full A")
    const b1 = decideProjectTaskInject({ detail: taskB, state: a1.next })
    if (b1.mode !== "full") throw new Error("expected full B")

    const a2 = decideProjectTaskInject({ detail: taskA, state: b1.next, hasDurablePart: true })
    expect(a2.mode).toBe("skip")
  })

  test("clearing inject state (e.g. after compaction) re-sends FULL", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null })
    if (first.mode !== "full") throw new Error("expected full")

    const afterCompact = decideProjectTaskInject({
      detail,
      state: { fullInjectedTaskIDs: [], snapshots: {} },
    })
    expect(afterCompact.mode).toBe("full")
  })

  test("remounting same task after FULL was recorded stays skip when unchanged", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null })
    if (first.mode !== "full") throw new Error("expected full")

    const remount = decideProjectTaskInject({ detail, state: first.next, hasDurablePart: true })
    expect(remount.mode).toBe("skip")
  })

  test("normalizeInjectState accepts legacy single-task shape", () => {
    const detail = makeDetail()
    const snap = buildTaskContextSnapshot(detail)
    const legacy = normalizeInjectState({
      fullInjectedTaskID: detail.id,
      snapshot: snap,
    })
    expect(legacy.fullInjectedTaskIDs).toEqual([detail.id])
    expect(legacy.snapshots[detail.id]?.title).toBe(detail.title)

    const decision = decideProjectTaskInject({ detail, state: legacy })
    expect(decision.mode).toBe("skip")
  })
})

describe("formatProjectTaskDeltaContext", () => {
  test("returns null when snapshot matches", () => {
    const detail = makeDetail()
    const snap = buildTaskContextSnapshot(detail)
    expect(formatProjectTaskDeltaContext(detail, snap)).toBeNull()
  })

  test("reports status change", () => {
    const detail = makeDetail({ status: "done" })
    const prev = buildTaskContextSnapshot(makeDetail({ status: "in_progress" }))
    const text = formatProjectTaskDeltaContext(detail, prev)
    expect(text).toContain("status: in_progress → done")
  })
})
