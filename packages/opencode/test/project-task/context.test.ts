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
import { UI_LOCALES } from "@opencode-ai/core/locale"
import { projectTaskContextCopy, projectTaskContextLocale } from "@/project-task/context-copy"

function makeDetail(overrides?: Partial<Detail>): Detail {
  return {
    id: ProjectTaskID.make("ptask_test"),
    projectID: ProjectID.make("proj_test"),
    title: "Ship mount UI",
    description: "Mount + inject context",
    descriptionPath: ".project-tasks/ptask_test/prd.md",
    workspaceDirectory: "/repo",
    status: "in_progress",
    sessionCount: 1,
    sessionDirectories: ["/tmp"],
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
    expect(text).toContain('audience="parent"')
    expect(text).toContain("Ship mount UI")
    expect(text).toContain("1/2 completed")
    expect(text).toContain("active item")
    expect(text).not.toContain("done item")
    expect(text).toContain("</project-task-state>")
  })

  test("lists task workspace file paths and summaries", () => {
    const text = formatProjectTaskFullContext({
      detail: makeDetail(),
      workspaceFiles: [
        {
          relativePath: ".project-tasks/ptask_test/prd.md",
          name: "prd.md",
          isDescription: true,
          summary: "Goals, constraints, and acceptance criteria (canonical task brief).",
          bytes: 42,
        },
        {
          relativePath: ".project-tasks/ptask_test/notes.md",
          name: "notes.md",
          isDescription: false,
          summary: "Working notes captured while executing this task.",
          bytes: 100,
        },
      ],
    })
    expect(text).toContain("Task workspace files")
    expect(text).toContain(".project-tasks/ptask_test/prd.md")
    expect(text).toContain("[canonical brief]")
    expect(text).toContain(".project-tasks/ptask_test/notes.md")
    expect(text).toContain("Working notes")
  })

  test("subagent audience uses the concise project background template", () => {
    const text = formatProjectTaskFullContext({
      detail: makeDetail(),
      audience: "subagent",
      locale: "zh",
      workspaceFiles: [
        {
          relativePath: ".project-tasks/ptask_test/prd.md",
          name: "prd.md",
          isDescription: true,
          summary: "Goals, constraints, and acceptance criteria (canonical task brief).",
          bytes: 10,
        },
      ],
    })
    expect(text).toBe(
      [
        '<project-task-state mode="full" audience="subagent">',
        "# 项目任务上下文",
        "",
        "## 用途与边界",
        "",
        "你是主智能体派发的子智能体。本次任务、执行范围和交付要求，以上面主智能体撰写的委派 prompt 为准。",
        "",
        "- 以下内容是父级项目的公共背景，不是对你的额外委派。仅执行主智能体指定的任务；其中适用于本次工作的约定与保护要求仍须遵守。",
        "- 保留用户和其他智能体的已有改动；不要覆盖他人成果。发现协作冲突时向主智能体报告。",
        "",
        "## 父级项目任务信息",
        "",
        "项目任务：Ship mount UI",
        "",
        "项目任务 ID：`ptask_test`。查询本任务相关信息时，使用此 ID",
        "",
        "项目根目录：`/repo`",
        "",
        "## 父级项目任务描述",
        "",
        "Mount + inject context",
        "",
        "</project-task-state>",
      ].join("\n"),
    )
  })

  test("subagent description preserves formulas, formatting, and protection requirements", () => {
    const description = "# Conventions\n\nZ=q^{-c/24} I\n\nDo not overwrite caches.\n"
    const text = formatProjectTaskFullContext({ detail: makeDetail({ description }), audience: "subagent" })
    expect(text).toContain(description)
  })

  test("subagent root is not inferred from another linked session directory", () => {
    const text = formatProjectTaskFullContext({
      detail: makeDetail({ workspaceDirectory: undefined }),
      audience: "subagent",
    })
    expect(text).not.toContain("undefined")
    expect(text).not.toContain("`/tmp`")
  })

  test("emphasizes project_task_list for accurate task IDs", () => {
    const text = formatProjectTaskFullContext(makeDetail())
    expect(text).toContain("project_task_list")
    expect(text).toContain("Task ID hygiene")
    expect(text).toContain("exact `id` from return value")
    expect(text).toContain("Always use the returned `id`")
  })

  test("forbids auto-marking project tasks done without user approval", () => {
    const text = formatProjectTaskFullContext(makeDetail())
    expect(text).toContain("Do NOT mark project tasks done on your own")
    expect(text).toContain("user explicitly asks")
    expect(text).toContain("clearly approve")
  })

  test("closes the linked-session list before the closing tag (markdown indent)", () => {
    const text = formatProjectTaskFullContext(makeDetail())
    // Without a blank line, Markdown treats "</project-task-state>" as a list-item
    // continuation and the UI shows it nested under the last session bullet.
    expect(text).toMatch(/\n\n<\/project-task-state>\s*$/)
    expect(text).not.toMatch(/todos\n<\/project-task-state>/)
  })

  test("legacy alias still returns full brief", () => {
    const text = formatProjectTaskSystemContext(makeDetail())
    expect(text).toContain('mode="full"')
    expect(text).toContain("project-task-state")
  })
})

