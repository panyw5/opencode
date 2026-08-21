import * as Tool from "./tool"
import DESCRIPTION from "./task_list.txt"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { Effect, Option, Schema } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"

const log = EffectLogger.create({ service: "tool.task_list" })

export const Parameters = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["children", "descendants"])).annotate({
    description: "List direct children only, or all descendants (default descendants)",
  }),
})

type TaskState = "running" | "retrying" | "completed" | "error" | "unknown" | "idle" | "archived"

type ListedTask = {
  task_id: SessionID
  parent_task_id: SessionID
  depth: number
  title: string
  agent?: string
  state: TaskState
  created_at: number
  updated_at: number
  archived_at?: number
}

function taskState(sessions: Session.Interface, statuses: SessionStatus.Interface, task: Session.Info) {
  return Effect.gen(function* () {
    if (task.time.archived !== undefined) return "archived" as const

    const live = yield* statuses.get(task.id)
    if (live.type === "busy") return "running" as const
    if (live.type === "retry") return "retrying" as const

    const latest = yield* sessions
      .findMessage(task.id, (message) => message.info.role === "assistant")
      .pipe(Effect.catchCause(() => Effect.succeed(Option.none<MessageV2.WithParts>())))
    if (Option.isNone(latest)) return "idle" as const
    if (latest.value.info.role !== "assistant") return "idle" as const
    if (latest.value.info.error) return "error" as const
    if (latest.value.info.time.completed !== undefined) {
      if (latest.value.info.finish === "tool-calls" || latest.value.info.finish === "unknown") return "unknown" as const
      return "completed" as const
    }
    // SessionStatus is process-local. Another desktop/server instance can own
    // the unfinished child while sharing the same durable session database.
    return "unknown" as const
  })
}

export const TaskListTool = Tool.define(
  "task_list",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service

    const run = Effect.fn("TaskListTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const scope = params.scope ?? "descendants"
      yield* log.info("task discovery started", { sessionID: ctx.sessionID, scope })

      const visited = new Set<SessionID>([ctx.sessionID])
      const found: ListedTask[] = []
      const collect: (parentID: SessionID, depth: number) => Effect.Effect<void> = Effect.fn("TaskListTool.collect")(
        function* (parentID, depth) {
          const children = (yield* sessions.children(parentID)).toSorted(
            (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
          )
          yield* log.info("task discovery loaded children", {
            sessionID: ctx.sessionID,
            parentTaskID: parentID,
            depth,
            count: children.length,
          })

          for (const child of children) {
            if (visited.has(child.id)) {
              yield* log.warn("task discovery skipped session cycle", {
                sessionID: ctx.sessionID,
                parentTaskID: parentID,
                taskSessionID: child.id,
              })
              continue
            }
            visited.add(child.id)
            const state = yield* taskState(sessions, statuses, child)
            found.push({
              task_id: child.id,
              parent_task_id: parentID,
              depth,
              title: child.title,
              agent: child.agent,
              state,
              created_at: child.time.created,
              updated_at: child.time.updated,
              archived_at: child.time.archived,
            })
            yield* log.info("task discovery resolved child", {
              sessionID: ctx.sessionID,
              parentTaskID: parentID,
              taskSessionID: child.id,
              depth,
              state,
            })
            if (scope === "descendants") yield* collect(child.id, depth + 1)
          }
        },
      )

      yield* collect(ctx.sessionID, 1)
      yield* log.info("task discovery completed", {
        sessionID: ctx.sessionID,
        scope,
        count: found.length,
      })

      return {
        title: `${found.length} child tasks`,
        metadata: { count: found.length, task_ids: found.map((task) => task.task_id) },
        output: JSON.stringify(
          {
            parent_session_id: ctx.sessionID,
            scope,
            count: found.length,
            tasks: found,
          },
          null,
          2,
        ),
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
