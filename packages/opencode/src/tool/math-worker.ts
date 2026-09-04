import { Effect, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import {
  discoverMathWorkers,
  ensureMathWorker,
  startMathWorker,
  statusMathWorker,
  stopMathWorker,
  updateMathWorkerTask,
} from "@/math/worker"
import { mathRoot } from "@/math/layout"
import { MathWorkerEvent } from "@/math/event"
import { Bus } from "@/bus"
import DESCRIPTION_START from "./math_worker_start.txt"
import DESCRIPTION_STATUS from "./math_worker_status.txt"
import DESCRIPTION_STOP from "./math_worker_stop.txt"
import DESCRIPTION_ENSURE from "./math_worker_ensure.txt"
import DESCRIPTION_TASK_UPDATE from "./math_worker_task_update.txt"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.math-worker" })

const StartParameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short title for the worker session" }),
  task: Schema.String.annotate({
    description:
      "TASK.md body: which slice of the proof this worker owns. Must be self-contained — workers cannot read the parent session or anything outside the problem workspace; definitions live in PROBLEM.md or in the task body itself.",
  }),
  project: Schema.optional(Schema.String).annotate({
    description: "Math problem ID under .math/problems/. Defaults to the parent Math Mode session ID.",
  }),
  problem: Schema.optional(Schema.String).annotate({
    description:
      "Full verbatim problem statement (every definition, formula, notation, and constant convention) to persist as PROBLEM.md. Required before the first start on a workspace that has no PROBLEM.md; refused if PROBLEM.md already exists with different content.",
  }),
  references: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Paths of background files (absolute, or relative to this session's workspace) to copy into the problem workspace under references/ so the worker can read them.",
  }),
  model: Schema.optional(Schema.String).annotate({ description: "Worker model as provider/model" }),
  verifier_model: Schema.optional(Schema.String).annotate({ description: "Verifier model as provider/model" }),
  variant: Schema.optional(Schema.String).annotate({ description: "Worker model effort/variant, e.g. high or xhigh" }),
})

const StatusParameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({ description: "If set, only this worker" }),
  project: Schema.optional(Schema.String).annotate({ description: "Math problem ID under .math/problems/." }),
})

const EnsureParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Existing math-worker session id" }),
  project: Schema.optional(Schema.String).annotate({ description: "Math problem ID under .math/problems/." }),
  model: Schema.optional(Schema.String).annotate({ description: "Worker model as provider/model" }),
  verifier_model: Schema.optional(Schema.String).annotate({ description: "Verifier model as provider/model" }),
  variant: Schema.optional(Schema.String).annotate({ description: "Worker model effort/variant" }),
})

const StopParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Worker session id" }),
  force: Schema.optional(Schema.Boolean).annotate({ description: "Use SIGKILL instead of SIGTERM" }),
  project: Schema.optional(Schema.String).annotate({ description: "Math problem ID under .math/problems/." }),
})

const TaskUpdateParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Existing math-worker session id" }),
  task: Schema.String.annotate({
    description:
      "Replacement TASK.md body. It must be self-contained and substantively changed for a content-blocked lane.",
  }),
  project: Schema.optional(Schema.String).annotate({ description: "Math problem ID under .math/problems/." }),
})

export const MathWorkerStartTool = Tool.define(
  "math_worker_start",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: DESCRIPTION_START,
      parameters: StartParameters,
      execute: (params: Schema.Schema.Type<typeof StartParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_worker_start",
            patterns: ["*"],
            always: ["*"],
            metadata: { title: params.title },
          })
          const parent = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          const result = yield* startMathWorker({
            parentSessionID: SessionID.make(ctx.sessionID),
            title: params.title,
            task: params.task,
            project: params.project,
            problem: params.problem,
            references: params.references?.length
              ? params.references.map((reference) => path.resolve(parent.directory, reference))
              : undefined,
            model: params.model,
            verifierModel: params.verifier_model,
            variant: params.variant,
          }).pipe(Effect.provideService(Session.Service, sessions))
          yield* bus.publish(MathWorkerEvent.Status, {
            sessionID: result.sessionID,
            parentSessionID: ctx.sessionID,
            state: result.state,
            alive: true,
            pid: result.pid,
            round: 0,
            reason: "started",
          })
          return {
            title: `math-worker ${result.sessionID}`,
            output: JSON.stringify(result),
            metadata: result,
          }
        }),
    }
  }),
)

