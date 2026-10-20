import * as Tool from "./tool"
import DESCRIPTION from "./task_interrupt.txt"
import type { TaskPromptOps } from "./task"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { Effect, Schema } from "effect"

const log = EffectLogger.create({ service: "tool.task_interrupt" })

export const Parameters = Schema.Struct({
  task_id: SessionID.annotate({ description: "The child task_id returned by task or task_list" }),
  reason: Schema.optional(Schema.String).annotate({
    description:
      "Why the current execution should stop. Send corrective instructions separately when resuming with task.",
  }),
})

function isDescendant(sessions: Session.Interface, parentID: SessionID, task: Session.Info) {
  return Effect.gen(function* () {
    const visited = new Set<SessionID>([task.id])
    let current = task
    while (current.parentID) {
      if (current.parentID === parentID) return true
      if (visited.has(current.parentID)) return false
      visited.add(current.parentID)
      current = yield* sessions.get(current.parentID)
    }
    return false
  })
}

export const TaskInterruptTool = Tool.define(
  "task_interrupt",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const background = yield* BackgroundJob.Service

    const run = Effect.fn("TaskInterruptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* log.info("task interruption requested", {
        sessionID: ctx.sessionID,
        taskSessionID: params.task_id,
        reason: params.reason,
      })
      const task = yield* sessions.get(params.task_id)
      const allowed = task.id !== ctx.sessionID && (yield* isDescendant(sessions, ctx.sessionID, task))
      if (!allowed) {
        yield* log.warn("task interruption rejected unrelated session", {
          sessionID: ctx.sessionID,
          taskSessionID: task.id,
        })
        return yield* Effect.fail(
          new Error("task_id must identify a child task of the current session, not itself or an unrelated session"),
        )
      }

      const directory = yield* InstanceState.directory
      if (AppFileSystem.resolve(task.directory) !== AppFileSystem.resolve(directory)) {
        yield* log.warn("task interruption rejected workspace mismatch", {
          sessionID: ctx.sessionID,
          taskSessionID: task.id,
          directory,
          taskDirectory: task.directory,
        })
        return yield* Effect.fail(
          new Error(
            "The task belongs to another workspace. Stop it in its owning workspace; use math_worker_stop for detached math-workers.",
          ),
        )
      }

      yield* ctx.ask({
        permission: "task_interrupt",
        patterns: [task.id],
        always: ["*"],
        metadata: { task_id: task.id, reason: params.reason },
      })

      const live = yield* statuses.get(task.id)
      const job = yield* background.get(task.id)
      yield* log.info("task interruption resolved local execution", {
        sessionID: ctx.sessionID,
        taskSessionID: task.id,
        status: live.type,
        jobStatus: job?.status,
      })
      if (live.type === "idle" && job?.status !== "running") {
        return {
          title: "No local task execution to interrupt",
          metadata: { task_id: task.id, interrupted: false },
          output: `task_id: ${task.id}\ninterrupted: false\nNo active execution was found on this server. History is unchanged. If another server instance is running this task, stop it there before resuming.`,
        }
      }

      const ops = ctx.extra?.promptOps as Pick<TaskPromptOps, "cancel"> | undefined
      if (!ops?.cancel) return yield* Effect.fail(new Error("TaskInterruptTool requires promptOps in ctx.extra"))
      yield* ctx.metadata({ title: "Interrupting child task", metadata: { task_id: task.id } })
      yield* log.info("task interruption cancelling execution", { sessionID: ctx.sessionID, taskSessionID: task.id })
      yield* ops.cancel(task.id)
      // Cancellation must finish cleanup before a subsequent task(task_id=...) can restart it.
      if (job?.status === "running") yield* background.wait({ id: task.id })
      const after = yield* statuses.get(task.id)
      const remaining = yield* background.get(task.id)
      yield* log.info("task interruption verified execution", {
        sessionID: ctx.sessionID,
        taskSessionID: task.id,
        status: after.type,
        jobStatus: remaining?.status,
      })
      if (after.type !== "idle" || remaining?.status === "running") {
        return yield* Effect.fail(
          new Error("The task is still running; interruption could not be confirmed. Do not resume it yet."),
        )
      }

      return {
        title: "Child task interrupted",
        metadata: { task_id: task.id, interrupted: true },
        output: [
          `task_id: ${task.id}`,
          "interrupted: true",
          "The current execution has stopped. Session history and existing file changes are preserved, not rolled back.",
          "Use task with this same task_id and a new prompt containing your corrections to continue in the same child session.",
          ...(params.reason ? [`reason: ${params.reason}`] : []),
        ].join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
