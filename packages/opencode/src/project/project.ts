import { and, eq, isNull, or } from "drizzle-orm"
import { Database } from "@/storage/db"
import { toLogicalPath } from "@opencode-ai/core/util/path"
import { directorySqlEq } from "@/util/directory-sql"
import { ProjectTable } from "./project.sql"
import { SessionTable } from "../session/session.sql"
import { ScheduledTaskTable } from "../scheduled-task/scheduled-task.sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { ProjectLocation } from "./location"
import { ProjectAlias } from "./alias"
import { GitEvidence } from "./git-evidence"
import { ProjectOwnershipMigration } from "./ownership-migration"
import * as Log from "@opencode-ai/core/util/log"
import { Hash } from "@opencode-ai/core/util/hash"
import { Flag } from "@opencode-ai/core/flag/flag"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { which } from "../util/which"
import { LocationID, ProjectID } from "./schema"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Path, Scope, Context, Stream, Types, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NonNegativeInt, optionalOmitUndefined } from "@opencode-ai/core/schema"
import { serviceUse } from "@/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"

const log = Log.create({ service: "project" })

const ProjectVcs = Schema.Literal("git")

const ProjectIcon = Schema.Struct({
  url: optionalOmitUndefined(Schema.String),
  override: optionalOmitUndefined(Schema.String),
  color: optionalOmitUndefined(Schema.String),
})

const ProjectCommands = Schema.Struct({
  start: optionalOmitUndefined(
    Schema.String.annotate({ description: "Startup script to run when creating a new workspace (worktree)" }),
  ),
})

const ProjectTime = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  initialized: optionalOmitUndefined(NonNegativeInt),
})

