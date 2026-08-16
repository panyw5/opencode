import type { Detail } from "./schema"
import type { TaskWorkspaceFile } from "./description-file"
import { descriptionRelativePath, taskWorkspaceRelativePath } from "./description-file"

/** Who receives the inject brief — main session vs task/subagent child. */
export type ProjectTaskInjectAudience = "parent" | "subagent"

/** Fingerprint of last injected project-task context for a session. */
export type TaskContextSnapshot = {
  taskID: string
  title: string
  status: string
  description: string
  progress: {
    total: number
    completed: number
    inProgress: number
    pending: number
    cancelled: number
  }
  sessionCount: number
  /** Open todos across linked sessions (pending + in_progress). */
  openTodos: Array<{
    sessionID: string
    status: string
    content: string
  }>
  /**
   * Fingerprint of task-workspace files (path + bytes). Used so adding/removing
   * files under `.project-tasks/<id>/` triggers a delta inject.
   */
  workspaceFiles: Array<{ relativePath: string; bytes: number }>
}

/**
 * Per-session inject bookkeeping (not part of public Session.Info).
 *
 * Keyed by task ID so mid-session mount and task switches are correct:
 * - First time this session injects task A → FULL, record A
 * - Later turns on A → DELTA or skip
 * - Switch to B → FULL for B (A stays recorded)
 * - Switch back to A → still DELTA/skip (FULL already done for A), unless compaction cleared state
 */
export type TaskContextInjectState = {
  /** Task IDs that have already received a FULL brief in this session. */
  fullInjectedTaskIDs: string[]
  /** Last injected snapshot per task ID (for delta). */
  snapshots: Record<string, TaskContextSnapshot>
}

export type InjectDecision =
  | { mode: "full"; text: string; next: TaskContextInjectState }
  | { mode: "delta"; text: string; next: TaskContextInjectState }
  | { mode: "skip" }

/** Normalize legacy single-task state or partial JSON from DB. */
export function normalizeInjectState(raw: unknown): TaskContextInjectState {
  if (raw == null || typeof raw !== "object") {
    return { fullInjectedTaskIDs: [], snapshots: {} }
  }
  const obj = raw as Record<string, unknown>

  // Current shape
  if (Array.isArray(obj.fullInjectedTaskIDs) || obj.snapshots) {
    const ids = Array.isArray(obj.fullInjectedTaskIDs)
      ? obj.fullInjectedTaskIDs.filter((id): id is string => typeof id === "string" && id.length > 0)
      : []
    const snapshots: Record<string, TaskContextSnapshot> = {}
    if (obj.snapshots && typeof obj.snapshots === "object") {
      for (const [k, v] of Object.entries(obj.snapshots as Record<string, unknown>)) {
        if (v && typeof v === "object") snapshots[k] = v as TaskContextSnapshot
      }
    }
    return { fullInjectedTaskIDs: [...new Set(ids)], snapshots }
  }

  // Legacy shape: { fullInjectedTaskID, snapshot }
  const legacyID =
    typeof obj.fullInjectedTaskID === "string" && obj.fullInjectedTaskID.length > 0
      ? obj.fullInjectedTaskID
      : null
  const legacySnap =
    obj.snapshot && typeof obj.snapshot === "object" ? (obj.snapshot as TaskContextSnapshot) : null
  const snapshots: Record<string, TaskContextSnapshot> = {}
  if (legacyID && legacySnap) snapshots[legacyID] = legacySnap
  return {
    fullInjectedTaskIDs: legacyID ? [legacyID] : [],
    snapshots,
  }
}

function withSnapshot(state: TaskContextInjectState, taskID: string, snapshot: TaskContextSnapshot): TaskContextInjectState {
  const fullInjectedTaskIDs = state.fullInjectedTaskIDs.includes(taskID)
    ? state.fullInjectedTaskIDs
    : [...state.fullInjectedTaskIDs, taskID]
  return {
    fullInjectedTaskIDs,
    snapshots: { ...state.snapshots, [taskID]: snapshot },
  }
}

const FULL_SESSION_LIMIT = 20
const FULL_TODO_LIMIT = 16
const DELTA_TODO_LIMIT = 12

function progressLine(progress: TaskContextSnapshot["progress"]): string {
  return (
    `${progress.completed}/${progress.total} completed` +
    (progress.inProgress ? `, ${progress.inProgress} in progress` : "")
  )
}

