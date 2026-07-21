import { Identifier } from "@/id/id"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { NonNegativeInt, PositiveInt, optionalOmitUndefined, withStatics } from "@opencode-ai/core/schema"
import { Schema, Types } from "effect"

const taskID = Schema.String.pipe(Schema.brand("ScheduledTaskID"))
export type ScheduledTaskID = typeof taskID.Type
export const ScheduledTaskID = taskID.pipe(
  withStatics((schema: typeof taskID) => ({
    ascending: () => schema.make(Identifier.create("task", "ascending")),
  })),
)

const runID = Schema.String.pipe(Schema.brand("ScheduledTaskRunID"))
export type ScheduledTaskRunID = typeof runID.Type
export const ScheduledTaskRunID = runID.pipe(
  withStatics((schema: typeof runID) => ({
    ascending: () => schema.make(Identifier.create("taskrun", "ascending")),
  })),
)

export const Schedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("at"),
    at: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("every"),
    interval: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: Schema.String,
    timezone: optionalOmitUndefined(Schema.String),
  }),
]).annotate({ identifier: "ScheduledTaskSchedule" })
export type Schedule = Types.DeepMutable<Schema.Schema.Type<typeof Schedule>>

export const ExecutionMode = Schema.Literals(["new_session", "existing_session"])
export type ExecutionMode = Schema.Schema.Type<typeof ExecutionMode>

export const Status = Schema.Literals(["pending", "retrying", "running", "ok", "error", "skipped", "missed"])
export type Status = Schema.Schema.Type<typeof Status>

export const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: optionalOmitUndefined(Schema.String),
})
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ScheduledTaskID,
  projectID: ProjectID,
  projectName: optionalOmitUndefined(Schema.String),
  directory: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schedule,
  executionMode: ExecutionMode,
  sessionID: optionalOmitUndefined(SessionID),
  agent: Schema.String,
  model: Model,
  enabled: Schema.Boolean,
  unattended: Schema.Literal(true),
  nextRunAt: optionalOmitUndefined(NonNegativeInt),
  lastRunAt: optionalOmitUndefined(NonNegativeInt),
  lastStatus: optionalOmitUndefined(Status),
  lastError: optionalOmitUndefined(Schema.String),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
}).annotate({ identifier: "ScheduledTask" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Run = Schema.Struct({
  id: ScheduledTaskRunID,
  taskID: ScheduledTaskID,
  scheduledAt: NonNegativeInt,
  status: Status,
  attempt: NonNegativeInt,
  sessionID: optionalOmitUndefined(SessionID),
  error: optionalOmitUndefined(Schema.String),
  time: Schema.Struct({
    created: NonNegativeInt,
    started: optionalOmitUndefined(NonNegativeInt),
    finished: optionalOmitUndefined(NonNegativeInt),
  }),
}).annotate({ identifier: "ScheduledTaskRun" })
export type Run = Types.DeepMutable<Schema.Schema.Type<typeof Run>>

export const CreateInput = Schema.Struct({
  projectID: ProjectID,
  projectName: Schema.optional(Schema.String),
  directory: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schedule,
  executionMode: Schema.optional(ExecutionMode),
  sessionID: Schema.optional(SessionID),
  agent: Schema.String,
  model: Model,
  enabled: Schema.optional(Schema.Boolean),
  unattended: Schema.Literal(true),
}).annotate({ identifier: "ScheduledTaskCreateInput" })
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  schedule: Schema.optional(Schedule),
  executionMode: Schema.optional(ExecutionMode),
  sessionID: Schema.optional(Schema.NullOr(SessionID)),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Model),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ScheduledTaskUpdateInput" })
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export class InvalidScheduleError extends Schema.TaggedErrorClass<InvalidScheduleError>()(
  "ScheduledTask.InvalidScheduleError",
  { message: Schema.String },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ScheduledTask.NotFoundError", {
  taskID: ScheduledTaskID,
}) {}

export * as ScheduledTaskSchema from "./schema"