export const MathWorkerStatusTool = Tool.define(
  "math_worker_status",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: DESCRIPTION_STATUS,
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_worker_status",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const parent = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          const projectDir = mathRoot(parent.directory, params.project || parent.id)
          const rows = yield* discoverMathWorkers({
            projectDir,
            sessionID: params.session_id,
            parentSessionID: SessionID.make(ctx.sessionID),
          }).pipe(Effect.provideService(Session.Service, sessions))
          for (const row of rows) {
            yield* bus.publish(MathWorkerEvent.Status, {
              sessionID: row.sessionID,
              parentSessionID: row.parentSessionID,
              state: row.state,
              alive: row.alive,
              pid: row.pid,
              round: row.round,
              lastFactId: row.last_fact_id,
              reason: "reconciled",
            })
          }
          return {
            title: `${rows.length} math-worker(s)`,
            output: JSON.stringify(rows),
            metadata: { workers: rows },
          }
        }),
    }
  }),
)

export const MathWorkerEnsureTool = Tool.define(
  "math_worker_ensure",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: DESCRIPTION_ENSURE,
      parameters: EnsureParameters,
      execute: (params: Schema.Schema.Type<typeof EnsureParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_worker_ensure",
            patterns: [params.session_id],
            always: ["*"],
            metadata: { sessionID: params.session_id },
          })
          const parent = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          const projectDir = mathRoot(parent.directory, params.project || parent.id)
          const result = yield* ensureMathWorker({
            sessionID: SessionID.make(params.session_id),
            projectDir,
            model: params.model,
            verifierModel: params.verifier_model,
            variant: params.variant,
          }).pipe(Effect.provideService(Session.Service, sessions), Effect.orDie)
          yield* bus.publish(MathWorkerEvent.Status, {
            sessionID: result.sessionID,
            parentSessionID: ctx.sessionID,
            state: result.state,
            alive: true,
            pid: result.pid,
            round: result.round,
            reason: result.restarted ? "restarted" : "already-running",
          })
          return {
            title: `${result.restarted ? "restarted" : "running"} ${result.sessionID}`,
            output: JSON.stringify(result),
            metadata: result,
          }
        }),
    }
  }),
)

export const MathWorkerStopTool = Tool.define(
  "math_worker_stop",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: DESCRIPTION_STOP,
      parameters: StopParameters,
      execute: (params: Schema.Schema.Type<typeof StopParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_worker_stop",
            patterns: [params.session_id],
            always: ["*"],
            metadata: { force: params.force ?? false },
          })
          const parent = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          const projectDir = mathRoot(parent.directory, params.project || parent.id)
          const result = stopMathWorker({
            projectDir,
            sessionID: params.session_id,
            force: params.force,
          })
          yield* bus.publish(MathWorkerEvent.Status, {
            sessionID: result.sessionID,
            parentSessionID: ctx.sessionID,
            state: result.state,
            alive: result.alive,
            pid: result.pid,
            round: result.round,
            lastFactId: result.last_fact_id,
            reason: params.force ? "force-stop" : "stop-requested",
          })
          return {
            title: `stop ${params.session_id}`,
            output: JSON.stringify(result),
            metadata: result,
          }
        }),
    }
  }),
)

export const MathWorkerTaskUpdateTool = Tool.define(
  "math_worker_task_update",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: DESCRIPTION_TASK_UPDATE,
      parameters: TaskUpdateParameters,
      execute: (params: Schema.Schema.Type<typeof TaskUpdateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_worker_task_update",
            patterns: [params.session_id],
            always: ["*"],
            metadata: { sessionID: params.session_id, length: params.task.length },
          })
          const parent = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
          const worker = yield* sessions.get(SessionID.make(params.session_id)).pipe(Effect.orDie)
          if (worker.agent !== "math-worker" || worker.parentID !== parent.id) {
            log.warn("math worker task update ownership rejected", {
              parentSessionID: parent.id,
              workerSessionID: params.session_id,
              workerParentSessionID: worker.parentID,
              workerAgent: worker.agent,
            })
            throw new Error(`not a math-worker child of this session: ${params.session_id}`)
          }
          const projectDir = mathRoot(parent.directory, params.project || parent.id)
          log.info("math worker task update start", {
            parentSessionID: parent.id,
            workerSessionID: params.session_id,
            projectDir,
            length: params.task.length,
          })
          const result = updateMathWorkerTask(projectDir, params.session_id, params.task)
          const status = statusMathWorker({ projectDir, sessionID: params.session_id })[0]
          yield* bus.publish(MathWorkerEvent.Status, {
            sessionID: params.session_id,
            parentSessionID: ctx.sessionID,
            state: status?.state ?? "missing",
            alive: status?.alive ?? false,
            pid: status?.pid,
            round: status?.round,
            lastFactId: status?.last_fact_id,
            reason: "task-updated",
          })
          log.info("math worker task update finish", {
            parentSessionID: parent.id,
            workerSessionID: params.session_id,
            projectDir,
            state: status?.state ?? "missing",
            alive: status?.alive ?? false,
          })
          return {
            title: `task updated ${params.session_id}`,
            output: JSON.stringify(result),
            metadata: result,
          }
        }),
    }
  }),
)
