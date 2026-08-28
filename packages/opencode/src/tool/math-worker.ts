import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { discoverMathWorkers, ensureMathWorker, startMathWorker, stopMathWorker } from "@/math/worker"
import { mathRoot } from "@/math/layout"
import { MathWorkerEvent } from "@/math/event"
import { Bus } from "@/bus"
import DESCRIPTION_START from "./math_worker_start.txt"
import DESCRIPTION_STATUS from "./math_worker_status.txt"
import DESCRIPTION_STOP from "./math_worker_stop.txt"
import DESCRIPTION_ENSURE from "./math_worker_ensure.txt"

const StartParameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short title for the worker session" }),
  task: Schema.String.annotate({ description: "TASK.md body: which slice of the proof this worker owns" }),
  project: Schema.optional(Schema.String).annotate({
    description: "Math problem ID under .math/problems/. Defaults to the parent Math Mode session ID.",
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
          const result = yield* startMathWorker({
            parentSessionID: SessionID.make(ctx.sessionID),
            title: params.title,
            task: params.task,
            project: params.project,
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
