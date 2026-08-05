import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as ProjectTaskRepository from "./repository"
import {
  CreateInput,
  Detail,
  Info,
  InvalidMountError,
  NotFoundError,
  ProjectTaskID,
  SessionNotFoundError,
  UpdateInput,
} from "./schema"

export const Event = {
  Created: BusEvent.define("project-task.created", Info),
  Updated: BusEvent.define("project-task.updated", Info),
  Deleted: BusEvent.define("project-task.deleted", Schema.Struct({ taskID: ProjectTaskID })),
}

export interface Interface {
  readonly list: (input?: { includeArchived?: boolean }) => Effect.Effect<Info[]>
  readonly get: (id: ProjectTaskID) => Effect.Effect<Info, NotFoundError>
  readonly detail: (id: ProjectTaskID) => Effect.Effect<Detail, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidMountError>
  readonly update: (id: ProjectTaskID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | InvalidMountError>
  readonly archive: (id: ProjectTaskID) => Effect.Effect<Info, NotFoundError>
  readonly mount: (input: {
    sessionID: SessionID
    taskID: ProjectTaskID | null
  }) => Effect.Effect<Info | null, NotFoundError | SessionNotFoundError | InvalidMountError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectTask") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const emit = (directory: string, payload: { type: string; properties: unknown }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory,
          payload,
        }),
      )

    const projectID = Effect.fn("ProjectTask.projectID")(function* () {
      const ctx = yield* InstanceState.context
      return ctx.project.id
    })

    const directory = Effect.fn("ProjectTask.directory")(function* () {
      const ctx = yield* InstanceState.context
      return ctx.directory
    })

    const find = Effect.fn("ProjectTask.find")(function* (id: ProjectTaskID) {
      const task = yield* ProjectTaskRepository.get(id)
      if (!task) return yield* new NotFoundError({ taskID: id })
      return task
    })

    const list: Interface["list"] = Effect.fn("ProjectTask.list")(function* (input) {
      const pid = yield* projectID()
      return yield* ProjectTaskRepository.list({
        projectID: pid,
        includeArchived: input?.includeArchived,
      })
    })

    const get: Interface["get"] = Effect.fn("ProjectTask.get")(function* (id) {
      const task = yield* find(id)
      const pid = yield* projectID()
      if (task.projectID !== pid) return yield* new NotFoundError({ taskID: id })
      return task
    })

    const detail: Interface["detail"] = Effect.fn("ProjectTask.detail")(function* (id) {
      const task = yield* ProjectTaskRepository.detail(id)
      if (!task) return yield* new NotFoundError({ taskID: id })
      const pid = yield* projectID()
      if (task.projectID !== pid) return yield* new NotFoundError({ taskID: id })
      return task
    })

    const create: Interface["create"] = Effect.fn("ProjectTask.create")(function* (input) {
      const title = input.title.trim()
      if (!title) return yield* new InvalidMountError({ message: "Project task title is required" })
      const pid = yield* projectID()
      const dir = yield* directory()
      const task = yield* ProjectTaskRepository.create(pid, {
        ...input,
        title,
      })
      yield* emit(dir, { type: Event.Created.type, properties: task })
      return task
    })

    const update: Interface["update"] = Effect.fn("ProjectTask.update")(function* (id, input) {
      yield* get(id)
      if (input.title !== undefined && !input.title.trim()) {
        return yield* new InvalidMountError({ message: "Project task title is required" })
      }
      const dir = yield* directory()
      const task = yield* ProjectTaskRepository.update(id, input)
      if (!task) return yield* new NotFoundError({ taskID: id })
      yield* emit(dir, { type: Event.Updated.type, properties: task })
      return task
    })

    const archive: Interface["archive"] = Effect.fn("ProjectTask.archive")(function* (id) {
      const current = yield* detail(id)
      const dir = yield* directory()
      // Clear mounts through Session so clients receive session.updated.
      for (const linked of current.sessions) {
        yield* sessions.setMountedTask({ sessionID: linked.sessionID, taskID: null })
      }
      const task = yield* ProjectTaskRepository.update(id, { status: "archived" })
      if (!task) return yield* new NotFoundError({ taskID: id })
      yield* emit(dir, { type: Event.Updated.type, properties: task })
      return task
    })

    const mount: Interface["mount"] = Effect.fn("ProjectTask.mount")(function* (input) {
      const session = yield* sessions.get(input.sessionID).pipe(
        Effect.mapError(() => new SessionNotFoundError({ sessionID: input.sessionID })),
      )
      const pid = yield* projectID()
      if (session.projectID !== pid) {
        return yield* new InvalidMountError({ message: "Session does not belong to the current project" })
      }

      if (input.taskID) {
        const task = yield* get(input.taskID)
        if (task.status === "archived" || task.time.archived != null) {
          return yield* new InvalidMountError({ message: "Cannot mount an archived project task" })
        }
        yield* sessions.setMountedTask({ sessionID: input.sessionID, taskID: input.taskID })
        const updated = yield* ProjectTaskRepository.get(input.taskID)
        if (!updated) return yield* new NotFoundError({ taskID: input.taskID })
        const dir = yield* directory()
        yield* emit(dir, { type: Event.Updated.type, properties: updated })
        return updated
      }

      const previous = session.mountedTaskID
      yield* sessions.setMountedTask({ sessionID: input.sessionID, taskID: null })
      if (!previous) return null
      const updated = yield* ProjectTaskRepository.get(previous)
      if (updated) {
        const dir = yield* directory()
        yield* emit(dir, { type: Event.Updated.type, properties: updated })
      }
      return updated ?? null
    })

    return Service.of({
      list,
      get,
      detail,
      create,
      update,
      archive,
      mount,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Session.defaultLayer))

export * as ProjectTask from "./service"
