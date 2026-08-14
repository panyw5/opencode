import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously and returns immediately.",
    "Foreground is the default; use it when you need the result before continuing.",
    "Use background only for independent work that can run while you continue elsewhere.",
    "You will be notified automatically when it finishes.",
  ].join(" "),
].join("\n")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

const BaseParameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "state: running",
    "",
    "<task_result>",
    BACKGROUND_STARTED,
    "</task_result>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [title, `task_id: ${input.sessionID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join(
    "\n",
  )
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      // Hard limit nesting depth via parentID chain (#37124).
      // Default 1: root can spawn subagents; subagents cannot spawn further.
      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      const maxDepth = cfg.subagent_depth ?? 1
      if (depth >= maxDepth) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${maxDepth}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const permission = [
        ...deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          parentAgent,
          subagent: next,
        }),
        ...(cfg.experimental?.primary_tools?.map((item) => ({
          pattern: "*",
          action: "allow" as const,
          permission: item,
        })) ?? []),
      ]
      const { nextSession, metadata } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const created = !session
          const nextSession =
            session ??
            (yield* sessions.create({
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              permission,
              agent: next.name,
            }))

          // Inherit mounted project-task from parent so the child session gets the same
          // task brief (audience=subagent) via SessionPrompt inject. Resume paths keep
          // whatever is already mounted on the child.
          if (created && parent.mountedTaskID && parent.injectTaskContext !== false) {
            yield* sessions.setMountedTask({
              sessionID: nextSession.id,
              taskID: parent.mountedTaskID,
            })
            yield* sessions.setInjectTaskContext({
              sessionID: nextSession.id,
              enabled: true,
            })
          }

          const metadata = {
            parentSessionId: ctx.sessionID,
            sessionId: nextSession.id,
            model,
            ...(runInBackground ? { background: true } : {}),
            ...(created && parent.mountedTaskID
              ? { mountedTaskID: parent.mountedTaskID }
              : {}),
          }

          yield* ctx.metadata({
            title: params.description,
            metadata,
          })

          return { nextSession, metadata }
        }),
      )

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const resumeWhenIdle: (input: { userID: MessageID; state: "completed" | "error" }) => Effect.Effect<void> =
        Effect.fn("TaskTool.resumeWhenIdle")(function* (input: { userID: MessageID; state: "completed" | "error" }) {
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.role === "user")
            .pipe(Effect.orDie)
          if (Option.isNone(latest)) return
          if (latest.value.info.id !== input.userID) return
          const activeAssistant = yield* sessions
            .findMessage(
              ctx.sessionID,
              (item) => item.info.role === "assistant" && typeof item.info.time.completed !== "number",
            )
            .pipe(Effect.orDie)
          if ((yield* status.get(ctx.sessionID)).type !== "idle" || Option.isSome(activeAssistant)) {
            yield* Effect.sleep("300 millis")
            return yield* resumeWhenIdle(input)
          }
          yield* ops
            .loop({ sessionID: ctx.sessionID })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

      const continueIfIdle = Effect.fn("TaskTool.continueIfIdle")(function* (input: {
        userID: MessageID
        state: "completed" | "error"
      }) {
        yield* resumeWhenIdle(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text,
              }),
              metadata: {
                kind: "background-task-injection",
                description: params.description,
                childSessionID: nextSession.id,
                state,
              },
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(
            `Task ${nextSession.id} is already running. Wait for the automatic completion notification before reusing this task_id.`,
          ),
        )
      }

      const cancel = ops.cancel(nextSession.id)

      // When experimental background subagents are enabled, always run via
      // BackgroundJob so a foreground task can be promoted mid-flight without
      // restarting the child session.
      if (flags.experimentalBackgroundSubagents) {
        const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
          yield* background.wait({ id: jobID }).pipe(
            Effect.flatMap((result) => {
              if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
              if (result.info?.status === "error") return inject("error", result.info.error ?? "")
              return Effect.void
            }),
            Effect.ignore,
            Effect.forkIn(scope, { startImmediately: true }),
          )
        })

        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          onPromote: Effect.all(
            [
              ctx.metadata({
                title: params.description,
                metadata: { ...metadata, background: true, jobId: nextSession.id },
              }),
              notify(nextSession.id),
            ],
            { discard: true },
          ),
          run: runTask().pipe(Effect.onInterrupt(() => cancel)),
        })

        const backgroundResult = () => ({
          title: params.description,
          metadata: {
            ...metadata,
            background: true as const,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        })

        if (runInBackground) {
          yield* notify(info.id)
          return backgroundResult()
        }

        function onAbort() {
          runCancel.fork(Effect.all([cancel, background.cancel(nextSession.id)], { discard: true }))
        }

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", onAbort)
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.raceFirst(
                background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                background.waitForPromotion(nextSession.id),
              )
              if (result?.metadata?.background === true) return backgroundResult()
              if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
              if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
              return {
                title: params.description,
                metadata,
                output: output(nextSession.id, result?.output ?? ""),
              }
            }),
          (_, exit) =>
            Effect.gen(function* () {
              if (Exit.hasInterrupts(exit)) {
                yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.abort.removeEventListener("abort", onAbort)
                }),
              ),
            ),
        )
      }

      // Flag off: pure sync wait (no job, no promote).
      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const text = yield* runTask()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, text),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
