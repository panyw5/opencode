import path from "path"
import { Effect, Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Session } from "@/session/session"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./session_create.txt"

const log = EffectLogger.create({ service: "tool.session_create" })

export const Parameters = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Title of the new session. Omit to use the default title.",
  }),
  directory: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Existing project directory. Defaults to the current directory; relative paths resolve against it.",
  }),
})

export const SessionCreateTool = Tool.define(
  "session_create",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const fs = yield* AppFileSystem.Service

    const run = Effect.fn("SessionCreateTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      const title = params.title?.trim()
      if (title === "" || params.directory?.trim() === "") {
        return yield* Effect.fail(new Error("title and directory must not be blank when provided"))
      }
      const directory = AppFileSystem.resolve(path.resolve(instance.directory, params.directory ?? "."))
      const sameDirectory = directory === AppFileSystem.resolve(instance.directory)
      yield* log.info("session creation requested", { callerSessionID: ctx.sessionID, directory, sameDirectory })

      yield* assertExternalDirectoryEffect(ctx, directory, { kind: "directory" })
      yield* ctx.ask({
        permission: "session_create",
        patterns: [directory],
        always: ["*"],
        metadata: { directory, title },
      })
      yield* log.info("session creation authorized", { callerSessionID: ctx.sessionID, directory })

      if (!(yield* fs.isDir(directory))) {
        return yield* Effect.fail(new Error(`Session directory does not exist or is not a directory: ${directory}`))
      }
      yield* log.info("session directory validated", { callerSessionID: ctx.sessionID, directory })

      // A standalone session must not inherit the caller's workspace when switching projects.
      const create = sessions.create({ title, workspaceID: sameDirectory ? undefined : null })
      const lifecycle = yield* Effect.serviceOption(LocationLifecycle.Service)
      const session = sameDirectory
        ? yield* create
        : yield* lifecycle._tag === "Some"
            ? lifecycle.value.provide({ directory, purpose: "session-create" }, create)
            : instances.provide({ directory }, create)

      yield* log.info("session creation completed", {
        callerSessionID: ctx.sessionID,
        sessionID: session.id,
        directory: session.directory,
        projectID: session.projectID,
      })
      const result = {
        session_id: session.id,
        title: session.title,
        directory: session.directory,
        project_id: session.projectID,
      }
      return {
        title: `Created session: ${session.title}`,
        metadata: result,
        data: result,
        output: JSON.stringify(result, null, 2),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          Effect.tapCause((cause) => log.warn("session creation failed", { callerSessionID: ctx.sessionID, cause })),
          Effect.orDie,
        ),
    }
  }),
)