describe("decideProjectTaskInject", () => {
  test("UI locales using the same template do not trigger a background refresh", () => {
    const detail = makeDetail()
    for (const [from, to, expected] of [
      ["zh", "zht", "zh"],
      ["en", "ja", "en"],
      ["ja", "fr", "en"],
    ]) {
      const first = decideProjectTaskInject({ detail, state: null, audience: "subagent", locale: from })
      if (first.mode !== "full") throw new Error("expected full")
      expect(first.next.snapshots[detail.id]?.locale).toBe(expected)
      expect(decideProjectTaskInject({ detail, state: first.next, audience: "subagent", locale: to }).mode).toBe("skip")
    }
  })

  test("changing template language refreshes background without translating project content", () => {
    const detail = makeDetail({ title: "原始 title", description: "约定：Z=q^{-c/24} I\n\nDo not alter.\n" })
    const first = decideProjectTaskInject({ detail, state: null, audience: "subagent", locale: "zh" })
    if (first.mode !== "full") throw new Error("expected full")
    const updated = decideProjectTaskInject({ detail, state: first.next, audience: "subagent", locale: "en" })
    if (updated.mode !== "delta") throw new Error("expected delta")
    expect(updated.text).toContain("# Project Task Context")
    expect(updated.text).toContain(detail.title)
    expect(updated.text).toContain(detail.description)
    expect(updated.next.snapshots[detail.id]?.locale).toBe("en")
    expect(decideProjectTaskInject({ detail, state: updated.next, audience: "subagent", locale: "en" }).mode).toBe(
      "skip",
    )
  })

  test("subagent skips unrelated updates and refreshes only its project background", () => {
    const detail = makeDetail()
    const first = decideProjectTaskInject({ detail, state: null, audience: "subagent" })
    if (first.mode !== "full") throw new Error("expected full")
    expect(first.text).toContain("Project root: `/repo`")

    const updated = makeDetail({ status: "done", sessionCount: 2 })
    updated.progress.completed = 2
    updated.sessions[0].todos[1].content = "sibling task changed"
    const second = decideProjectTaskInject({
      detail: updated,
      state: first.next,
      hasDurablePart: true,
      audience: "subagent",
    })
    expect(second.mode).toBe("skip")

    updated.description = "New project conventions"
    const third = decideProjectTaskInject({
      detail: updated,
      state: first.next,
      hasDurablePart: true,
      audience: "subagent",
    })
    if (third.mode !== "delta") throw new Error("expected delta")
    expect(third.text).toContain("New project conventions")
    expect(third.text).not.toContain("sibling task changed")
    expect(third.next.snapshots[detail.id]?.description).toBe(updated.description)
  })

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
  test("subagent ignores rollup and workspace file changes", () => {
    const prev = buildTaskContextSnapshot(makeDetail())
    const detail = makeDetail({ status: "done", sessionCount: 3 })
    detail.progress.completed = 2
    detail.sessions[0].todos[1].content = "unrelated sibling work"
    const files = [{ relativePath: "notes.md", name: "notes.md", isDescription: false, summary: "notes", bytes: 50 }]
    expect(formatProjectTaskDeltaContext(detail, prev, files, "subagent")).toBeNull()
  })

  test("subagent background updates never reintroduce rollup or management instructions", () => {
    const prev = buildTaskContextSnapshot(makeDetail())
    const detail = makeDetail({ title: "Updated title", description: "Updated background", sessionCount: 3 })
    detail.sessions[0].todos[1].content = "unrelated sibling work"
    const text = formatProjectTaskDeltaContext(detail, prev, [], "subagent")
    expect(text).toContain('mode="delta" audience="subagent"')
    expect(text).toContain("Project task: Updated title")
    expect(text).toContain("Updated background")
    expect(text).toContain("not an additional assignment")
    for (const noise of [
      "unrelated sibling work",
      "active item",
      "progress",
      "linked sessions",
      "project_task_list",
      "done/archived",
    ]) {
      expect(text).not.toContain(noise)
    }
  })

  test("subagent receives an updated project root", () => {
    const prev = buildTaskContextSnapshot(makeDetail())
    const detail = makeDetail({ workspaceDirectory: "/other-worktree" })
    expect(formatProjectTaskDeltaContext(detail, prev, [], "subagent")).toContain("Project root: `/other-worktree`")
  })

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
    expect(text).toContain("project_task_list")
    expect(text).toContain("Do NOT set status done/archived unless the user explicitly asks")
    expect(text).toContain("</project-task-state>")
  })

  test("reports workspace file changes", () => {
    const detail = makeDetail()
    const prev = buildTaskContextSnapshot(detail, [])
    const files = [
      {
        relativePath: ".project-tasks/ptask_test/notes.md",
        name: "notes.md",
        isDescription: false,
        summary: "Working notes captured while executing this task.",
        bytes: 50,
      },
    ]
    const text = formatProjectTaskDeltaContext(detail, prev, files)
    expect(text).toContain("task workspace files changed")
    expect(text).toContain(".project-tasks/ptask_test/notes.md")
  })
})

