import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Plugin } from "@/plugin"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import {
  discoverMathWorkers,
  ensureMathWorker,
  readMathWorkerTask,
  stopMathWorker,
  updateMathWorkerTask,
} from "@/math/worker"
import { legacyMathRoot, mathProblemsRoot, mathRoot } from "@/math/layout"
import { MathWorkerEvent } from "@/math/event"
import { attachVerificationProofs, readMathDetailPage, verificationAttempts } from "@/math/details"
import { readSwarm } from "@/math/swarm"
import { taskPath } from "@/math/layout"
import { MessageID, PartID, SessionID } from "@/session/schema"
import {
  finishAdvisorIntervention,
  sendAdvisorIntervention,
  startAdvisorIntervention,
} from "@/tool/advisor-intervention"
import { NamedError } from "@opencode-ai/core/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  AdvisorInterventionMessagePayload,
  AdvisorInterventionPayload,
  DiffQuery,
  ForkPayload,
  HookControlPayload,
  InitPayload,
  ListQuery,
  MathWorkerEnsurePayload,
  MathDetailsQuery,
  MathWorkerQuery,
  MathWorkerStopPayload,
  MathWorkerTaskPayload,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const log = Log.create({ service: "session.http" })

function promptAsyncErrorDetails(cause: Cause.Cause<unknown>): Record<string, unknown> {
  const error = Cause.squash(cause)
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    pretty: Cause.pretty(cause),
  }
}

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

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

