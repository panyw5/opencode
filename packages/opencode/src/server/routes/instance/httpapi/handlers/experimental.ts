import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionContentSearch } from "@/session/content-search"
import { BackgroundJob } from "@/background/job"
import { Database } from "@/storage/db"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ConsoleSwitchPayload,
  SessionContentSearchAction,
  SessionContentSearchQuery,
  SessionListQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "experimental.http" })

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const background = yield* BackgroundJob.Service
    log.info("session-content-search:background-job-service-ready")

    const startContentBackfill = () =>
      background.start({
        id: "session-content-search-backfill",
        type: "session-content-search",
        title: "Session content index",
        run: SessionContentSearch.backfill().pipe(Effect.as("complete")),
      })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: Worktree.CreateInput | undefined
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const sessions = Array.from(
        Session.listGlobal({
          directory: ctx.query.directory,
          roots: ctx.query.roots,
          start: ctx.query.start,
          cursor: ctx.query.cursor,
          search: ctx.query.search,
          limit: limit + 1,
          archived: ctx.query.archived,
        }),
      )
      const list = sessions.length > limit ? sessions.slice(0, limit) : sessions
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          sessions.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionContentSearch = Effect.fn("ExperimentalHttpApi.sessionContentSearch")(function* (ctx: {
      query: typeof SessionContentSearchQuery.Type
    }) {
      const started = Date.now()
      log.info("session-content-search:enter", {
        queryLength: ctx.query.q.length,
        hasDirectory: ctx.query.directory !== undefined,
        archived: ctx.query.archived ?? false,
        limit: ctx.query.limit,
        hasCursor: ctx.query.cursor !== undefined,
      })
      return yield* Effect.sync(() => {
        try {
          const result = SessionContentSearch.search({
            query: ctx.query.q,
            directory: ctx.query.directory,
            cursor: ctx.query.cursor,
            limit: ctx.query.limit,
            archived: ctx.query.archived,
          })
          log.info("session-content-search:return", {
            resultCount: result.results.length,
            durationMs: Date.now() - started,
          })
          return result
        } catch (error) {
          log.error("session-content-search:error", {
            durationMs: Date.now() - started,
            error: error instanceof Error ? error : String(error),
          })
          throw error
        }
      })
    })

    const sessionContentSearchStatus = Effect.fn("ExperimentalHttpApi.sessionContentSearchStatus")(function* () {
      return yield* Effect.sync(() => Database.use(SessionContentSearch.progress))
    })

    const sessionContentSearchAction = Effect.fn("ExperimentalHttpApi.sessionContentSearchAction")(function* (ctx: {
      payload: typeof SessionContentSearchAction.Type
    }) {
      const status = yield* Effect.sync(() =>
        Database.transaction((db) => {
          if (ctx.payload.action === "pause") return SessionContentSearch.pause(db)
          if (ctx.payload.action === "rebuild") return SessionContentSearch.rebuild(db)
          if (ctx.payload.action === "clear") return SessionContentSearch.clear(db)
          return SessionContentSearch.enable(db)
        }),
      )
      if (ctx.payload.action === "pause" || ctx.payload.action === "clear") {
        yield* background.cancel("session-content-search-backfill")
      } else if (status.enabled && !status.complete) {
        yield* startContentBackfill()
      }
      return status
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionContentSearch", sessionContentSearch)
      .handle("sessionContentSearchStatus", sessionContentSearchStatus)
      .handle("sessionContentSearchAction", sessionContentSearchAction)
      .handle("resource", resource)
  }),
)
