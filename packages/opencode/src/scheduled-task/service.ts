import { Agent } from "@/agent/agent"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { InstanceStore } from "@/project/instance-store"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { ScheduledTaskRepository } from "./repository"
import { CreateInput, Info, NotFoundError, Run, ScheduledTaskID, ScheduledTaskRunID, UpdateInput } from "./schema"
import { ScheduledTaskUnattended } from "./unattended"

const log = Log.create({ service: "scheduled-task" })

function formatCause(cause: Cause.Cause<unknown>) {
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) return squashed.message || squashed.name
  if (typeof squashed === "string") return squashed
  if (squashed && typeof squashed === "object" && "message" in squashed) {
    const message = (squashed as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return Cause.pretty(cause)
}
const POLL_INTERVAL = "1 second"
const RETRY_INTERVAL = "30 seconds"
const MAX_BUSY_RETRIES = 3
const LEASE_MS = 60_000
const LEASE_HEARTBEAT = "20 seconds"
const MISSED_GRACE_MS = 5_000

export const Event = {
  Created: BusEvent.define("scheduled-task.created", Info),
  Updated: BusEvent.define("scheduled-task.updated", Info),
  Deleted: BusEvent.define("scheduled-task.deleted", Schema.Struct({ taskID: ScheduledTaskID })),
  RunUpdated: BusEvent.define("scheduled-task.run-updated", Run),
}

export interface Interface {
  readonly list: (input?: { projectID?: string; enabled?: boolean }) => Effect.Effect<Info[]>
  readonly get: (id: ScheduledTaskID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: ScheduledTaskID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: ScheduledTaskID) => Effect.Effect<void, NotFoundError>
  readonly runs: (id: ScheduledTaskID, limit?: number) => Effect.Effect<Run[], NotFoundError>
  readonly runNow: (id: ScheduledTaskID) => Effect.Effect<Run, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTask") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const statuses = yield* SessionStatus.Service
    const agents = yield* Agent.Service
    const scope = yield* Scope.Scope
    const ownerID = Identifier.create("scheduled-task-owner", "ascending")

    const emit = (directory: string, payload: { type: string; properties: unknown }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory,
          payload,
        }),
      )

    const find = Effect.fn("ScheduledTask.find")(function* (id: ScheduledTaskID) {
      const task = yield* ScheduledTaskRepository.get(id)
      if (!task) return yield* new NotFoundError({ taskID: id })
      return task
    })

    const emitRun = (task: Info, run: Run) => emit(task.directory, { type: Event.RunUpdated.type, properties: run })

    const complete = Effect.fn("ScheduledTask.complete")(function* (
      task: Info,
      runID: ScheduledTaskRunID,
      status: "ok" | "error" | "skipped" | "missed",
      input?: { sessionID?: Run["sessionID"]; error?: string },
    ) {
      const finished = yield* ScheduledTaskRepository.finish({
        runID,
        ownerID,
        status,
        sessionID: input?.sessionID,
        error: input?.error,
      })
      if (!finished) return
      const run = (yield* ScheduledTaskRepository.listRuns(task.id, 1))[0]
      if (run) yield* emitRun(task, run)
    })

    const executePrompt = Effect.fn("ScheduledTask.executePrompt")(function* (task: Info, run: Run) {
      return yield* instances.provide(
        { directory: task.directory },
        Effect.gen(function* () {
          let sessionID = task.sessionID
          if (task.executionMode === "existing_session") {
            // Bind a durable session on first run so the user never types a session ID.
            if (!sessionID) {
              if (!(yield* agents.get(task.agent))) throw new Error(`Agent not found: ${task.agent}`)
              const session = yield* sessions.create({
                title: task.name,
                agent: task.agent,
                model: {
                  id: ModelID.make(task.model.modelID),
                  providerID: ProviderID.make(task.model.providerID),
                  variant: task.model.variant,
                },
              })
              sessionID = session.id
              yield* ScheduledTaskRepository.update(task.id, { sessionID })
            }
            for (let attempt = run.attempt; attempt <= MAX_BUSY_RETRIES; attempt++) {
              const current = yield* statuses.get(sessionID)
              if (current.type === "idle") break
              if (attempt === MAX_BUSY_RETRIES) return { status: "skipped" as const, sessionID }
              yield* ScheduledTaskRepository.retry({
                runID: run.id,
                ownerID,
                attempt: attempt + 1,
                leaseUntil: Date.now() + LEASE_MS,
              })
              yield* Effect.sleep(RETRY_INTERVAL)
              yield* ScheduledTaskRepository.resume({
                runID: run.id,
                ownerID,
                leaseUntil: Date.now() + LEASE_MS,
              })
            }
          } else {
            if (!(yield* agents.get(task.agent))) throw new Error(`Agent not found: ${task.agent}`)
            const session = yield* sessions.create({
              title: `${task.name} · ${new Date(run.scheduledAt).toLocaleString()}`,
              agent: task.agent,
              model: {
                id: ModelID.make(task.model.modelID),
                providerID: ProviderID.make(task.model.providerID),
                variant: task.model.variant,
              },
            })
            sessionID = session.id
          }

          yield* prompts.prompt({
            sessionID,
            agent: task.agent,
            model: {
              providerID: ProviderID.make(task.model.providerID),
              modelID: ModelID.make(task.model.modelID),
            },
            variant: task.model.variant,
            parts: [{ type: "text", text: task.prompt }],
          })
          return { status: "ok" as const, sessionID }
        }).pipe(Effect.provideService(ScheduledTaskUnattended.ContextRef, true)),
      )
    })

    const executeClaimed = Effect.fn("ScheduledTask.executeClaimed")(function* (task: Info, run: Run) {
      const heartbeat = yield* Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(LEASE_HEARTBEAT)
          const owned = yield* ScheduledTaskRepository.renew({
            runID: run.id,
            ownerID,
            leaseUntil: Date.now() + LEASE_MS,
          })
          if (!owned) return
        }
      }).pipe(Effect.forkIn(scope))

      const exit = yield* Effect.exit(executePrompt(task, run))
      yield* Fiber.interrupt(heartbeat)
      if (exit._tag === "Success") {
        yield* complete(task, run.id, exit.value.status, { sessionID: exit.value.sessionID })
        return
      }
      const error = formatCause(exit.cause)
      log.error("scheduled task execution failed", { taskID: task.id, runID: run.id, error })
      // Keep any session already bound to the task so the UI can still open it.
      yield* complete(task, run.id, "error", { error, sessionID: task.sessionID })
    })

    const startOccurrence = Effect.fn("ScheduledTask.startOccurrence")(function* (
      task: Info,
      scheduledAt: number,
      options?: { advance?: boolean },
    ) {
      const claim = yield* ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt,
        ownerID,
        leaseUntil: Date.now() + LEASE_MS,
      })
      if (claim.type === "duplicate") return undefined
      if (options?.advance !== false) yield* ScheduledTaskRepository.advance(task, scheduledAt)
      if (claim.type === "overlap") {
        yield* ScheduledTaskRepository.recordStatus({ taskID: task.id, status: "skipped" })
        yield* emitRun(task, claim.run)
        return claim.run
      }
      yield* executeClaimed(task, claim.run).pipe(Effect.forkIn(scope))
      return claim.run
    })

    const recover = Effect.fn("ScheduledTask.recover")(function* () {
      const now = Date.now()
      const runs = yield* ScheduledTaskRepository.recoverable(now)
      const recovered = new Set<ScheduledTaskID>()
      for (const run of runs) {
        const task = yield* ScheduledTaskRepository.get(run.taskID)
        if (!task) continue
        recovered.add(task.id)
        yield* ScheduledTaskRepository.advance(task, run.scheduledAt, now)
        yield* startOccurrence(task, run.scheduledAt, { advance: false })
      }

      for (const task of yield* ScheduledTaskRepository.due(now)) {
        if (recovered.has(task.id) || task.nextRunAt === undefined) continue
        const scheduledAt = task.nextRunAt
        const missed = yield* ScheduledTaskRepository.markMissed({ taskID: task.id, scheduledAt, now })
        if (missed.type === "created") yield* emitRun(task, missed.run)
        yield* ScheduledTaskRepository.advance(task, scheduledAt, now)
      }
    })

    const poll = Effect.fn("ScheduledTask.poll")(function* () {
      for (;;) {
        const now = Date.now()
        for (const task of yield* ScheduledTaskRepository.due(now)) {
          if (task.nextRunAt === undefined) continue
          if (task.nextRunAt < now - MISSED_GRACE_MS) {
            const missed = yield* ScheduledTaskRepository.markMissed({
              taskID: task.id,
              scheduledAt: task.nextRunAt,
              now,
            })
            if (missed.type === "created") yield* emitRun(task, missed.run)
            yield* ScheduledTaskRepository.advance(task, task.nextRunAt, now)
            continue
          }
          yield* startOccurrence(task, task.nextRunAt)
        }
        yield* Effect.sleep(POLL_INTERVAL)
      }
    })

    yield* recover()
    yield* poll().pipe(Effect.forkIn(scope))

    return Service.of({
      list: (input) => ScheduledTaskRepository.list(input),
      get: find,
      create: Effect.fn("ScheduledTask.create")(function* (input) {
        const task = yield* ScheduledTaskRepository.create(input)
        yield* emit(task.directory, { type: Event.Created.type, properties: task })
        return task
      }),
      update: Effect.fn("ScheduledTask.update")(function* (id, input) {
        const task = yield* ScheduledTaskRepository.update(id, input)
        if (!task) return yield* new NotFoundError({ taskID: id })
        yield* emit(task.directory, { type: Event.Updated.type, properties: task })
        return task
      }),
      remove: Effect.fn("ScheduledTask.remove")(function* (id) {
        const task = yield* find(id)
        if (!(yield* ScheduledTaskRepository.remove(id))) return yield* new NotFoundError({ taskID: id })
        yield* emit(task.directory, { type: Event.Deleted.type, properties: { taskID: id } })
      }),
      runs: Effect.fn("ScheduledTask.runs")(function* (id, limit) {
        yield* find(id)
        return yield* ScheduledTaskRepository.listRuns(id, limit)
      }),
      runNow: Effect.fn("ScheduledTask.runNow")(function* (id) {
        const task = yield* find(id)
        const run = yield* startOccurrence(task, Date.now(), { advance: false })
        if (!run) return (yield* ScheduledTaskRepository.listRuns(id, 1))[0]!
        return run
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide([
    InstanceStore.defaultLayer,
    Session.defaultLayer,
    SessionPrompt.defaultLayer,
    SessionStatus.defaultLayer,
    Agent.defaultLayer,
  ]),
)

export * as ScheduledTask from "./service"
