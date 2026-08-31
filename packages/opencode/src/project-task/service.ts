import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as ProjectTaskRepository from "./repository"
import {
  descriptionRelativePath,
  ensureDescriptionFile,
  readDescriptionFile,
  progressRelativePath,
  taskFilesAnchor,
  writeDescriptionFile,
} from "./description-file"
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

    /**
     * Directory task files resolve against (git worktree root when available).
     * Subdirectory instances of one project share task rows; anchoring to the
     * worktree keeps `.project-tasks/` identical no matter which subdirectory
     * the instance was opened from. Non-git projects fall back to the instance
     * directory (their worktree is "/").
     */
    const anchorDirectory = Effect.fn("ProjectTask.anchorDirectory")(function* () {
      const ctx = yield* InstanceState.context
      return taskFilesAnchor(ctx)
    })

    const hydrate = Effect.fn("ProjectTask.hydrate")(function* (meta: ProjectTaskRepository.TaskRowMeta) {
      const dir = yield* anchorDirectory()
      const ensured = yield* Effect.promise(() =>
        ensureDescriptionFile({
          projectDirectory: dir,
          taskID: meta.id,
          descriptionPath: meta.descriptionPath,
          legacyDescription: meta.legacyDescription,
          persist: (next) => {
            Effect.runSync(
              ProjectTaskRepository.setDescriptionPath(meta.id, next.descriptionPath, {
                clearLegacy: next.clearLegacy,
              }),
            )
          },
        }),
      )
      return ProjectTaskRepository.toInfo(
        { ...meta, descriptionPath: ensured.descriptionPath },
        ensured.content,
      )
    })

    const find = Effect.fn("ProjectTask.find")(function* (id: ProjectTaskID) {
      const meta = yield* ProjectTaskRepository.getRow(id)
      if (!meta) return yield* new NotFoundError({ taskID: id })
      return yield* hydrate(meta)
    })

    const list: Interface["list"] = Effect.fn("ProjectTask.list")(function* (input) {
      const pid = yield* projectID()
      const dir = yield* anchorDirectory()
      const rows = yield* ProjectTaskRepository.listRows({
        projectID: pid,
        includeArchived: input?.includeArchived,
      })
      const out: Info[] = []
      for (const row of rows) {
        const descriptionPath = row.descriptionPath || descriptionRelativePath(row.id)
        const content = yield* Effect.promise(() => readDescriptionFile(dir, descriptionPath))
        out.push(
          ProjectTaskRepository.toInfo(
            { ...row, descriptionPath },
            content ?? row.legacyDescription ?? "",
          ),
        )
      }
      console.debug(
        `[project-task] list projectID=${pid} count=${out.length} dirs=${out.map((task) => `${task.id}:${task.sessionDirectories.join("|") || "-"}`).join(",") || "none"}`,
      )
      return out
    })

    const get: Interface["get"] = Effect.fn("ProjectTask.get")(function* (id) {
      const task = yield* find(id)
      const pid = yield* projectID()
      if (task.projectID !== pid) return yield* new NotFoundError({ taskID: id })
      return task
    })

    const detail: Interface["detail"] = Effect.fn("ProjectTask.detail")(function* (id) {
      const row = yield* ProjectTaskRepository.detailRow(id)
      if (!row) return yield* new NotFoundError({ taskID: id })
      const pid = yield* projectID()
      if (row.projectID !== pid) return yield* new NotFoundError({ taskID: id })
      const info = yield* hydrate(row)
      const anchor = yield* anchorDirectory()
      return { ...info, sessions: row.sessions, workspaceDirectory: anchor }
    })

    const create: Interface["create"] = Effect.fn("ProjectTask.create")(function* (input) {
      const title = input.title.trim()
      if (!title) return yield* new InvalidMountError({ message: "Project task title is required" })
      if (input.status === "done" || input.status === "archived") {
        return yield* new InvalidMountError({
          message:
            "Cannot create a project task with status done/archived. Create as open/in_progress, then use project_task_update on the same taskID.",
        })
      }
      const pid = yield* projectID()
      const dir = yield* directory()
      const anchor = yield* anchorDirectory()
      const body = input.description?.trim() ?? ""
      // Repository assigns id + description_path; write file before/after insert.
      const task = yield* ProjectTaskRepository.create(pid, {
        ...input,
        title,
        description: body,
      })
      yield* Effect.promise(() => writeDescriptionFile(anchor, task.descriptionPath, body))
      yield* Effect.promise(() => writeDescriptionFile(anchor, progressRelativePath(task.id), ""))
      // Return with body already known (file write succeeded).
      const created: Info = { ...task, description: body }
      yield* emit(dir, { type: Event.Created.type, properties: created })
      return created
    })

    const update: Interface["update"] = Effect.fn("ProjectTask.update")(function* (id, input) {
      // Keep description content out of logs while making desktop save failures traceable.
      console.debug(
        `[project-task] update start taskID=${id} hasTitle=${String(input.title !== undefined)} hasStatus=${String(input.status !== undefined)} hasDescription=${String(input.description !== undefined)} descriptionLength=${input.description?.length ?? 0}`,
      )
      const current = yield* get(id)
      if (input.title !== undefined && !input.title.trim()) {
        return yield* new InvalidMountError({ message: "Project task title is required" })
      }
      const dir = yield* directory()
      const anchor = yield* anchorDirectory()

      if (input.description !== undefined) {
        const rel = current.descriptionPath || descriptionRelativePath(id)
        console.debug(`[project-task] update write-description taskID=${id} path=${rel} descriptionLength=${input.description.length}`)
        yield* Effect.promise(() => writeDescriptionFile(anchor, rel, input.description!))
        yield* ProjectTaskRepository.setDescriptionPath(id, rel, { clearLegacy: true })
        console.debug(`[project-task] update description-written taskID=${id} path=${rel}`)
      }

      const task = yield* ProjectTaskRepository.update(id, {
        title: input.title,
        status: input.status,
        // Pass through body so returned Info has correct description when only status/title change.
        description: input.description !== undefined ? input.description : current.description,
        descriptionPath: current.descriptionPath || descriptionRelativePath(id),
        clearLegacyDescription: input.description !== undefined,
      })
      if (!task) return yield* new NotFoundError({ taskID: id })

      const hydrated = yield* get(id)
      yield* emit(dir, { type: Event.Updated.type, properties: hydrated })
      console.debug(
        `[project-task] update complete taskID=${id} status=${hydrated.status} descriptionLength=${hydrated.description.length}`,
      )
      return hydrated
    })

    const archive: Interface["archive"] = Effect.fn("ProjectTask.archive")(function* (id) {
      const current = yield* detail(id)
      const dir = yield* directory()
      for (const linked of current.sessions) {
        yield* sessions.setMountedTask({ sessionID: linked.sessionID, taskID: null })
      }
      const task = yield* ProjectTaskRepository.update(id, { status: "archived" })
      if (!task) return yield* new NotFoundError({ taskID: id })
      const hydrated = yield* get(id)
      yield* emit(dir, { type: Event.Updated.type, properties: hydrated })
      return hydrated
    })

    const mount: Interface["mount"] = Effect.fn("ProjectTask.mount")(function* (input) {
      const session = yield* sessions.get(input.sessionID).pipe(
        Effect.mapError(() => new SessionNotFoundError({ sessionID: input.sessionID })),
      )
      const pid = yield* projectID()
      const dir = yield* directory()
      if (session.projectID !== pid) {
        // eslint-disable-next-line no-console
        console.debug(
          `[project-task] mount rejected: session project mismatch sessionID=${input.sessionID} sessionProject=${session.projectID} instanceProject=${pid} directory=${dir}`,
        )
        return yield* new InvalidMountError({
          message: `Session project (${session.projectID}) does not match instance project (${pid}) for directory ${dir}`,
        })
      }

      if (input.taskID) {
        const task = yield* get(input.taskID)
        if (task.status === "archived" || task.time.archived != null) {
          return yield* new InvalidMountError({ message: "Cannot mount an archived project task" })
        }
        if (task.projectID !== session.projectID) {
          // eslint-disable-next-line no-console
          console.debug(
            `[project-task] mount rejected: task project mismatch taskID=${input.taskID} taskProject=${task.projectID} sessionProject=${session.projectID}`,
          )
          return yield* new InvalidMountError({
            message: `Task project (${task.projectID}) does not match session project (${session.projectID})`,
          })
        }
        yield* sessions.setMountedTask({ sessionID: input.sessionID, taskID: input.taskID })
        // Default-on: mounting a task enables context injection unless the user later opts out.
        yield* sessions.setInjectTaskContext({ sessionID: input.sessionID, enabled: true })
        const updated = yield* get(input.taskID)
        yield* emit(dir, { type: Event.Updated.type, properties: updated })
        return updated
      }

      const previous = session.mountedTaskID
      yield* sessions.setMountedTask({ sessionID: input.sessionID, taskID: null })
      if (!previous) return null
      const updated = yield* get(previous).pipe(Effect.catch(() => Effect.succeed(null)))
      if (updated) {
        yield* emit(dir, { type: Event.Updated.type, properties: updated })
      }
      return updated
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