describe("project-task template locales", () => {
  for (const locale of UI_LOCALES) {
    test(`${locale} translates only the template`, () => {
      const detail = makeDetail({
        title: "原始标题 / Original title",
        description: "# 原文\n\nZ=q^{-c/24} I\n\n- Keep caches.\n",
        workspaceDirectory: "/Users/example/论文 and notes",
      })
      const copy = projectTaskContextCopy(locale)
      const text = formatProjectTaskFullContext({ detail, audience: "subagent", locale })
      for (const value of Object.values(copy)) {
        expect(value.length).toBeGreaterThan(0)
        expect(text).toContain(value)
      }
      expect(text).toContain(detail.title)
      expect(text).toContain(detail.id)
      expect(text).toContain(detail.workspaceDirectory!)
      expect(text).toContain(detail.description)
      const expected = locale === "zh" || locale === "zht" ? "zh" : "en"
      expect(projectTaskContextLocale(locale)).toBe(expected)
      expect(text).toBe(formatProjectTaskFullContext({ detail, audience: "subagent", locale: expected }))
    })
  }

  test("missing and unsupported locales fall back to English", () => {
    const detail = makeDetail()
    const expected = formatProjectTaskFullContext({ detail, audience: "subagent", locale: "en" })
    expect(formatProjectTaskFullContext({ detail, audience: "subagent" })).toBe(expected)
    expect(formatProjectTaskFullContext({ detail, audience: "subagent", locale: "unsupported" })).toBe(expected)
  })
})