function collectOpenTodos(
  detail: Detail,
  sessionLimit: number,
  todoLimit: number,
): TaskContextSnapshot["openTodos"] {
  const out: TaskContextSnapshot["openTodos"] = []
  for (const session of detail.sessions.slice(0, sessionLimit)) {
    const open = session.todos.filter((t) => t.status === "pending" || t.status === "in_progress")
    for (const todo of open.slice(0, todoLimit)) {
      out.push({
        sessionID: session.sessionID,
        status: todo.status,
        content: todo.content,
      })
    }
  }
  return out
}

export function buildTaskContextSnapshot(
  detail: Detail,
  workspaceFiles: TaskWorkspaceFile[] = [],
): TaskContextSnapshot {
  return {
    taskID: detail.id,
    title: detail.title,
    status: detail.status,
    description: detail.description.trim(),
    progress: {
      total: detail.progress.total,
      completed: detail.progress.completed,
      inProgress: detail.progress.inProgress,
      pending: detail.progress.pending,
      cancelled: detail.progress.cancelled,
    },
    sessionCount: detail.sessionCount,
    openTodos: collectOpenTodos(detail, FULL_SESSION_LIMIT, FULL_TODO_LIMIT),
    workspaceFiles: workspaceFiles.map((f) => ({ relativePath: f.relativePath, bytes: f.bytes })),
  }
}

function workspaceFilesEqual(
  a: TaskContextSnapshot["workspaceFiles"] | undefined,
  b: TaskContextSnapshot["workspaceFiles"] | undefined,
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i].relativePath !== right[i].relativePath || left[i].bytes !== right[i].bytes) return false
  }
  return true
}

function snapshotsEqual(a: TaskContextSnapshot, b: TaskContextSnapshot): boolean {
  if (
    a.taskID !== b.taskID ||
    a.title !== b.title ||
    a.status !== b.status ||
    a.description !== b.description ||
    a.sessionCount !== b.sessionCount ||
    a.progress.total !== b.progress.total ||
    a.progress.completed !== b.progress.completed ||
    a.progress.inProgress !== b.progress.inProgress ||
    a.progress.pending !== b.progress.pending ||
    a.progress.cancelled !== b.progress.cancelled ||
    a.openTodos.length !== b.openTodos.length ||
    !workspaceFilesEqual(a.workspaceFiles, b.workspaceFiles)
  ) {
    return false
  }
  for (let i = 0; i < a.openTodos.length; i++) {
    const x = a.openTodos[i]
    const y = b.openTodos[i]
    if (x.sessionID !== y.sessionID || x.status !== y.status || x.content !== y.content) return false
  }
  return true
}

function todoKey(t: { sessionID: string; content: string; status: string }) {
  return `${t.sessionID}\0${t.content}`
}

/** Shared ID hygiene rules for project-task inject briefs. */
function projectTaskIdHygieneLines(): string[] {
  return [
    "CRITICAL — Task ID hygiene (do this every time you target a task):",
    "1. Call `project_task_list` first and take the exact `id` from that tool's return value.",
    "2. Use only that returned `id` for `project_task_get` / `project_task_update` / `project_task_mount`.",
    "3. NEVER retype, guess, or hand-copy a taskID from chat, memory, or this brief — IDs are easy to mistype.",
    "4. Matching by title alone is not enough: resolve title → id via `project_task_list` (or the list/get/create/mount tool result you just received).",
  ]
}

/** Shared status rules — agents must not auto-complete project tasks. */
function projectTaskStatusRulesLines(): string[] {
  return [
    "CRITICAL — Do NOT mark project tasks done on your own:",
    "1. NEVER set status to `done` or `archived` just because implementation/todos look finished.",
    "2. Only mark done when the user explicitly asks, or after you ask and they clearly approve.",
    "3. Prefer reporting progress and asking \"mark this task done?\" over silently updating status.",
    "4. Session todos (`todowrite`) may track local steps; project-task status is a user-owned decision.",
  ]
}

