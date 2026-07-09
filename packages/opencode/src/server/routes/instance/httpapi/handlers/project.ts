import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectID } from "@/project/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForReload } from "../lifecycle"

const log = Log.create({ service: "project.http" })

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: typeof error,
    message: String(error),
  }
}

function projectSummary(item: Project.Info | undefined) {
  if (!item) return undefined
  return {
    id: item.id,
    worktree: item.worktree,
    keys: Object.keys(item),
    timeKeys: Object.keys(item.time),
    sandboxes: item.sandboxes.length,
  }
}

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      const result = yield* svc.list()
      try {
        Schema.decodeUnknownSync(Schema.Array(Project.Info))(result)
        Schema.encodeUnknownSync(Schema.Array(Project.Info))(result)
      } catch (error) {
        log.error("project.list response schema failed", {
          count: result.length,
          first: projectSummary(result[0]),
          error: errorDetails(error),
        })
        throw error
      }
      return result
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      const result = (yield* InstanceState.context).project
      try {
        Schema.decodeUnknownSync(Project.Info)(result)
        Schema.encodeUnknownSync(Project.Info)(result)
      } catch (error) {
        log.error("project.current response schema failed", {
          project: projectSummary(result),
          error: errorDetails(error),
        })
        throw error
      }
      return result
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    return handlers.handle("list", list).handle("current", current).handle("initGit", initGit).handle("update", update)
  }),
)