export const Info = Schema.Struct({
  id: ProjectID,
  worktree: Schema.String,
  vcs: optionalOmitUndefined(ProjectVcs),
  name: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(ProjectIcon),
  commands: optionalOmitUndefined(ProjectCommands),
  time: ProjectTime,
  sandboxes: Schema.Array(Schema.String),
}).annotate({ identifier: "Project" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: BusEvent.define("project.updated", Info),
}

type Row = typeof ProjectTable.$inferSelect

export interface LegacyClaimCounts {
  sessions: number
  scheduledTasks: number
  workspaces: number
}

export function claimLegacyDirectory(input: {
  directory: string
  projectID: ProjectID
  locationID?: LocationID
}): LegacyClaimCounts {
  const sessionOwner = input.locationID
    ? or(
        eq(SessionTable.project_id, ProjectID.global),
        and(eq(SessionTable.project_id, input.projectID), isNull(SessionTable.location_id)),
      )!
    : eq(SessionTable.project_id, ProjectID.global)
  const scheduledTaskOwner = input.locationID
    ? or(
        eq(ScheduledTaskTable.project_id, ProjectID.global),
        and(eq(ScheduledTaskTable.project_id, input.projectID), isNull(ScheduledTaskTable.location_id)),
      )!
    : eq(ScheduledTaskTable.project_id, ProjectID.global)
  const workspaceOwner = input.locationID
    ? or(
        eq(WorkspaceTable.project_id, ProjectID.global),
        and(eq(WorkspaceTable.project_id, input.projectID), isNull(WorkspaceTable.location_id)),
      )!
    : eq(WorkspaceTable.project_id, ProjectID.global)
  return Database.transaction(
    (db) => ({
      sessions: db
        .update(SessionTable)
        .set({
          project_id: input.projectID,
          location_id: input.locationID,
          time_updated: SessionTable.time_updated,
        })
        .where(
          and(
            directorySqlEq(SessionTable.directory, input.directory),
            sessionOwner,
          ),
        )
        .returning({ id: SessionTable.id })
        .all().length,
      scheduledTasks: db
        .update(ScheduledTaskTable)
        .set({
          project_id: input.projectID,
          location_id: input.locationID,
          time_updated: ScheduledTaskTable.time_updated,
        })
        .where(
          and(
            directorySqlEq(ScheduledTaskTable.directory, input.directory),
            scheduledTaskOwner,
          ),
        )
        .returning({ id: ScheduledTaskTable.id })
        .all().length,
      workspaces: db
        .update(WorkspaceTable)
        .set({ project_id: input.projectID, location_id: input.locationID })
        .where(
          and(
            directorySqlEq(WorkspaceTable.directory, input.directory),
            workspaceOwner,
          ),
        )
        .returning({ id: WorkspaceTable.id })
        .all().length,
    }),
    { behavior: "immediate" },
  )
}

export function fromRow(row: Row): Info {
  const result: Info = {
    id: row.id,
    worktree: row.worktree,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    sandboxes: row.sandboxes,
  }

  if (row.vcs) result.vcs = Schema.decodeUnknownSync(ProjectVcs)(row.vcs)
  if (row.name !== null) result.name = row.name
  if (row.commands !== null) result.commands = row.commands
  if (row.time_initialized !== null) result.time.initialized = row.time_initialized

  if (row.icon_url || row.icon_url_override || row.icon_color) {
    result.icon = {}
    if (row.icon_url !== null) result.icon.url = row.icon_url
    if (row.icon_url_override !== null) result.icon.override = row.icon_url_override
    if (row.icon_color !== null) result.icon.color = row.icon_color
  }

  return result
}

export const UpdateInput = Schema.Struct({
  projectID: ProjectID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
})
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
}).annotate({ identifier: "ProjectUpdateInput" })
export type UpdatePayload = Types.DeepMutable<Schema.Schema.Type<typeof UpdatePayload>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ProjectID,
}) {}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Per-instance setup. Subscribes to the `/init` slash command for the
   * current instance and stamps the project's initialized timestamp when it
   * fires. Subscription lifetime is tied to the per-instance state scope.
   */
  readonly init: () => Effect.Effect<void>
  readonly fromDirectory: (
    directory: string,
  ) => Effect.Effect<{ project: Info; sandbox: string; location: ProjectLocation.Info }>
  readonly claimLegacy: () => Effect.Effect<LegacyClaimCounts>
  readonly discover: (input: Info) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectID) => Effect.Effect<Info | undefined>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
  readonly setInitialized: (id: ProjectID) => Effect.Effect<void>
  readonly sandboxes: (id: ProjectID) => Effect.Effect<string[]>
  readonly addSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: ProjectID, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Bus.Service | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const pathSvc = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const bus = yield* Bus.Service
    const flags = yield* RuntimeFlags.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const started = Date.now()
        log.info("git probe started", { args, cwd: opts?.cwd })
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        log.info("git probe spawned", { args, cwd: opts?.cwd, pid: handle.pid })
        const [text, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        log.info("git probe output drained", {
          args,
          cwd: opts?.cwd,
          stdoutBytes: text.length,
          stderrBytes: stderr.length,
        })
        const code = yield* handle.exitCode
        log.info("git probe completed", { args, cwd: opts?.cwd, code, duration: Date.now() - started })
        return { code, text, stderr } satisfies GitResult
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
    )

    const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
      Effect.sync(() => Database.use(fn))

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(ProjectVcs))(Flag.OPENCODE_FAKE_VCS)

    const resolveGitPath = (cwd: string, name: string) => {
      if (!name) return cwd
      name = name.replace(/[\r\n]+$/, "")
      if (!name) return cwd
      name = AppFileSystem.windowsPath(name)
      if (pathSvc.isAbsolute(name)) return pathSvc.normalize(name)
      return pathSvc.resolve(cwd, name)
    }

    const scope = yield* Scope.Scope

    const readCachedProjectId = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(pathSvc.join(dir, "opencode")).pipe(
        Effect.map((x) => x.trim()),
        Effect.map((x) => ProjectID.make(x)),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    const inspectDotgit = Effect.fnUntraced(function* (dotgit: string) {
      if (yield* fs.isDir(dotgit).pipe(Effect.catch(() => Effect.succeed(false)))) {
        return { gitDir: dotgit, cachedID: yield* readCachedProjectId(dotgit) }
      }
      const content = yield* fs.readFileString(dotgit).pipe(Effect.catch(() => Effect.succeed("")))
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(content)
      if (!match) return { gitDir: dotgit, cachedID: undefined }
      const gitDir = resolveGitPath(pathSvc.dirname(dotgit), match[1])
      const relativeCommon = yield* fs.readFileString(pathSvc.join(gitDir, "commondir")).pipe(
        Effect.map((value) => value.trim()),
        Effect.catch(() => Effect.succeed("")),
      )
      const commonDir = relativeCommon ? resolveGitPath(gitDir, relativeCommon) : gitDir
      const cachedID = (yield* readCachedProjectId(gitDir)) ?? (yield* readCachedProjectId(commonDir))
      return { gitDir, commonDir, cachedID }
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
      const canonicalDirectory = toLogicalPath(AppFileSystem.resolve(directory))
      const fallbackID = ProjectID.make(`dir:${Hash.fast(canonicalDirectory)}`)
      log.info("project resolution started", { inputDirectory: directory, canonicalDirectory, fallbackID })

      // Phase 1: discover git info
      type DiscoveryResult = {
        id: ProjectID
        worktree: string
        sandbox: string
        vcs: Info["vcs"]
        reason: string
        headState?: "unborn" | "ready"
        rootCommits?: string[]
        remoteUrl?: string
        gitDir?: string
        commonDir?: string
        cachedID?: ProjectID
      }

      const dataRaw: DiscoveryResult = yield* Effect.gen(function* () {
        // fork-1.13.21 behavior: non-git directories used a `dir:<hash>` project id keyed by worktree
        // path, so sessions created before the 1.15 rebase live under those ids rather than `global`.
        // Reuse the existing row so listByProject lands on the correct project_id.
        const existingLocation = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(canonicalDirectory))
        const existingByWorktree = yield* db((d) =>
          d.select().from(ProjectTable).where(directorySqlEq(ProjectTable.worktree, canonicalDirectory)).get(),
        )
        const identityHint =
          existingLocation?.projectID ??
          (existingByWorktree?.id === ProjectID.global ? undefined : existingByWorktree?.id)
        log.info("project identity hint", {
          canonicalDirectory,
          identityHint,
          locationID: existingLocation?.id,
          previousVcs: existingByWorktree?.vcs,
        })

        const dotgitMatches = yield* fs.up({ targets: [".git"], start: canonicalDirectory }).pipe(Effect.orDie)
        const dotgit = dotgitMatches[0]
        log.info("project git marker probe", { canonicalDirectory, dotgit })

        if (!dotgit) {
          return {
            id: identityHint ?? fallbackID,
            worktree: canonicalDirectory,
            sandbox: canonicalDirectory,
            vcs: fakeVcs,
            reason: identityHint ? "directory-hint-no-git" : "directory-hash-no-git",
          }
        }

        let sandbox = pathSvc.dirname(dotgit)
        const gitBinary = yield* Effect.sync(() => which("git"))
        const dotgitInfo = yield* inspectDotgit(dotgit)
        const dotgitCachedID = dotgitInfo.cachedID
        let id = dotgitCachedID ?? identityHint
        log.info("project git capability probe", {
          sandbox,
          gitBinary: !!gitBinary,
          gitDir: dotgitInfo.gitDir,
          fallbackCommonDir: dotgitInfo.commonDir,
          dotgitCachedID,
          identityHint,
        })

        if (!gitBinary) {
          id ??= fallbackID
          yield* fs
            .writeFileString(pathSvc.join(dotgitInfo.commonDir ?? dotgitInfo.gitDir, "opencode"), id)
            .pipe(Effect.ignore)
          const worktree = dotgitInfo.commonDir ? pathSvc.dirname(dotgitInfo.commonDir) : sandbox
          return {
            id,
            worktree,
            sandbox,
            vcs: fakeVcs,
            reason: dotgitCachedID
              ? "dotgit-cache-git-unavailable"
              : identityHint
                ? "directory-hint-git-unavailable"
                : "directory-hash-git-unavailable",
            gitDir: dotgitInfo.gitDir,
            cachedID: dotgitCachedID,
          }
        }

        const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: sandbox })
        if (commonDir.code !== 0) {
          id ??= fallbackID
          yield* fs
            .writeFileString(pathSvc.join(dotgitInfo.commonDir ?? dotgitInfo.gitDir, "opencode"), id)
            .pipe(Effect.ignore)
          const worktree = dotgitInfo.commonDir ? pathSvc.dirname(dotgitInfo.commonDir) : sandbox
          return {
            id,
            worktree,
            sandbox,
            vcs: fakeVcs,
            reason: dotgitCachedID
              ? "dotgit-cache-common-dir-error"
              : identityHint
                ? "directory-hint-common-dir-error"
                : "directory-hash-common-dir-error",
            gitDir: dotgitInfo.gitDir,
            cachedID: dotgitCachedID,
            commonDir: dotgitInfo.commonDir,
          }
        }
        const common = resolveGitPath(sandbox, commonDir.text.trim())
        log.info("project git common directory", { sandbox, commonDir: common })
        const bareCheck = yield* git(["config", "--bool", "core.bare"], { cwd: sandbox })
        const isBareRepo = bareCheck.code === 0 && bareCheck.text.trim() === "true"
        const worktree = common === sandbox ? sandbox : isBareRepo ? common : pathSvc.dirname(common)

        let commonCachedID: ProjectID | undefined
        if (id == null) {
          commonCachedID = yield* readCachedProjectId(common)
          id = commonCachedID
        }

        let reason = dotgitCachedID
          ? "dotgit-cache"
          : identityHint
            ? "directory-hint"
            : commonCachedID
              ? "common-dir-cache"
              : "unresolved-git-identity"

        if (!id) {
          const commonProjectID = yield* Effect.sync(() => ProjectLocation.uniqueProjectByGitCommonDir(common))
          if (commonProjectID) {
            id = commonProjectID
            reason = "common-dir-location"
          }
        }

        const evidence = yield* GitEvidence.collectRepository({ cwd: sandbox, run: git })
        const remoteUrl = evidence.remoteUrl
        if (!id && remoteUrl) {
          const remoteProjectID = yield* Effect.sync(() => ProjectAlias.uniqueProject("remote_url", remoteUrl))
          if (remoteProjectID) {
            id = remoteProjectID
            reason = "unique-remote-alias"
          }
        }

        const roots = evidence.rootCommits
        const headState = evidence.headState
        if (!id && roots[0]) {
          const legacyRootID = ProjectID.make(roots[0])
          const legacyRootProject = yield* db((d) =>
            d.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, legacyRootID)).get(),
          )
          if (legacyRootProject) {
            id = legacyRootProject.id
            reason = "legacy-root-project"
          }
        }

        if (!id) {
          id = headState === "unborn" ? fallbackID : ProjectID.ascending()
          reason = headState === "unborn" ? "directory-hash-unborn" : "opaque-git-project"
        }
        yield* fs.writeFileString(pathSvc.join(common, "opencode"), id).pipe(Effect.ignore)

        const topLevel = yield* git(["rev-parse", "--show-toplevel"], { cwd: sandbox })
        if (topLevel.code !== 0) {
          return {
            id,
            worktree,
            sandbox,
            vcs: fakeVcs,
            reason: `${reason}-show-toplevel-error`,
            headState,
            rootCommits: roots,
            remoteUrl,
            gitDir: dotgitInfo.gitDir,
            commonDir: common,
            cachedID: dotgitCachedID ?? commonCachedID,
          }
        }
        sandbox = resolveGitPath(sandbox, topLevel.text.trim())

        return {
          id,
          sandbox,
          worktree,
          vcs: "git" as const,
          reason,
          headState,
          rootCommits: roots,
          remoteUrl,
          gitDir: dotgitInfo.gitDir,
          commonDir: common,
          cachedID: dotgitCachedID ?? commonCachedID,
        }
      })

      // Normalize discovered paths to the canonical logical-path form (`/`)
      // before any DB write or compare. git rev-parse / pathSvc.dirname may
      // return Windows `\`; storing `/` keeps project.worktree consistent
      // with the SDK wire form and the session.directory write side.
      const data: DiscoveryResult = {
        id: dataRaw.id,
        worktree: toLogicalPath(dataRaw.worktree) || dataRaw.worktree,
        sandbox: toLogicalPath(dataRaw.sandbox) || dataRaw.sandbox,
        vcs: dataRaw.vcs,
        reason: dataRaw.reason,
        headState: dataRaw.headState,
        rootCommits: dataRaw.rootCommits,
        remoteUrl: dataRaw.remoteUrl,
        gitDir: dataRaw.gitDir ? toLogicalPath(dataRaw.gitDir) : undefined,
        commonDir: dataRaw.commonDir ? toLogicalPath(dataRaw.commonDir) : undefined,
        cachedID: dataRaw.cachedID,
      }
      const existingLocation = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(data.sandbox))
      if (existingLocation && existingLocation.projectID !== data.id) {
        log.warn("project identity reconciled from location", {
          canonicalDirectory: data.sandbox,
          discoveredProjectID: data.id,
          locationID: existingLocation.id,
          locationProjectID: existingLocation.projectID,
        })
        data.id = existingLocation.projectID
        data.reason = `location-hint-${data.reason}`
        if (data.commonDir) {
          yield* fs.writeFileString(pathSvc.join(data.commonDir, "opencode"), data.id).pipe(Effect.ignore)
        }
      }
      log.info("project resolution selected", {
        inputDirectory: directory,
        canonicalDirectory,
        projectID: data.id,
        worktree: data.worktree,
        sandbox: data.sandbox,
        vcs: data.vcs,
        commonDir: data.commonDir,
        gitDir: data.gitDir,
        remoteUrl: data.remoteUrl,
        rootCommits: data.rootCommits,
        cachedID: data.cachedID,
        reason: data.reason,
      })

      // Phase 2: upsert
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, data.id)).get())
      const existing = row
        ? fromRow(row)
        : {
            id: data.id,
            worktree: data.worktree,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          }
      if (data.vcs) existing.vcs = data.vcs

      if (flags.experimentalIconDiscovery) yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

      const result: Info = {
        ...existing,
        worktree: row && data.sandbox === data.worktree && row.worktree !== data.worktree ? row.worktree : data.worktree,
        time: { ...existing.time, updated: Date.now() },
      }
      if (data.vcs) result.vcs = data.vcs
      else delete result.vcs
      if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
        result.sandboxes.push(data.sandbox)
      result.sandboxes = yield* Effect.forEach(
        result.sandboxes,
        (s) =>
          fs.exists(s).pipe(
            Effect.orDie,
            Effect.map((exists) => (exists ? s : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

      yield* db((d) =>
        d
          .insert(ProjectTable)
          .values({
            id: result.id,
            worktree: result.worktree,
            vcs: result.vcs ?? null,
            name: result.name,
            icon_url: result.icon?.url,
            icon_url_override: result.icon?.override,
            icon_color: result.icon?.color,
            time_created: result.time.created,
            time_updated: result.time.updated,
            time_initialized: result.time.initialized,
            sandboxes: result.sandboxes,
            commands: result.commands,
          })
          .onConflictDoUpdate({
            target: ProjectTable.id,
            set: {
              worktree: result.worktree,
              vcs: result.vcs ?? null,
              name: result.name,
              icon_url: result.icon?.url,
              icon_url_override: result.icon?.override,
              icon_color: result.icon?.color,
              time_updated: result.time.updated,
              time_initialized: result.time.initialized,
              sandboxes: result.sandboxes,
              commands: result.commands,
            },
          })
          .run(),
      )

      const locationRoot = data.sandbox
      const vcsState = GitEvidence.vcsState(data)
      const location = yield* Effect.sync(() =>
        ProjectLocation.upsert({
          projectID: result.id,
          directory: locationRoot,
          canonicalDirectory: locationRoot,
          kind: GitEvidence.kind({
            gitDir: data.gitDir,
            locationRoot,
            worktreeRoot: data.worktree,
            remoteUrl: data.remoteUrl,
          }),
          vcsType: data.gitDir ? "git" : undefined,
          vcsState,
          worktreeRoot: data.worktree,
          gitCommonDir: data.commonDir,
          marker: data.commonDir ? toLogicalPath(pathSvc.join(data.commonDir, "opencode")) : undefined,
        }),
      )
      log.info("project location resolved", {
        projectID: result.id,
        locationID: location.id,
        canonicalDirectory: location.canonicalDirectory,
        kind: location.kind,
        vcsState: location.vcsState,
      })

      const aliases = yield* Effect.sync(() => {
        const values: ProjectAlias.Info[] = []
        if (data.gitDir) {
          values.push(
            ProjectAlias.upsert({
              projectID: result.id,
              kind: "git_marker",
              value: result.id,
              confidence: "high",
              sourceLocationID: location.id,
            }),
          )
        }
        if (data.remoteUrl) {
          values.push(
            ProjectAlias.upsert({
              projectID: result.id,
              kind: "remote_url",
              value: data.remoteUrl,
              confidence: "medium",
              sourceLocationID: location.id,
            }),
          )
        }
        for (const root of data.rootCommits ?? []) {
          values.push(
            ProjectAlias.upsert({
              projectID: result.id,
              kind: "root_commit",
              value: root,
              confidence: "low",
              sourceLocationID: location.id,
            }),
          )
        }
        return values
      })
      log.info("project aliases recorded", {
        projectID: result.id,
        locationID: location.id,
        aliases: aliases.map((alias) => alias.kind),
      })

      const claims = yield* Effect.sync(() =>
        claimLegacyDirectory({ directory: canonicalDirectory, projectID: data.id, locationID: location.id }),
      )
      log.info("project legacy resources claimed", {
        canonicalDirectory,
        projectID: data.id,
        locationID: location.id,
        sessions: claims.sessions,
        scheduledTasks: claims.scheduledTasks,
        workspaces: claims.workspaces,
      })

      yield* emitUpdated(result)
      return { project: result, sandbox: data.sandbox, location }
    })

    const countLegacyDirectory = (directory: string) =>
      db((d) => ({
        sessions: d
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(
            and(
              or(eq(SessionTable.project_id, ProjectID.global), isNull(SessionTable.location_id)),
              directorySqlEq(SessionTable.directory, directory),
            ),
          )
          .all().length,
        scheduledTasks: d
          .select({ id: ScheduledTaskTable.id })
          .from(ScheduledTaskTable)
          .where(
            and(
              or(eq(ScheduledTaskTable.project_id, ProjectID.global), isNull(ScheduledTaskTable.location_id)),
              directorySqlEq(ScheduledTaskTable.directory, directory),
            ),
          )
          .all().length,
        workspaces: d
          .select({ id: WorkspaceTable.id })
          .from(WorkspaceTable)
          .where(
            and(
              or(eq(WorkspaceTable.project_id, ProjectID.global), isNull(WorkspaceTable.location_id)),
              directorySqlEq(WorkspaceTable.directory, directory),
            ),
          )
          .all().length,
      }))

    const claimLegacy = Effect.fn("Project.claimLegacy")(function* () {
      const directories = yield* db((d) => {
        const result = new Set<string>()
        for (const row of d
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(or(eq(SessionTable.project_id, ProjectID.global), isNull(SessionTable.location_id)))
          .all())
          result.add(row.directory)
        for (const row of d
          .select({ directory: ScheduledTaskTable.directory })
          .from(ScheduledTaskTable)
          .where(or(eq(ScheduledTaskTable.project_id, ProjectID.global), isNull(ScheduledTaskTable.location_id)))
          .all())
          result.add(row.directory)
        for (const row of d
          .select({ directory: WorkspaceTable.directory })
          .from(WorkspaceTable)
          .where(or(eq(WorkspaceTable.project_id, ProjectID.global), isNull(WorkspaceTable.location_id)))
          .all())
          if (row.directory) result.add(row.directory)
        return [...result]
      })
      const totals: LegacyClaimCounts = { sessions: 0, scheduledTasks: 0, workspaces: 0 }
      log.info("project legacy claim started", { directories: directories.length })
      for (const directory of directories) {
        const exists = yield* fs.isDir(directory).pipe(Effect.catch(() => Effect.succeed(false)))
        if (!exists) {
          log.warn("project legacy claim skipped", { directory, reason: "directory-unavailable" })
          continue
        }
        const before = yield* countLegacyDirectory(directory)
        yield* fromDirectory(directory)
        const after = yield* countLegacyDirectory(directory)
        totals.sessions += Math.max(0, before.sessions - after.sessions)
        totals.scheduledTasks += Math.max(0, before.scheduledTasks - after.scheduledTasks)
        totals.workspaces += Math.max(0, before.workspaces - after.workspaces)
      }
      log.info("project legacy claim completed", totals)
      const ownership = yield* Effect.sync(() => ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration())
      log.info("project ownership startup migration completed", ownership)
      return totals
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const base64 = Buffer.from(buffer).toString("base64")
      const mime = AppFileSystem.mimeType(shortest)
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } }).pipe(
        Effect.catchTag("Project.NotFoundError", () => Effect.void),
      )
    })

    // Projects whose worktree no longer exists on disk must not appear in the project
    // list: clients bootstrap/dispose per listed directory, and a deleted worktree
    // (e.g. a merged branch cleaned up) would keep getting instance requests. Checks
    // are cached with a short TTL and purely in memory — the DB row is kept so session
    // history survives and the project re-registers itself if the directory returns.
    // Network/cloud mounts are exempt: an offline mount must never prune its projects.
    const missingWorktree = new Map<string, { at: number; missing: boolean }>()
    const MISSING_WORKTREE_TTL_MS = 30_000
    const NETWORK_MOUNT_MARKERS = [
      "/Volumes/",
      "/mnt/",
      "/media/",
      "CloudStorage",
      "Dropbox",
      "Nutstore Files",
      "OneDrive",
      "Google Drive",
    ]
    const isNetworkMount = (directory: string) =>
      NETWORK_MOUNT_MARKERS.some((marker) => directory.includes(marker))

    const worktreeMissing = Effect.fn("Project.worktreeMissing")(function* (directory: string) {
      const cached = missingWorktree.get(directory)
      if (cached && Date.now() - cached.at < MISSING_WORKTREE_TTL_MS) return cached.missing
      const missing = !(yield* fs.existsSafe(directory))
      missingWorktree.set(directory, { at: Date.now(), missing })
      return missing
    })

    const list = Effect.fn("Project.list")(function* () {
      const rows = yield* db((d) => d.select().from(ProjectTable).all().map(fromRow))
      const checked = yield* Effect.forEach(
        rows,
        (info) =>
          Effect.gen(function* () {
            if (isNetworkMount(info.worktree)) return info
            if (yield* worktreeMissing(info.worktree)) {
              log.debug("hiding project with missing worktree", { projectID: info.id, worktree: info.worktree })
              return undefined
            }
            return info
          }).pipe(Effect.catch(() => Effect.succeed(info))),
        { concurrency: "unbounded" },
      )
      return checked.filter((info) => info !== undefined)
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectID) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_url_override: input.icon?.override,
            icon_color: input.icon?.color,
            commands: input.commands,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, input.projectID))
          .returning()
          .get(),
      )
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
      if (input.project.vcs === "git") return input.project
      if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
      const result = yield* git(["init", "--quiet"], { cwd: input.directory })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
      }
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectID) {
      yield* db((d) =>
        d.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
      )
    })

    const initState = yield* InstanceState.make(
      Effect.fn("Project.initState")(function* (ctx) {
        yield* (yield* bus.subscribe(Command.Event.Executed)).pipe(
          Stream.runForEach((payload) =>
            payload.properties.name === Command.Default.INIT ? setInitialized(ctx.project.id) : Effect.void,
          ),
          Effect.forkScoped,
        )
      }),
    )

    const init = Effect.fn("Project.init")(function* () {
      yield* InstanceState.get(initState)
    })

    const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectID) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) return []
      const data = fromRow(row)
      return yield* Effect.forEach(
        data.sandboxes,
        (dir) =>
          fs.isDir(dir).pipe(
            Effect.orDie,
            Effect.map((ok) => (ok ? dir : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
    })

    const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectID, directory: string) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) throw new Error(`Project not found: ${id}`)
      const sboxes = [...row.sandboxes]
      if (!sboxes.includes(directory)) sboxes.push(directory)
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
      const exists = yield* fs.isDir(directory).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!exists) {
        log.info("project sandbox location deferred", {
          projectID: id,
          directory,
          reason: "directory-unavailable",
        })
        return
      }
      const resolved = yield* fromDirectory(directory)
      if (resolved.project.id !== id) {
        log.warn("project sandbox location mismatch", {
          expectedProjectID: id,
          resolvedProjectID: resolved.project.id,
          directory,
          locationID: resolved.location.id,
        })
      }
    })

    const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectID, directory: string) {
      const row = yield* db((d) => d.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
      if (!row) throw new Error(`Project not found: ${id}`)
      const sboxes = row.sandboxes.filter((s) => s !== directory)
      const result = yield* db((d) =>
        d
          .update(ProjectTable)
          .set({ sandboxes: sboxes, time_updated: Date.now() })
          .where(eq(ProjectTable.id, id))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* Effect.sync(() =>
        ProjectLocation.markUnavailableByDirectory({
          projectID: id,
          directory: toLogicalPath(AppFileSystem.resolve(directory)),
        }),
      )
      yield* emitUpdated(fromRow(result))
    })

    return Service.of({
      init,
      fromDirectory,
      claimLegacy,
      discover,
      list,
      get,
      update,
      initGit,
      setInitialized,
      sandboxes,
      addSandbox,
      removeSandbox,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const use = serviceUse(Service)

export function list() {
  return Database.use((db) =>
    db
      .select()
      .from(ProjectTable)
      .all()
      .map((row) => fromRow(row)),
  )
}

export function get(id: ProjectID): Info | undefined {
  const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get())
  if (!row) return undefined
  return fromRow(row)
}

export function setInitialized(id: ProjectID) {
  Database.use((db) =>
    db.update(ProjectTable).set({ time_initialized: Date.now() }).where(eq(ProjectTable.id, id)).run(),
  )
}

export * as Project from "./project"
