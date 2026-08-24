import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { startMathWorker, statusMathWorker, stopMathWorker } from "@/math/worker"
import { mathRoot } from "@/math/layout"
import path from "path"
import DESCRIPTION_START from "./math_worker_start.txt"
import DESCRIPTION_STATUS from "./math_worker_status.txt"
import DESCRIPTION_STOP from "./math_worker_stop.txt"

const StartParameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short title for the worker session" }),
  task: Schema.String.annotate({ description: "TASK.md body: which slice of the proof this worker owns" }),
  project: Schema.optional(Schema.String).annotate({ description: "Math project name under .math/. Defaults to the workspace directory name." }),
})

const StatusParameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({ description: "If set, only this worker" }),
})

const StopParameters = Schema.Struct({
  session_id: Schema.String.annotate({ description: "Worker session id" }),
  force: Schema.optional(Schema.Boolean).annotate({ description: "Kill the process group instead of writing .stop" }),
})

export const MathWorkerStartTool = Tool.define("math_worker_start", Effect.gen(function* () {
  const sessions = yield* Session.Service
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
        }).pipe(Effect.provideService(Session.Service, sessions))
        return {
          title: `math-worker ${result.sessionID}`,
          output: JSON.stringify(result),
          metadata: result,
        }
      }),
  }
}))

export const MathWorkerStatusTool = Tool.define("math_worker_status", Effect.gen(function* () {
  const sessions = yield* Session.Service
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
        const projectDir = mathRoot(parent.directory, path.basename(parent.directory) || "default")
        const rows = statusMathWorker({
          projectDir,
          sessionID: params.session_id,
          parentSessionID: params.session_id ? undefined : ctx.sessionID,
        })
        return {
          title: `${rows.length} math-worker(s)`,
          output: JSON.stringify(rows),
          metadata: { workers: rows },
        }
      }),
  }
}))

export const MathWorkerStopTool = Tool.define("math_worker_stop", Effect.gen(function* () {
  const sessions = yield* Session.Service
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
        const projectDir = mathRoot(parent.directory, path.basename(parent.directory) || "default")
        const result = stopMathWorker({
          projectDir,
          sessionID: params.session_id,
          force: params.force,
        })
        return {
          title: `stop ${params.session_id}`,
          output: JSON.stringify(result),
          metadata: result,
        }
      }),
  }
}))