function audienceIntroLines(audience: ProjectTaskInjectAudience): string[] {
  if (audience === "subagent") {
    return [
      "You are a subagent working under a parent session that mounted this project-level task.",
      "Focus on the delegated work for this task. Prefer reading task workspace files below when you need goals or notes.",
      "Do not re-mount or unmount the project task unless the user (via the parent) explicitly requires it.",
      "Do not spawn further subagents solely to re-load this task context — it is already injected here.",
    ]
  }
  return [
    "The user mounted (or switched to) this project-level task on this session.",
    "This is the FULL working brief for this task. Later turns may only send deltas or omit context when unchanged.",
    "When you dispatch a `task` subagent, it inherits this mount and receives a subagent-scoped brief automatically.",
  ]
}

function formatWorkspaceFilesSection(detail: Detail, workspaceFiles: TaskWorkspaceFile[]): string[] {
  const workspace = taskWorkspaceRelativePath(detail.id)
  const descriptionPath =
    (detail.descriptionPath?.trim() || descriptionRelativePath(detail.id)).replace(/\\/g, "/")

  const lines: string[] = [
    "",
    "Task workspace files (project-relative; read with the Read tool when you need full content):",
    `- workspace: ${workspace}/`,
  ]

  if (workspaceFiles.length === 0) {
    lines.push(
      `- ${descriptionPath} — Goals, constraints, and acceptance criteria (canonical task brief).`,
      "  (No other files found under the task workspace yet. Agents may add notes here.)",
    )
    return lines
  }

  for (const file of workspaceFiles) {
    const mark = file.isDescription ? " [canonical brief]" : ""
    lines.push(`- ${file.relativePath}${mark} — ${file.summary}`)
  }
  return lines
}

function formatLinkedSessionsSection(detail: Detail): string[] {
  const lines: string[] = ["", `Linked sessions: ${detail.sessionCount}`]
  for (const session of detail.sessions.slice(0, FULL_SESSION_LIMIT)) {
    lines.push(
      `- ${session.title} (${session.sessionID}): ${session.progress.completed}/${session.progress.total} todos`,
    )
    const open = session.todos
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .slice(0, FULL_TODO_LIMIT)
    for (const todo of open) {
      lines.push(`    · [${todo.status}] ${todo.content}`)
    }
  }
  if (detail.sessions.length > FULL_SESSION_LIMIT) {
    lines.push(`… and ${detail.sessions.length - FULL_SESSION_LIMIT} more sessions`)
  }
  return lines
}

export type FormatProjectTaskContextInput = {
  detail: Detail
  /** Files under `.project-tasks/<taskID>/` (paths + short summaries). */
  workspaceFiles?: TaskWorkspaceFile[]
  /** parent = main/orchestrator session; subagent = task-tool child session. */
  audience?: ProjectTaskInjectAudience
}

/** Format a full project-task brief (first inject for a task on this session). */
export function formatProjectTaskFullContext(
  detailOrInput: Detail | FormatProjectTaskContextInput,
  maybeFiles?: TaskWorkspaceFile[],
): string {
  // Support both new options object and legacy (detail, files?) call shapes used in tests.
  const input: FormatProjectTaskContextInput =
    detailOrInput && typeof detailOrInput === "object" && "detail" in detailOrInput
      ? detailOrInput
      : { detail: detailOrInput as Detail, workspaceFiles: maybeFiles }

  const detail = input.detail
  const workspaceFiles = input.workspaceFiles ?? []
  const audience = input.audience ?? "parent"

  const lines: string[] = [
    `<project-task-state mode="full" audience="${audience}">`,
    ...audienceIntroLines(audience),
    ...projectTaskIdHygieneLines(),
    ...projectTaskStatusRulesLines(),
    `Task ID (mounted; still prefer list-return when calling tools): ${detail.id}`,
    `Title: ${detail.title}`,
    `Status: ${detail.status}`,
  ]
  lines.push(`Todo progress (all linked sessions): ${progressLine(detail.progress)}`)
  if (detail.description.trim()) {
    lines.push("", "Description:", detail.description.trim())
  }
  lines.push(...formatWorkspaceFilesSection(detail, workspaceFiles))
  // Parent keeps the multi-session rollup; subagents get a shorter view (still list count).
  if (audience === "parent") {
    lines.push(...formatLinkedSessionsSection(detail))
  } else {
    lines.push(
      "",
      `Linked sessions (parent project task): ${detail.sessionCount}. Prefer this session's local todos for your step checklist.`,
    )
  }
  // Blank line ends the markdown list so the closing tag is not a list-item continuation.
  lines.push("", "</project-task-state>")
  return lines.join("\n")
}

