import { Identifier } from "@/id/id"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { NonNegativeInt, optionalOmitUndefined, withStatics } from "@opencode-ai/core/schema"
import { Schema, Types } from "effect"

const projectTaskId = Schema.String.pipe(Schema.brand("ProjectTaskID"))
export type ProjectTaskID = typeof projectTaskId.Type
export const ProjectTaskID = projectTaskId.pipe(
  withStatics((schema: typeof projectTaskId) => ({
    ascending: () => schema.make(Identifier.create("ptask", "ascending")),
  })),
)

export const Status = Schema.Literals(["open", "in_progress", "done", "archived"]).annotate({
  identifier: "ProjectTaskStatus",
})
export type Status = Schema.Schema.Type<typeof Status>

export const Progress = Schema.Struct({
  total: NonNegativeInt,
  completed: NonNegativeInt,
  inProgress: NonNegativeInt,
  pending: NonNegativeInt,
  cancelled: NonNegativeInt,
}).annotate({ identifier: "ProjectTaskProgress" })
export type Progress = Types.DeepMutable<Schema.Schema.Type<typeof Progress>>

export const Info = Schema.Struct({
  id: ProjectTaskID,
  projectID: ProjectID,
  title: Schema.String,
  /**
   * Description body loaded from `descriptionPath` (not stored inline in DB for new tasks).
   */
  description: Schema.String,
  /**
   * Project-relative path to the description markdown file
   * (default `.project-tasks/<taskID>/prd.md`).
   */
  descriptionPath: Schema.String,
  status: Status,
  sessionCount: NonNegativeInt,
  progress: Progress,
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    archived: optionalOmitUndefined(NonNegativeInt),
  }),
}).annotate({ identifier: "ProjectTask" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const SessionTodoBundle = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  directory: Schema.String,
  parentID: optionalOmitUndefined(SessionID),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    archived: optionalOmitUndefined(NonNegativeInt),
  }),
  progress: Progress,
  todos: Schema.Array(Todo.Info),
}).annotate({ identifier: "ProjectTaskSessionTodos" })
export type SessionTodoBundle = Types.DeepMutable<Schema.Schema.Type<typeof SessionTodoBundle>>

export const Detail = Schema.Struct({
  ...Info.fields,
  sessions: Schema.Array(SessionTodoBundle),
  /**
   * Absolute directory `descriptionPath` resolves against (git worktree root;
   * instance directory for non-git projects). Lets clients build correct
   * absolute file paths from subdirectory instances.
   */
  workspaceDirectory: Schema.optional(Schema.String),
}).annotate({ identifier: "ProjectTaskDetail" })
export type Detail = Types.DeepMutable<Schema.Schema.Type<typeof Detail>>

export const CreateInput = Schema.Struct({
  title: Schema.String,
  /** Initial description body written to `.project-tasks/<id>/prd.md`. */
  description: Schema.optional(Schema.String),
  status: Schema.optional(Status),
}).annotate({ identifier: "ProjectTaskCreateInput" })
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** When set, overwrites the description file at `descriptionPath`. */
  description: Schema.optional(Schema.String),
  status: Schema.optional(Status),
}).annotate({ identifier: "ProjectTaskUpdateInput" })
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const MountInput = Schema.Struct({
  taskID: ProjectTaskID,
}).annotate({ identifier: "ProjectTaskMountInput" })
export type MountInput = Types.DeepMutable<Schema.Schema.Type<typeof MountInput>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ProjectTask.NotFoundError", {
  taskID: ProjectTaskID,
}) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "ProjectTask.SessionNotFoundError",
  {
    sessionID: SessionID,
  },
) {}

export class InvalidMountError extends Schema.TaggedErrorClass<InvalidMountError>()("ProjectTask.InvalidMountError", {
  message: Schema.String,
}) {}

export * as ProjectTaskSchema from "./schema"
