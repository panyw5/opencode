import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { ProjectLocationTable } from "../project/location.sql"
import { ProjectTaskTable } from "../project-task/project-task.sql"
import type { MessageV2 } from "./message-v2"
import type { SessionMessage } from "@opencode-ai/core/session-message"
import type { Prompt } from "@opencode-ai/core/session-prompt"
import type { Snapshot } from "../snapshot"
import type { Permission } from "../permission"
import type { LocationID, ProjectID } from "../project/schema"
import type { ProjectTaskID } from "../project-task/schema"
import type { SessionID, MessageID, PartID } from "./schema"
import type { WorkspaceID } from "../control-plane/schema"
import { Timestamps } from "../storage/schema.sql"

type PartData = Omit<MessageV2.Part, "id" | "sessionID" | "messageID">
type InfoData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown ? Omit<T, "id" | "sessionID"> : never
type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
export type SessionInputDelivery = "immediate" | "deferred"
/** Stable source-event key; unlike MessageID it may use an `evt_` prefix. */
export type SessionInputID = string
export type SessionInputPrompt = Prompt & {
  /** The parent context used when the notification is materialized after restart. */
  agent?: string
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  /** Synthetic text-part metadata retained verbatim for history compatibility. */
  metadata?: Record<string, unknown>
}

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    location_id: text()
      .$type<LocationID>()
      .references(() => ProjectLocationTable.id, { onDelete: "set null" }),
    workspace_id: text().$type<WorkspaceID>(),
    parent_id: text().$type<SessionID>(),
    slug: text().notNull(),
    directory: text().notNull(),
    path: text(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<{ messageID: MessageID; partID?: PartID; snapshot?: string; diff?: string }>(),
    permission: text({ mode: "json" }).$type<Permission.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    mounted_task_id: text()
      .$type<ProjectTaskID>()
      .references(() => ProjectTaskTable.id, { onDelete: "set null" }),
    /** When true, inject mounted project-task context into each LLM turn. Default true. */
    inject_task_context: integer({ mode: "boolean" }).notNull().default(true),
    /**
     * Server-side bookkeeping for project-task context injection.
     * Not exposed on Session.Info.
     *
     * Shape: `{ fullInjectedTaskIDs: string[], snapshots: Record<taskID, snapshot> }`
     * Tracks which task IDs already received a FULL brief on this session
     * (mid-mount / task-switch safe), plus per-task snapshots for deltas.
     */
    task_context_inject: text({ mode: "json" }).$type<{
      fullInjectedTaskIDs?: string[]
      snapshots?: Record<string, unknown>
      /** @deprecated legacy single-task fields, still read by normalizeInjectState */
      fullInjectedTaskID?: string | null
      snapshot?: unknown | null
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_location_idx").on(table.location_id),
    index("session_project_parent_time_idx").on(table.project_id, table.parent_id, table.time_updated, table.id),
    index("session_project_directory_parent_time_idx").on(
      table.project_id,
      table.directory,
      table.parent_id,
      table.time_updated,
      table.id,
    ),
    index("session_project_path_parent_time_idx").on(
      table.project_id,
      table.path,
      table.parent_id,
      table.time_updated,
      table.id,
    ),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_workspace_parent_time_idx").on(table.workspace_id, table.parent_id, table.time_updated, table.id),
    index("session_parent_idx").on(table.parent_id),
    index("session_mounted_task_idx").on(table.mounted_task_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<InfoData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionInputID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<SessionInputPrompt>(),
    delivery: text().$type<SessionInputDelivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

/**
 * Durable per-session allocator and consumption watermark for deferred inputs.
 *
 * This is intentionally separate from `session_input`: older clients can
 * ignore it, while deleting acknowledged inbox rows cannot make sequence
 * numbers move backwards or erase the model-input consumption boundary.
 */
export const SessionInputCursorTable = sqliteTable("session_input_cursor", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  next_admitted_seq: integer().notNull(),
  next_promoted_seq: integer().notNull(),
  consumed_seq: integer().notNull().default(-1),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$default(() => Date.now()),
})

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
  baseline_seq: integer().notNull(),
})

/**
 * Fork permission model: one row per project, `data` JSON Ruleset.
 * Upstream rewrote to row-level (action/resource); this fork keeps the blob.
 * Ledger ids amazing_prowler / lowly_union_jack are intentional no-ops here;
 * `repairPermissionSchema` reverts any accidental upstream shape on open.
 */
export const PermissionTable = sqliteTable("permission", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})