/** Format incremental updates since the last injected snapshot. Returns null if nothing meaningful changed. */
export function formatProjectTaskDeltaContext(
  detail: Detail,
  prev: TaskContextSnapshot,
  workspaceFiles: TaskWorkspaceFile[] = [],
  audience: ProjectTaskInjectAudience = "parent",
): string | null {
  const next = buildTaskContextSnapshot(detail, workspaceFiles)
  if (snapshotsEqual(prev, next)) return null

  const lines: string[] = [
    `<project-task-state mode="delta" audience="${audience}">`,
    `Updates for mounted task ${detail.id} (${detail.title}) since the last inject.`,
    "Full brief was already provided earlier in this session — apply only these changes.",
    "Before get/update/mount on any target task: call `project_task_list` and use the exact `id` from the tool return — do not hand-copy IDs.",
    "Do NOT set status done/archived unless the user explicitly asks or clearly approves after you ask.",
  ]

  if (prev.title !== next.title) lines.push(`- title: ${prev.title} → ${next.title}`)
  if (prev.status !== next.status) lines.push(`- status: ${prev.status} → ${next.status}`)
  if (prev.description !== next.description) {
    lines.push("- description changed:")
    lines.push(next.description || "(empty)")
  }
  if (
    prev.progress.total !== next.progress.total ||
    prev.progress.completed !== next.progress.completed ||
    prev.progress.inProgress !== next.progress.inProgress ||
    prev.progress.pending !== next.progress.pending ||
    prev.progress.cancelled !== next.progress.cancelled
  ) {
    lines.push(`- progress: ${progressLine(prev.progress)} → ${progressLine(next.progress)}`)
  }
  if (prev.sessionCount !== next.sessionCount) {
    lines.push(`- linked sessions: ${prev.sessionCount} → ${next.sessionCount}`)
  }

  if (!workspaceFilesEqual(prev.workspaceFiles, next.workspaceFiles)) {
    lines.push("- task workspace files changed:")
    if (workspaceFiles.length === 0) {
      lines.push("    · (no files currently listed)")
    } else {
      for (const file of workspaceFiles.slice(0, 16)) {
        lines.push(`    · ${file.relativePath} — ${file.summary}`)
      }
      if (workspaceFiles.length > 16) {
        lines.push(`    · … and ${workspaceFiles.length - 16} more`)
      }
    }
  }

  const prevMap = new Map(prev.openTodos.map((t) => [todoKey(t), t]))
  const nextMap = new Map(next.openTodos.map((t) => [todoKey(t), t]))

  const completed: string[] = []
  const added: string[] = []
  const statusChanged: string[] = []

  for (const [key, before] of prevMap) {
    const after = nextMap.get(key)
    if (!after) {
      completed.push(`[${before.sessionID}] ${before.content}`)
    } else if (after.status !== before.status) {
      statusChanged.push(`[${before.sessionID}] ${before.content}: ${before.status} → ${after.status}`)
    }
  }
  for (const [key, after] of nextMap) {
    if (!prevMap.has(key)) {
      added.push(`[${after.status}] [${after.sessionID}] ${after.content}`)
    }
  }

  if (completed.length) {
    lines.push("- open todos no longer open (completed/cancelled/removed):")
    for (const item of completed.slice(0, DELTA_TODO_LIMIT)) lines.push(`    · ${item}`)
    if (completed.length > DELTA_TODO_LIMIT) lines.push(`    · … and ${completed.length - DELTA_TODO_LIMIT} more`)
  }
  if (added.length) {
    lines.push("- new open todos:")
    for (const item of added.slice(0, DELTA_TODO_LIMIT)) lines.push(`    · ${item}`)
    if (added.length > DELTA_TODO_LIMIT) lines.push(`    · … and ${added.length - DELTA_TODO_LIMIT} more`)
  }
  if (statusChanged.length) {
    lines.push("- open todo status changes:")
    for (const item of statusChanged.slice(0, DELTA_TODO_LIMIT)) lines.push(`    · ${item}`)
    if (statusChanged.length > DELTA_TODO_LIMIT) {
      lines.push(`    · … and ${statusChanged.length - DELTA_TODO_LIMIT} more`)
    }
  }

  // Header is 5 lines; if nothing concrete was listed, still emit a progress anchor.
  if (lines.length <= 5) {
    lines.push(`- snapshot changed (progress ${progressLine(next.progress)}, sessions ${next.sessionCount})`)
  }

  // Blank line ends any trailing markdown list so the closing tag stays top-level.
  lines.push("", "</project-task-state>")
  return lines.join("\n")
}