function sessionSummary(item: Session.Info | undefined) {
  if (!item) return undefined
  return {
    id: item.id,
    projectID: item.projectID,
    directory: item.directory,
    path: item.path,
    parentID: item.parentID,
    workspaceID: item.workspaceID,
    keys: Object.keys(item),
    timeKeys: Object.keys(item.time),
  }
}

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const pluginSvc = yield* Plugin.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const result = yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
        archived: ctx.query.archived,
      })
      try {
        Schema.decodeUnknownSync(Schema.Array(Session.Info))(result)
        Schema.encodeUnknownSync(Schema.Array(Session.Info))(result)
      } catch (error) {
        log.error("session.list response schema failed", {
          query: ctx.query,
          count: result.length,
          first: sessionSummary(result[0]),
          error: errorDetails(error),
        })
        throw error
      }
      return result
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const mathProjectDirs = (parent: Session.Info, project?: string) => {
      if (project) {
        try {
          const current = mathRoot(parent.directory, project)
          const legacy = legacyMathRoot(parent.directory, project)
          const existing = [current, legacy].filter((dir) => existsSync(dir))
          return existing.length > 0 ? existing : [current]
        } catch {
          return []
        }
      }
      const base = mathProblemsRoot(parent.directory)
      let names: string[] = []
      try {
        names = readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        names = []
      }
      const current = [...new Set([parent.id, ...names])].flatMap((name) => {
        try {
          return [mathRoot(parent.directory, name)]
        } catch {
          return []
        }
      })
      let legacyNames: string[] = []
      try {
        legacyNames = readdirSync(path.join(parent.directory, ".math"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "problems")
          .map((entry) => entry.name)
      } catch {
        legacyNames = []
      }
      const legacy = legacyNames.flatMap((name) => {
        try {
          return [legacyMathRoot(parent.directory, name)]
        } catch {
          return []
        }
      })
      return [...new Set([...current, ...legacy])]
    }

    const mathProjectDirForWorker = (parent: Session.Info, workerID: SessionID, project?: string) => {
      const dirs = mathProjectDirs(parent, project)
      const matches = dirs.filter((dir) => {
        const record = readSwarm(dir).workers[workerID]
        if (record) return record.parentSessionID === parent.id
        return existsSync(taskPath(dir, workerID))
      })
      if (matches.length <= 1) return matches[0]
      const current = matches.filter((dir) => path.dirname(dir) === mathProblemsRoot(parent.directory))
      return current.length === 1 ? current[0] : undefined
    }

    const requireMathWorker = Effect.fn("SessionHttpApi.requireMathWorker")(function* (input: {
      parentID: SessionID
      workerID: SessionID
    }) {
      const worker = yield* requireSession(input.workerID)
      if (worker.parentID !== input.parentID || worker.agent !== "math-worker") {
        return yield* new HttpApiError.BadRequest({})
      }
      return worker
    })

    const mathWorkers = Effect.fn("SessionHttpApi.mathWorkers")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MathWorkerQuery.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      const dirs = mathProjectDirs(parent, ctx.query.project)
      if (dirs.length === 0) return yield* new HttpApiError.BadRequest({})
      const batches = yield* Effect.forEach(dirs, (projectDir) =>
        discoverMathWorkers({ projectDir, parentSessionID: parent.id }).pipe(
          Effect.map((rows) => ({ projectDir, rows })),
        ),
      )
      const actual = new Map<string, (typeof batches)[number]["rows"][number]>()
      const missing = new Map<string, (typeof batches)[number]["rows"][number]>()
      for (const batch of batches) {
        for (const row of batch.rows) {
          if (row.state === "missing") {
            if (!missing.has(row.sessionID)) missing.set(row.sessionID, row)
            continue
          }
          const record = readSwarm(batch.projectDir).workers[row.sessionID]
          if (record?.parentSessionID === parent.id && !actual.has(row.sessionID)) actual.set(row.sessionID, row)
        }
      }
      const actualIDs = new Set(actual.keys())
      const result = [...actual.values(), ...[...missing.values()].filter((row) => !actualIDs.has(row.sessionID))]
      return result
    })

    const mathDetails = Effect.fn("SessionHttpApi.mathDetails")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MathDetailsQuery.Type
    }) {
      log.info("math details request start", {
        parentSessionID: ctx.params.sessionID,
        project: ctx.query.project,
        kind: ctx.query.kind,
        offset: ctx.query.offset ?? 0,
        limit: ctx.query.limit ?? 20,
      })
      const parent = yield* requireSession(ctx.params.sessionID)
      const dirs = mathProjectDirs(parent, ctx.query.project)
      const projectDir = dirs.find((dir) => existsSync(dir)) ?? dirs[0]
      if (!projectDir) return yield* new HttpApiError.BadRequest({})
      const page = yield* Effect.promise(() =>
        readMathDetailPage({
          projectDir,
          kind: ctx.query.kind,
          offset: ctx.query.offset ?? 0,
          limit: ctx.query.limit ?? 20,
        }),
      )
      log.info("math details project page loaded", {
        parentSessionID: parent.id,
        projectDir,
        kind: page.kind,
        offset: page.offset,
        items: page.items.length,
        total: page.total,
      })
      const authors = new Set(
        page.items.flatMap((item) => (item.kind !== "fact" && item.workerSessionID ? [item.workerSessionID] : [])),
      )
      if (authors.size === 0) {
        log.info("math details request finish", {
          parentSessionID: parent.id,
          kind: page.kind,
          items: page.items.length,
          transcriptWorkers: 0,
        })
        return page
      }
      const candidates = yield* Effect.forEach([...authors], (sessionID) =>
        session.get(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => undefined)),
      )
      const workerIDs = candidates.flatMap((worker) =>
        worker?.agent === "math-worker" && worker.directory === parent.directory ? [worker.id] : [],
      )
      const validWorkers = new Set<string>(workerIDs)
      const sanitized = {
        ...page,
        items: page.items.map((item) =>
          item.kind !== "fact" && item.workerSessionID && !validWorkers.has(item.workerSessionID)
            ? { ...item, workerSessionID: undefined }
            : item,
        ),
      }
      const proofWorkers = new Set(
        sanitized.items.flatMap((item) =>
          item.kind !== "fact" && !item.proof && item.workerSessionID ? [item.workerSessionID] : [],
        ),
      )
      const transcriptWorkerIDs = workerIDs.filter((workerID) => proofWorkers.has(workerID))
      const attempts = yield* Effect.forEach(transcriptWorkerIDs, (workerSessionID) =>
        session.messages({ sessionID: workerSessionID }).pipe(
          Effect.map((messages) => verificationAttempts(workerSessionID, messages)),
          Effect.orElseSucceed(() => []),
        ),
      )
      const result = attachVerificationProofs(sanitized, attempts.flat())
      log.info("math details request finish", {
        parentSessionID: parent.id,
        kind: result.kind,
        items: result.items.length,
        transcriptWorkers: transcriptWorkerIDs.length,
        attempts: attempts.flat().length,
      })
      return result
    })

    const mathWorkerEnsure = Effect.fn("SessionHttpApi.mathWorkerEnsure")(function* (ctx: {
      params: { sessionID: SessionID; workerID: SessionID }
      query: typeof MathWorkerQuery.Type
      payload?: typeof MathWorkerEnsurePayload.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireMathWorker({ parentID: parent.id, workerID: ctx.params.workerID })
      const projectDir = mathProjectDirForWorker(parent, ctx.params.workerID, ctx.query.project)
      if (!projectDir) return yield* new HttpApiError.BadRequest({})
      const result = yield* ensureMathWorker({
        sessionID: ctx.params.workerID,
        projectDir,
        model: ctx.payload?.model,
        variant: ctx.payload?.variant,
        verifierModel: ctx.payload?.verifierModel,
        reEnable: ctx.payload?.reEnable,
      }).pipe(Effect.catchCause(() => new HttpApiError.BadRequest({})))
      yield* bus.publish(MathWorkerEvent.Status, {
        sessionID: result.sessionID,
        parentSessionID: parent.id,
        state: result.state,
        alive: true,
        pid: result.pid,
        round: result.round,
        reason: ctx.payload?.reEnable ? "re-enabled" : result.restarted ? "restarted" : "already-running",
      })
      const rows = yield* discoverMathWorkers({
        projectDir,
        parentSessionID: parent.id,
        sessionID: result.sessionID,
      })
      const row = rows[0]
      if (!row) return yield* new HttpApiError.BadRequest({})
      return row
    })

    const mathWorkerStop = Effect.fn("SessionHttpApi.mathWorkerStop")(function* (ctx: {
      params: { sessionID: SessionID; workerID: SessionID }
      query: typeof MathWorkerQuery.Type
      payload?: typeof MathWorkerStopPayload.Type
    }) {
      log.info("math worker stop request", {
        parentSessionID: ctx.params.sessionID,
        workerSessionID: ctx.params.workerID,
        project: ctx.query.project,
        force: ctx.payload?.force === true,
      })
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireMathWorker({ parentID: parent.id, workerID: ctx.params.workerID })
      const projectDir = mathProjectDirForWorker(parent, ctx.params.workerID, ctx.query.project)
      if (!projectDir) return yield* new HttpApiError.BadRequest({})
      log.info("math worker stop resolved", {
        parentSessionID: parent.id,
        workerSessionID: ctx.params.workerID,
        projectDir,
      })
      const result = stopMathWorker({
        projectDir,
        sessionID: ctx.params.workerID,
        force: ctx.payload?.force,
      })
      log.info("math worker stop result", {
        parentSessionID: parent.id,
        workerSessionID: result.sessionID,
        pid: result.pid,
        alive: result.alive,
        state: result.state,
      })
      log.info("math worker stop transcript cancel start", {
        parentSessionID: parent.id,
        workerSessionID: result.sessionID,
      })
      yield* promptSvc.cancel(ctx.params.workerID)
      log.info("math worker stop transcript cancel finish", {
        parentSessionID: parent.id,
        workerSessionID: result.sessionID,
      })
      yield* bus.publish(MathWorkerEvent.Status, {
        sessionID: result.sessionID,
        parentSessionID: parent.id,
        state: result.state,
        alive: result.alive,
        pid: result.pid,
        round: result.round,
        lastFactId: result.last_fact_id,
        reason: ctx.payload?.force ? "force-stop" : "stop-requested",
      })
      log.info("math worker stop event published", {
        parentSessionID: parent.id,
        workerSessionID: result.sessionID,
        alive: result.alive,
        state: result.state,
      })
      return result
    })

    const mathWorkerTaskGet = Effect.fn("SessionHttpApi.mathWorkerTaskGet")(function* (ctx: {
      params: { sessionID: SessionID; workerID: SessionID }
      query: typeof MathWorkerQuery.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireMathWorker({ parentID: parent.id, workerID: ctx.params.workerID })
      const projectDir = mathProjectDirForWorker(parent, ctx.params.workerID, ctx.query.project)
      if (!projectDir) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.try({
        try: () => readMathWorkerTask(projectDir, ctx.params.workerID),
        catch: () => new HttpApiError.BadRequest({}),
      })
    })

    const mathWorkerTaskUpdate = Effect.fn("SessionHttpApi.mathWorkerTaskUpdate")(function* (ctx: {
      params: { sessionID: SessionID; workerID: SessionID }
      query: typeof MathWorkerQuery.Type
      payload: typeof MathWorkerTaskPayload.Type
    }) {
      const parent = yield* requireSession(ctx.params.sessionID)
      yield* requireMathWorker({ parentID: parent.id, workerID: ctx.params.workerID })
      const projectDir = mathProjectDirForWorker(parent, ctx.params.workerID, ctx.query.project)
      if (!projectDir) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.try({
        try: () => updateMathWorkerTask(projectDir, ctx.params.workerID, ctx.payload.task),
        catch: () => new HttpApiError.BadRequest({}),
      })
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if ((yield* statusSvc.get(ctx.params.sessionID)).type === "idle") {
        yield* session.finalizeOrphanedAssistant(ctx.params.sessionID, {
          staleAfterMs: Session.ORPHANED_ASSISTANT_STALE_AFTER_MS,
        })
      }
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
        if (ctx.payload.time.archived !== null) {
          yield* promptSvc.cancel(ctx.params.sessionID)
        }
      }
      if (ctx.payload.injectTaskContext !== undefined) {
        yield* session.setInjectTaskContext({
          sessionID: ctx.params.sessionID,
          enabled: ctx.payload.injectTaskContext,
        })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload?.messageID }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const hooks = Effect.fn("SessionHttpApi.hooks")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* pluginSvc.listHookControls(ctx.params.sessionID)
    })

    const hookControl = Effect.fn("SessionHttpApi.hookControl")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof HookControlPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* pluginSvc.setHookControl({ ...ctx.payload, sessionID: ctx.params.sessionID })
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = promptAsyncErrorDetails(cause)
            yield* Effect.logError("prompt_async failed").pipe(
              Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause, error }),
            )
            yield* bus.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const advisorInterventionStart = Effect.fn("SessionHttpApi.advisorInterventionStart")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof AdvisorInterventionPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!startAdvisorIntervention({ sessionID: ctx.params.sessionID, callID: ctx.payload.callID })) {
        return yield* new HttpApiError.BadRequest({})
      }
      return true
    })

    const advisorInterventionMessage = Effect.fn("SessionHttpApi.advisorInterventionMessage")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof AdvisorInterventionMessagePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!sendAdvisorIntervention({ ...ctx.payload, sessionID: ctx.params.sessionID })) {
        return yield* new HttpApiError.BadRequest({})
      }
      return true
    })

    const advisorInterventionFinish = Effect.fn("SessionHttpApi.advisorInterventionFinish")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof AdvisorInterventionPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!finishAdvisorIntervention({ sessionID: ctx.params.sessionID, callID: ctx.payload.callID })) {
        return yield* new HttpApiError.BadRequest({})
      }
      return true
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof MessageV2.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as MessageV2.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    const generateTitle = Effect.fn("SessionHttpApi.generateTitle")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .generateTitle({ sessionID: ctx.params.sessionID, force: true })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("mathWorkers", mathWorkers)
      .handle("mathDetails", mathDetails)
      .handle("mathWorkerEnsure", mathWorkerEnsure)
      .handle("mathWorkerStop", mathWorkerStop)
      .handle("mathWorkerTaskGet", mathWorkerTaskGet)
      .handle("mathWorkerTaskUpdate", mathWorkerTaskUpdate)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("hooks", hooks)
      .handle("hookControl", hookControl)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("generateTitle", generateTitle)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("advisorInterventionStart", advisorInterventionStart)
      .handle("advisorInterventionMessage", advisorInterventionMessage)
      .handle("advisorInterventionFinish", advisorInterventionFinish)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