/**
 * Decide what (if anything) to inject for this turn.
 *
 * Rules (mid-session mount / task switch aware):
 * - If this session has never FULL-injected the *current* mounted task ID → FULL
 * - Else if that task's snapshot unchanged → skip (no inject)
 * - Else → DELTA for that task
 *
 * Compaction should clear inject state so the next turn re-FULLs.
 */
/** Metadata.kind for durable user-message parts shown in the InjectedPrompt UI. */
export const PROJECT_TASK_INJECTION_KIND = "project-task-injection" as const

export function isProjectTaskInjectionPart(part: {
  type: string
  synthetic?: boolean
  metadata?: Record<string, unknown> | null
}): boolean {
  return (
    part.type === "text" &&
    !!part.synthetic &&
    part.metadata?.kind === PROJECT_TASK_INJECTION_KIND
  )
}

/** True if this session history already has a durable inject part for the given task. */
export function hasProjectTaskInjectionPart(
  messages: Array<{ parts: Array<{ type: string; synthetic?: boolean; metadata?: Record<string, unknown> | null }> }>,
  taskID: string,
): boolean {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isProjectTaskInjectionPart(part)) continue
      if (part.metadata?.taskID === taskID) return true
    }
  }
  return false
}

/**
 * Drop FULL bookkeeping for a task so the next decide() re-sends a FULL brief.
 * Used when bookkeeping claims FULL but no durable part exists (abort / desync).
 */
export function clearTaskFromInjectState(state: TaskContextInjectState, taskID: string): TaskContextInjectState {
  const normalized = normalizeInjectState(state)
  const { [taskID]: _removed, ...snapshots } = normalized.snapshots
  return {
    fullInjectedTaskIDs: normalized.fullInjectedTaskIDs.filter((id) => id !== taskID),
    snapshots,
  }
}

export function decideProjectTaskInject(input: {
  detail: Detail
  state: TaskContextInjectState | null | undefined
  /**
   * When false, bookkeeping that claims FULL is treated as stale (no durable part in
   * history). Forces a re-FULL so the model and UI both receive the brief again.
   */
  hasDurablePart?: boolean
  /** Files under `.project-tasks/<taskID>/` for path+summary inject. */
  workspaceFiles?: TaskWorkspaceFile[]
  /** parent (default) vs subagent child session. */
  audience?: ProjectTaskInjectAudience
}): InjectDecision {
  const workspaceFiles = input.workspaceFiles ?? []
  const audience = input.audience ?? "parent"
  const snapshot = buildTaskContextSnapshot(input.detail, workspaceFiles)
  let state = normalizeInjectState(input.state)
  const taskID = input.detail.id

  // Bookkeeping without a durable message part → recover with FULL.
  if (input.hasDurablePart === false && state.fullInjectedTaskIDs.includes(taskID)) {
    state = clearTaskFromInjectState(state, taskID)
  }

  const alreadyFullForThisTask = state.fullInjectedTaskIDs.includes(taskID)

  if (!alreadyFullForThisTask) {
    return {
      mode: "full",
      text: formatProjectTaskFullContext({ detail: input.detail, workspaceFiles, audience }),
      next: withSnapshot(state, taskID, snapshot),
    }
  }

  const prev = state.snapshots[taskID]
  if (!prev || prev.taskID !== taskID) {
    // Full flag set but snapshot missing/stale — re-send FULL to re-anchor.
    return {
      mode: "full",
      text: formatProjectTaskFullContext({ detail: input.detail, workspaceFiles, audience }),
      next: withSnapshot(state, taskID, snapshot),
    }
  }

  const delta = formatProjectTaskDeltaContext(input.detail, prev, workspaceFiles, audience)
  if (!delta) return { mode: "skip" }

  return {
    mode: "delta",
    text: delta,
    next: withSnapshot(state, taskID, snapshot),
  }
}

/** @deprecated Prefer decideProjectTaskInject / formatProjectTaskFullContext. Kept for callers expecting a single full block. */
export function formatProjectTaskSystemContext(detail: Detail): string {
  return formatProjectTaskFullContext({ detail })
}
